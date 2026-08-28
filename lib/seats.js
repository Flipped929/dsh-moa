
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

const SEAT_LABEL_PREFIX = 'moa-seat:';

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
        await subagents.interrupt(entry.childId);
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

  async function ensureSeat(parentAgent, seat, signal) {
    const subagents = ctx.get?.('subagents');
    if (!subagents?.startContinuable) throw new Error('subagents service unavailable');
    const parentSessionId = String(parentAgent.session?.header?.id ?? '');
    const key = keyOf(seat, parentSessionId);
    const existing = pool.get(key);
    if (existing?.childId) {
      existing.seat = seat;
      return existing;
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
          prompt: [{ type: 'text', text: seat.bootPrompt }],
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
      const entry = { childId: start.childId, seat, key };
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

  /** 给席位派一个任务并等待完成：followup → running gate → idle → 读结果卡。 */
  async function taskSeat(parentAgent, entry, packet, cardPath, signal, capMs = 600000) {
    const subagents = ctx.get?.('subagents');
    try {
      await subagents.followup(parentAgent, entry.childId, [{ type: 'text', text: packet }], {
        signal,
        source: { kind: 'plugin', plugin: 'dsh-moa' },
      });
    } catch (error) {
      if (signal?.aborted) await interruptAndDrop(parentAgent, entry);
      throw error;
    }
    const settle = await waitIdle(entry.childId, signal, capMs);
    if (settle === 'timeout' || settle === 'aborted') {
      await interruptAndDrop(parentAgent, entry);
    }
    // 卡驱动完成：idle 后结果卡可能迟交（席位总结回合仍在写卡），宽限 30s 轮询卡片落盘
    let card = existsSync(cardPath) ? readFileSync(cardPath, 'utf8') : null;
    if (!card && settle === 'idle') {
      const cardDeadline = Date.now() + 30000;
      while (!card && Date.now() < cardDeadline && !signal?.aborted) {
        await new Promise((r) => setTimeout(r, 2000));
        card = existsSync(cardPath) ? readFileSync(cardPath, 'utf8') : null;
      }
    }
    return { settle, card };
  }

  return {
    ensureSeat,
    taskSeat,
    reattach,
    list: () => [...pool.entries()].map(([key, e]) => ({ key, childId: e.childId, reattached: Boolean(e.reattached) })),
    drop: (key) => pool.delete(key),
    clear: () => pool.clear(),
    keyOf,
  };
}

