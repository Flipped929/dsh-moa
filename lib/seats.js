
/**
 * 常驻席位进程池（durable seat pool）。
 *
 * 设计依据（用户裁定 2026-08-27）：
 * - 席位 = durable continuable 子代理：同一席位跨任务保留进程与上下文，
 *   连续任务在同一会话里接续（子模型思考能力不浪费）；冷恢复使席位跨 DSH 重启存续。
 * - 席位不可再派子代理：toolFilter 剥夺委派类工具（双保险：maxDepth=父深度+1）。
 * - 结果回流走「黑板」：席位把结果卡写到指定路径，主模型/插件读卡（对齐 .pi/moa 惯例）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';

const SEAT_LABEL_PREFIX = 'moa-seat:';

/** DSH 宿主派活通道（三代契约，按版本各只存在一个）：
 *  ≤0.1.2-alpha.3：公开方法 followup(parent, childId, content, {signal, source})
 *  0.1.2-alpha.4：内部符号 Symbol.for('dsh.subagent.queuePrompt')(parent, childId, content, source, signal)
 *  ≥0.1.3-alpha.1：符号改名 Symbol.for('dsh.subagent.deliverPrompt')，第 6 参 delivery:'queue'|'steer'
 *    （git show dsh-v0.1.3-alpha.1 实证：internal.ts:41 符号定义 + index.ts:268 六参签名）
 */
const QUEUE_PROMPT_V4 = Symbol.for('dsh.subagent.queuePrompt');
const DELIVER_PROMPT_V5 = Symbol.for('dsh.subagent.deliverPrompt');

/** 跨 DSH 版本给席位派任务：按代际顺序探测，任一版本只有一个通道存在。 */
export async function deliverSeatPrompt(subagents, parentAgent, childId, packet, signal) {
  const content = [{ type: 'text', text: packet }];
  const source = { kind: 'plugin', plugin: 'dsh-moa' };
  if (typeof subagents?.followup === 'function') {
    return subagents.followup(parentAgent, childId, content, { signal, source });
  }
  const deliver = subagents?.[DELIVER_PROMPT_V5];
  if (typeof deliver === 'function') {
    return deliver.call(subagents, parentAgent, childId, content, source, signal, 'queue');
  }
  const queue = subagents?.[QUEUE_PROMPT_V4];
  if (typeof queue === 'function') {
    return queue.call(subagents, parentAgent, childId, content, source, signal);
  }
  throw new Error('subagents 契约不可用：无 followup（≤alpha.3）/ queuePrompt（alpha.4）/ deliverPrompt（≥0.1.3）');
}

