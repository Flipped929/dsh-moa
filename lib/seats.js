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
  /** key = `${role}:${provider}/${model}` → { childId, seat } */
  const pool = new Map();

  function keyOf(seat) {
    return `${seat.name ?? seat.role}:${seat.provider}/${seat.model}`;
  }

  /** 扫描父会话的直接子代理，按标签重建池（插件重挂载/DSH 重启后的续接）。 */
  async function reattach(parentAgent) {
    const subagents = ctx.get?.('subagents');
    if (!subagents?.listChildren) return 0;
    try {
      const children = await subagents.listChildren(parentAgent.session.header.id);
      let n = 0;
      for (const c of children) {
        const label = c.label ?? '';
        if (!label.startsWith(SEAT_LABEL_PREFIX)) continue;
        const key = label.slice(SEAT_LABEL_PREFIX.length);
        if (!pool.has(key)) {
          pool.set(key, { childId: c.childId ?? c.id, seat: null, reattached: true });
          n++;
        }
      }
      return n;
    } catch {
      return 0;
    }
  }

  async function ensureSeat(parentAgent, seat, signal) {
    const subagents = ctx.get?.('subagents');
    if (!subagents?.startContinuable) throw new Error('subagents service unavailable');
    const key = keyOf(seat);
    const existing = pool.get(key);
    if (existing?.childId) return existing;
    const parentDepth = parentAgent.session?.header?.delegationDepth ?? 0;
    const start = await subagents.startContinuable({
      provider: 'spawn',
      label: `${SEAT_LABEL_PREFIX}${key}`,
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
    const entry = { childId: start.childId, seat };
    pool.set(key, entry);
    return entry;
  }

  function waitIdle(childId, signal, capMs) {
    const agents = ctx.get?.('agents');
    const deadline = Date.now() + capMs;
    return new Promise((resolveWait) => {
      const tick = () => {
        if (signal?.aborted) return resolveWait('aborted');
        if (Date.now() > deadline) return resolveWait('timeout');
        const status = agents?.get?.(childId)?.status;
        if (status === 'idle' || status === undefined) return resolveWait(status === 'idle' ? 'idle' : 'unknown');
        setTimeout(tick, 1500);
      };
      tick();
    });
  }

  /** 给席位派一个任务并等待完成：followup → 轮询 idle → 读结果卡。 */
  async function taskSeat(parentAgent, entry, packet, cardPath, signal, capMs = 240000) {
    const subagents = ctx.get?.('subagents');
    await subagents.followup(parentAgent, entry.childId, [{ type: 'text', text: packet }], {
      signal,
      source: { kind: 'plugin', plugin: 'dsh-moa' },
    });
    const settle = await waitIdle(entry.childId, signal, capMs);
    const card = existsSync(cardPath) ? readFileSync(cardPath, 'utf8') : null;
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
