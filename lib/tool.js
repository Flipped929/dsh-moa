/**
 * moa 工具：评审融合（常驻席位模式为默认，--fast 走 llm.stream 单发通道）。
 *
 * 用户裁定（2026-08-27）：
 * - 席位不固定模型：主模型按任务设计/拆分自由指派（seats 参数优先，roster 默认兜底）；
 * - 独立意见 ≤500 字；确需更多篇幅，席位在结果卡末尾写【申请扩写：理由】，主模型定夺；
 * - 主/子模型都可派出 agent，子模型不可再调用子模型（toolFilter + maxDepth 双保险）；
 * - 进程与上下文保留：常驻席位跨任务接续，冷恢复跨重启；
 * - 思考能力按席位配置（reasoningEffort：llm.stream 通道生效；子代理通道记为配置+提示词）。
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { readFileSync, existsSync, mkdirSync, realpathSync, writeFileSync, statSync } from 'node:fs';
import { resolve, relative, sep, isAbsolute, join } from 'node:path';
import { runAdvisors, buildAdvisorPrompt } from './advisor.js';
import { redactText, truncateMiddle } from './redact.js';
import { assignSeats, isImagePath, isPeakHour } from './scheduler.js';

const MODES = {
  review: ['analyst', 'critic', 'devil'],
  research: ['analyst'],
  write: ['analyst', 'critic'],
};

const DELEGATION_DENY = ['subagent', 'subagent_fork', 'subagent_pro', 'subagent_k3', 'subagent_codex', 'subagent_claude_code', 'workflow', 'ralph', 'moa'];

export function safeRead(workspaceRoot, relPath, maxChars) {
  let target;
  let realRoot;
  try {
    target = realpathSync(resolve(workspaceRoot, relPath));
    realRoot = realpathSync(workspaceRoot);
  } catch {
    return { path: relPath, error: 'not-found' };
  }
  const rel = relative(realRoot, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return { path: relPath, error: 'outside-workspace' };
  if (isImagePath(relPath)) return { path: relPath, image: true, content: null };
  return { path: relPath, content: truncateMiddle(readFileSync(target, 'utf8'), maxChars) };
}

function buildBootPrompt(seat, wordCap) {
  const prompt = [
    seat.systemPrompt ?? `你是 MoA 的 ${seat.name} 席。`,
    '',
    '【席位协议】',
    `1. 你是常驻席位：本进程跨任务存续，后续任务会带着你之前的上下文接续。`,
    `2. 每次任务把结果卡写到任务卡指定的路径（frontmatter: actor/task_id/model + status/summary/findings/concerns），那是你的唯一写产物。`,
    `3. 独立意见正文 ≤${wordCap} 字；确需更多篇幅，先交 ${wordCap} 字版并在结果卡末尾写【申请扩写：理由】，由主模型定夺。`,
    '4. 你不能委派/再派任何子代理；需要协作时在结果卡 concerns 里写明，由主模型转发。',
    '5. 完成任务后用一句话（≤50 字）总结回复。',
  ].join('\n');
  return redactText(prompt);
}

function buildTaskPacket({ task, focus, files, cardPath, wordCap, allowLong }) {
  const sections = [
    '## 任务卡',
    `goal: ${task}`,
    focus ? `focus: ${focus}` : null,
    '',
    '## 输出协议',
    `1. 结果卡写到：${cardPath}`,
    `2. 意见正文 ≤${allowLong ? 2000 : wordCap} 字${allowLong ? '（本席已获扩写权限）' : ''}`,
    '3. 完成后一句话总结回复',
  ].filter(Boolean);
  for (const f of files ?? []) {
    if (f.image) sections.push(`\n## 材料 ${f.path}\n（图片文件：请自行用 read_image 查看 ${f.path} 后评审）`);
    else sections.push(`\n## 材料 ${f.path}\n${f.content}`);
  }
  return redactText(sections.join('\n'));
}

function assertSeatSlug(name) {
  if (!/^[a-z0-9_-]+$/.test(name)) throw new Error(`moa: 席位名称 ${name} 只允许小写字母、数字、下划线和连字符`);
}

function resolveWorkspaceRoot(ctx, agent) {
  return ctx.get?.('sandboxPolicy')?.resolve?.({ session: agent.session })?.workspaceRoot
    ?? ctx.get?.('sandboxPolicy')?.workspaceRoot
    ?? process.cwd();
}

export function createMoaTool(ctx, resolved, roster, state, seatPool) {
  return defineTool({
    name: 'moa',
    description: 'Mixture-of-Agents 评审融合：只需给任务，插件按模型特性×任务类型×成本自动分派席位（V4-Pro/V4-flash-vision-exp/kimi-k3 三档矩阵，devil 恒跨家族），主模型（当前会话模型）聚合裁决。席位默认常驻进程（跨任务保留上下文），fast=true 走单发省费通道。要自定义再用 seats/roles 参数；stakes=high 时 critic 自动升 v4-pro。成本提示：每席位是完整 agent 轮次；单文件或 <10 分钟小任务请主模型直接做。',
    parameters: {
      task: { type: 'string', required: true, description: '任务描述（主模型应先做好任务设计/拆分再派发）' },
      mode: { type: 'string', description: 'review(默认三席对抗) | research(调研) | write(写作)' },
      seats: { type: 'array', items: { type: 'object', additionalProperties: true }, description: '按任务指派席位：[{role, provider?, model?, focus?}]；provider/model 缺省用角色文件默认' },
      roles: { type: 'array', items: { type: 'string' }, description: '简化形式：只点名角色名，模型取角色文件默认' },
      context_files: { type: 'array', items: { type: 'string' }, description: '工作区内材料文件相对路径（白名单读取并入任务卡）' },
      stakes: { type: 'string', description: "high=关键产出/高 stakes（critic 席自动升 v4-pro）" },
      fast: { type: 'boolean', description: 'true=无状态 llm.stream 单发通道（省费快）；缺省 false=常驻席位进程' },
      allowLong: { type: 'boolean', description: '批准席位扩写（≤2000 字），用于批准【申请扩写】后的续跑' },
      writeResultCard: { type: 'boolean', description: 'fast 通道下由插件代写结果卡（常驻模式席位自写）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: value?.summary ?? 'moa run finished' }],
    },
    timeoutMs: 300000,
    async execute(args, exec) {
      const parent = exec.agent;
      const mode = MODES[args.mode] ? args.mode : 'review';
      const wsRoot = resolveWorkspaceRoot(ctx, parent);
      const wordCap = resolved.opinionWordCap ?? 500;

      // ── 席位解析：seats 参数 > roles 参数 > mode 默认阵容；模型缺省取角色文件 ──
      const filesPre = (args.context_files ?? []);
      const needVision = filesPre.some(isImagePath);
      const realRoot = (() => { try { return realpathSync(wsRoot); } catch { return wsRoot; } })();
      const bigContextChars = filesPre.reduce((n, p) => {
        try {
          const target = realpathSync(resolve(wsRoot, p));
          const rel = relative(realRoot, target);
          if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return n;
          return n + statSync(target).size;
        } catch { return n; }
      }, 0);
      const seatSpecs = (Array.isArray(args.seats) && args.seats.length ? args.seats : null)
        ?? (Array.isArray(args.roles) && args.roles.length ? args.roles.map((r) => ({ role: r })) : null)
        ?? assignSeats({ mode, stakes: args.stakes, needVision, bigContextChars }, resolved, roster);
      const seats = seatSpecs.map((spec) => {
        assertSeatSlug(spec.role);
        const base = roster.get(spec.role) ?? {};
        return {
          name: spec.role,
          provider: spec.provider ?? base.provider,
          model: spec.model ?? base.model,
          maxTokens: spec.maxTokens ?? base.maxTokens,
          temperature: spec.temperature ?? base.temperature,
          systemPrompt: base.systemPrompt,
          reasoningEffort: spec.reasoningEffort ?? base.reasoningEffort,
          focus: spec.focus,
        };
      });
      for (const s of seats) {
        if (!s.provider || !s.model) throw new Error(`moa: 席位 ${s.name} 缺 provider/model（roster 与 seats 参数均未给）`);
      }

      const files = (args.context_files ?? []).map((p) => safeRead(wsRoot, p, resolved.maxToolResultChars ?? 6000));
      const taskId = `moa-${Date.now()}`;

      // ── fast 通道：无状态 llm.stream 单发（v0.1 路径）──
      if (args.fast) {
        if (files.some((f) => f.image)) throw new Error('moa: fast 通道不支持图片材料，请用常驻席位（视觉席会自行 read_image）');
        const prompt = buildAdvisorPrompt({ task: args.task, files: files.filter((f) => f.content), maxChars: resolved.maxAdvisorContextChars });
        const results = await runAdvisors(ctx, seats, {
          prompt: redactText(prompt),
          maxTokens: resolved.referenceMaxTokens,
          temperature: resolved.referenceTemperature,
          signal: exec.signal,
        });
        const cards = results.map((r) => ({
          role: r.seat.name, provider: r.seat.provider, model: r.seat.model,
          ok: r.ok, errorKind: r.errorKind ?? null, text: r.text, usage: r.usage ?? null,
        }));
        if (args.writeResultCard) {
          const dir = resolve(wsRoot, resolved.resultCardDir, taskId, 'results');
          const relDir = relative(wsRoot, dir);
          if (relDir.startsWith('..') || isAbsolute(relDir)) throw new Error('resultCardDir escapes workspace');
          mkdirSync(dir, { recursive: true });
          for (const c of cards) {
            const p = join(dir, `${c.role}.md`);
            if (!existsSync(p)) writeFileSync(p, `---\nactor: ${c.role}\ntask_id: ${taskId}\nmodel: ${c.provider}/${c.model}\n---\n\nstatus: ${c.ok ? 'done' : 'failed'}\n\n${c.text}\n`);
          }
        }
        const okCount = cards.filter((c) => c.ok).length;
        return {
          status: okCount ? 'done' : 'failed', mode: `${mode}/fast`, taskId,
          summary: `moa/${mode}(fast): ${okCount}/${cards.length} 席完成 → 请主模型聚合裁决`,
          seats: cards,
          costNote: 'cost_estimate 一律为估算口径（价格表 v1.1 峰谷版）',
        };
      }

      // ── 常驻席位模式（默认）──
      const dir = resolve(wsRoot, resolved.resultCardDir, taskId, 'results');
      if (relative(wsRoot, dir).startsWith('..')) throw new Error('resultCardDir escapes workspace');
      mkdirSync(dir, { recursive: true });
      await seatPool.reattach(parent);
      const prepared = [];
      for (const s of seats) {
        const seat = {
          ...s,
          bootPrompt: buildBootPrompt(s, wordCap),
          toolFilter: { allow: ['read', 'grep', 'glob', 'read_image', 'moa_write_card'], deny: DELEGATION_DENY },
        };
        prepared.push({ seat: s, entry: await seatPool.ensureSeat(parent, seat, exec.signal) });
      }
      const outcomes = await Promise.all(prepared.map(({ seat, entry }) => {
        const cardPath = join(dir, `${seat.name}.md`);
        const packet = buildTaskPacket({ task: args.task, focus: seat.focus, files: files.filter((f) => f.content), cardPath, wordCap, allowLong: Boolean(args.allowLong) });
        return seatPool.taskSeat(parent, entry, packet, cardPath, exec.signal).then((r) => ({ seat, cardPath, ...r }));
      }));
      const cards = outcomes.map((o) => ({
        role: o.seat.name, provider: o.seat.provider, model: o.seat.model,
        settle: o.settle, ok: Boolean(o.card), cardPath: o.cardPath,
        needsExpansion: Boolean(o.card && o.card.includes('【申请扩写')),
        preview: o.card ? redactText(o.card).slice(0, 400) : null,
      }));
      const okCount = cards.filter((c) => c.ok).length;
      const expansion = cards.filter((c) => c.needsExpansion).map((c) => c.role);
      const peakNote = isPeakHour() ? '当前高峰时段（工作日 9-12/14-18 点），v4-pro 输出 27 元/M；非紧急大批量评审建议排低谷/周末' : null;
      return {
        status: okCount ? 'done' : 'failed', mode: `${mode}/durable`, taskId,
        scheduled: cards.map((c) => `${c.role}=${c.provider}/${c.model}`),
        peakNote,
        summary: `moa/${mode}: ${okCount}/${cards.length} 席完成并交卡（${dir}）→ 请主模型读卡聚合裁决${expansion.length ? `；席位 ${expansion.join('/')} 申请扩写，如批准请用 allowLong 续跑` : ''}`,
        seats: cards,
        scheduling: (args.seats?.length || args.roles?.length) ? 'explicit' : 'auto-matrix',
        resultDir: dir,
        seatPool: seatPool.list().map((s) => s.key),
        costNote: '常驻席位为完整 agent 轮次；tokens 用量见各子会话，cost_estimate 一律为估算口径',
      };
    },
  });
}