export function createSeatPool(ctx) {
  /** key = `${parentSessionId}:${role}:${provider}/${model}` → { childId, seat } */
  const pool = new Map();
  const pending = new Map();

  function keyOf(seat, parentSessionId) {
    const role = seat.role ?? seat.name;
    return `${parentSessionId}:${role}:${seat.provider}/${seat.model}`;
  }

  function warnReattachError(error) {
    const detail = String(error?.message ?? error);
    const unavailable = error?.code === 'SUBAGENTS_UNAVAILABLE'
      || /service unavailable|not available|not mounted|not registered|unsupported/i.test(detail);
    console.warn(`[dsh-moa] 席位重接失败（${unavailable ? '服务不可用' : '暂时失败'}）: ${detail}`);
  }

  async function interruptAndDrop(parentAgent, entry) {
    const subagents = ctx.get?.('subagents');
    if (typeof subagents?.interrupt === 'function') {
      try {
        // 两参签名（alpha.3 起）：authority 传父 agent 直系凭证（ancestor）
        await subagents.interrupt(entry.childId, { kind: 'ancestor', agent: parentAgent });
      } catch (error) {
        console.warn(`[dsh-moa] interrupt 席位失败: ${String(error?.message ?? error)}`);
      }
    }
    const key = entry.key ?? keyOf(entry.seat, parentAgent.session?.header?.id);
    if (pool.get(key) === entry) pool.delete(key);
  }

  /** 扫描当前父会话的直接子代理，按父会话命名空间重建池。 */
  async function reattach(parentAgent) {
    const parentSessionId = String(parentAgent.session?.header?.id ?? '');
    const subagents = ctx.get?.('subagents');
    if (!subagents?.listChildren) {
      console.warn('[dsh-moa] 席位重接失败（服务不可用）: subagents.listChildren 未挂载');
      return 0;
    }
    try {
      const children = await subagents.listChildren(parentAgent.session.header.id);
      const labelPrefix = `${SEAT_LABEL_PREFIX}${parentSessionId.slice(0, 8)}:`;
      let n = 0;
      for (const c of children) {
        const label = c.label ?? '';
        if (!label.startsWith(labelPrefix)) continue;
        const key = label.slice(labelPrefix.length);
        if (!key.startsWith(`${parentSessionId}:`)) continue;
        if (pool.has(key) || pending.has(key)) continue;
        const childId = c.childId ?? c.id;
        if (!childId) continue;
        pool.set(key, { childId, seat: null, key, reattached: true });
        n++;
      }
      return n;
    } catch (error) {
      warnReattachError(error);
      return 0;
    }
  }

  async function ensureSeat(parentAgent, seat, signal, firstPacket) {
    const subagents = ctx.get?.('subagents');
    if (!subagents?.startContinuable) throw new Error('subagents service unavailable');
    const parentSessionId = String(parentAgent.session?.header?.id ?? '');
    const key = keyOf(seat, parentSessionId);
    const existing = pool.get(key);
    if (existing?.childId) {
      existing.seat = seat;
      return { ...existing, fresh: false };
    }
    const inFlight = pending.get(key);
    if (inFlight) return inFlight;

    const startPromise = (async () => {
      const parentDepth = parentAgent.session?.header?.delegationDepth ?? 0;
      const start = await subagents.startContinuable({
        provider: 'spawn',
        label: `${SEAT_LABEL_PREFIX}${parentSessionId.slice(0, 8)}:${key}`,
        request: {
          parent: parentAgent,
          // boot 协议与首个任务合并为同一条初始 prompt：首个回合即任务回合，
          // 消灭「boot 回合结束间隙 idle 被误判为任务完成」的两回合竞态
          prompt: [{ type: 'text', text: firstPacket ? `${seat.bootPrompt}\n\n${firstPacket}` : seat.bootPrompt }],
          agentOptions: {
            provider: seat.provider,
            model: seat.model,
            ...(seat.maxTokens ? { maxTokens: seat.maxTokens } : {}),
            // DSH ≥0.1.2-alpha.1：AgentOptions 支持 reasoningEffort（每席位思考档位自定义）
            ...(seat.reasoningEffort ? { reasoningEffort: seat.reasoningEffort } : {}),
          },
          toolFilter: seat.toolFilter,
          maxDepth: parentDepth + 1,
        },
        signal,
      });
      const entry = { childId: start.childId, seat, key, fresh: true };
      pool.set(key, entry);
      return entry;
    })();
    pending.set(key, startPromise);
    try {
      return await startPromise;
    } finally {
      if (pending.get(key) === startPromise) pending.delete(key);
    }
  }

  function waitIdle(childId, signal, capMs) {
    const agents = ctx.get?.('agents');
    const startedAt = Date.now();
    const deadline = startedAt + capMs;
    const runningDeadline = Math.min(deadline, startedAt + 10000);
    return new Promise((resolveWait) => {
      let timer;
      let runningGateComplete = false;
      const finish = (value) => {
        clearTimeout(timer);
        resolveWait(value);
      };
      const tick = () => {
        if (signal?.aborted) return finish('aborted');
        let status;
        try {
          status = agents?.get?.(childId)?.status;
        } catch {
          status = undefined;
        }
        if (status === 'running') runningGateComplete = true;
        // 先跳过 followup 前遗留的 idle/undefined，再接受 idle 作为完成。
        if (!runningGateComplete && Date.now() >= runningDeadline) runningGateComplete = true;
        if (runningGateComplete && status === 'idle') return finish('idle');
        if (Date.now() >= deadline) return finish('timeout');
        timer = setTimeout(tick, 1500);
      };
      tick();
    });
  }

  /** 给席位派一个任务并等待完成：派活（followup/queuePrompt 跨版本兼容）→ 卡驱动完成。 */
  async function taskSeat(parentAgent, entry, packet, cardPath, signal, capMs = 600000, opts = {}) {
    const subagents = ctx.get?.('subagents');
    if (!opts.alreadyDelivered) {
      try {
        await deliverSeatPrompt(subagents, parentAgent, entry.childId, packet, signal);
      } catch (error) {
        if (signal?.aborted) await interruptAndDrop(parentAgent, entry);
        throw error;
      }
    }
    // 卡驱动完成：结果卡落盘是唯一完成信号（idle 仅是辅助），
    // 避免 boot/任务回合间隙 idle 或写卡耗时的误判；超时才 interrupt。
    let card = existsSync(cardPath) ? readFileSync(cardPath, 'utf8') : null;
    const deadline = Date.now() + capMs;
    while (!card && Date.now() < deadline) {
      if (signal?.aborted) {
        await interruptAndDrop(parentAgent, entry);
        return { settle: 'aborted', card: null };
      }
      await new Promise((r) => setTimeout(r, 2000));
      card = existsSync(cardPath) ? readFileSync(cardPath, 'utf8') : null;
    }
    if (!card) {
      await interruptAndDrop(parentAgent, entry);
      return { settle: 'timeout', card: null };
    }
    return { settle: 'idle', card };
  }


  /** codex CLI 席位：用 codex 自己的会话存储做连续性（--json 捕获 thread_id，resume <id> 续接）。 */
  async function taskCodexCli(parentAgent, entry, packet, signal, capMs = 600000) {
    // 席位可指定 codex 端型号（如 glm-5.3 / glm-5.3-flash）；'codex' 占位值不传
    const seatModel = entry.seat?.model;
    const modelArgs = seatModel && seatModel !== 'codex' ? ['-m', seatModel] : [];
    const argv = entry.threadId
      ? ['exec', 'resume', entry.threadId, ...modelArgs, '--json', packet]
      : ['exec', ...modelArgs, '--json', packet];
    const stdout = await new Promise((resolveRun, rejectRun) => {
      const child = execFile('codex', argv, {
        timeout: capMs,
        maxBuffer: 64 * 1024 * 1024,
        signal,
      }, (error, out) => (error ? rejectRun(error) : resolveRun(out)));
      child.stdin?.end?.();
    });
    let threadId = entry.threadId ?? null;
    let text = '';
    for (const line of String(stdout).split('\n')) {
      const t = line.trim();
      if (!t.startsWith('{')) continue;
      try {
        const e = JSON.parse(t);
        if (e.type === 'thread.started' && e.thread_id) threadId = e.thread_id;
        if (e.type === 'agent_message' && typeof e.message === 'string') text += e.message;
      } catch { /* 非 JSON 行（banner/warn）忽略 */ }
    }
    if (threadId) entry.threadId = threadId;
    return { text: text.trim(), threadId };
  }

  /** codex CLI 席位入池：线程连续性经 thread_id resume 保存于 entry。 */
  function ensureCliSeat(parentAgent, seat) {
    const key = keyOf(seat, String(parentAgent.session?.header?.id ?? ''));
    const existing = pool.get(key);
    if (existing) return existing;
    const entry = { key, kind: 'codex-cli', seat, threadId: null };
    pool.set(key, entry);
    return entry;
  }

  return {
    ensureSeat,
    taskSeat,
    taskCodexCli,
    ensureCliSeat,
    reattach,
    list: () => [...pool.entries()].map(([key, e]) => ({ key, childId: e.childId, reattached: Boolean(e.reattached) })),
    drop: (key) => pool.delete(key),
    clear: () => pool.clear(),
    keyOf,
  };
}

