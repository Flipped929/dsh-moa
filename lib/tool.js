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
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, relative, sep, isAbsolute, join } from 'node:path';
import { runAdvisors, buildAdvisorPrompt } from './advisor.js';
import { redactText, truncateMiddle } from './redact.js';

const MODES = {
  review: ['analyst', 'critic', 'devil'],
  research: ['analyst'],
  write: ['analyst', 'critic'],
};

const DELEGATION_DENY = ['subagent', 'subagent_fork', 'subagent_pro', 'subagent_k3', 'subagent_codex', 'subagent_claude_code', 'workflow', 'ralph', 'moa'];

function safeRead(workspaceRoot, relPath, maxChars) {
  const target = resolve(workspaceRoot, relPath);
  const rel = relative(workspaceRoot, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return { path: relPath, error: 'outside-workspace' };
  if (!existsSync(target)) return { path: relPath, error: 'not-found' };
  return { path: relPath, content: truncateMiddle(readFileSync(target, 'utf8'), maxChars) };
}

function buildBootPrompt(seat, wordCap) {
  return [
    seat.systemPrompt ?? `你是 MoA 的 ${seat.name} 席。`,
    '',
    '【席位协议】',
    `1. 你是常驻席位：本进程跨任务存续，后续任务会带着你之前的上下文接续。`,
    `2. 每次任务把结果卡写到任务卡指定的路径（frontmatter: actor/task_id/model + status/summary/findings/concerns），那是你的唯一写产物。`,
    `3. 独立意见正文 ≤${wordCap} 字；确需更多篇幅，先交 ${wordCap} 字版并在结果卡末尾写【申请扩写：理由】，由主模型定夺。`,
    '4. 你不能委派/再派任何子代理；需要协作时在结果卡 concerns 里写明，由主模型转发。',
    '5. 完成任务后用一句话（≤50 字）总结回复。',
  ].join('\n');
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
  for (const f of files ?? []) sections.push(`\n## 材料 ${f.path}\n${f.content}`);
  return sections.join('\n');
}

export function createMoaTool(ctx, resolved, roster, state, seatPool) {
  return defineTool({
    name: 'moa',
    description: 'Mixture-of-Agents 评审融合：主模型（当前会话模型）按任务设计/拆分指派席位（任何已注册模型），并行收集各席独立意见后聚合裁决。席位默认常驻进程（跨任务保留上下文），fast=true 时走单发省费通道。成本提示：每席位是完整 agent 轮次；单文件或 <10 分钟小任务请主模型直接做。',
    parameters: {
      task: { type: 'string', required: true, description: '任务描述（主模型应先做好任务设计/拆分再派发）' },
      mode: { type: 'string', description: 'review(默认三席对抗) | research(调研) | write(写作)' },
      seats: { type: 'array', items: { type: 'object', additionalProperties: true }, description: '按任务指派席位：[{role, provider?, model?, focus?}]；provider/model 缺省用角色文件默认' },
      roles: { type: 'array', items: { type: 'string' }, description: '简化形式：只点名角色名，模型取角色文件默认' },
      context_files: { type: 'array', items: { type: 'string' }, description: '工作区内材料文件相对路径（白名单读取并入任务卡）' },
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
      const wsRoot = ctx.get?.('sandboxPolicy')?.workspaceRoot ?? process.cwd();
      const wordCap = resolved.opinionWordCap ?? 500;

      // ── 席位解析：seats 参数 > roles 参数 > mode 默认阵容；模型缺省取角色文件 ──
      const seatSpecs = (Array.isArray(args.seats) && args.seats.length ? args.seats : null)
        ?? (Array.isArray(args.roles) && args.roles.length ? args.roles.map((r) => ({ role: r })) : null)
        ?? MODES[mode].map((r) => ({ role: r }));
      const seats = seatSpecs.map((spec) => {
        const base = roster.get(spec.role) ?? {};
        return {
          name: spec.role,
          provider: spec.provider ?? base.provider,
          model: spec.model ?? base.model,
          maxTokens: spec.maxTokens ?? base.maxTokens,
          temperature: spec.temperature ?? base.temperature,
          systemPrompt: spec.systemPrompt ?? base.systemPrompt,
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
          mkdirSync(dir, { recursive: true });
          const { writeFileSync } = await import('node:fs');
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
          toolFilter: { allow: s.tools ?? ['read', 'grep', 'glob', 'read_image', 'write'], deny: DELEGATION_DENY },
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
        preview: o.card ? o.card.slice(0, 400) : null,
      }));
      const okCount = cards.filter((c) => c.ok).length;
      const expansion = cards.filter((c) => c.needsExpansion).map((c) => c.role);
      return {
        status: okCount ? 'done' : 'failed', mode: `${mode}/durable`, taskId,
        summary: `moa/${mode}: ${okCount}/${cards.length} 席完成并交卡（${dir}）→ 请主模型读卡聚合裁决${expansion.length ? `；席位 ${expansion.join('/')} 申请扩写，如批准请用 allowLong 续跑` : ''}`,
        seats: cards,
        resultDir: dir,
        seatPool: seatPool.list().map((s) => s.key),
        costNote: '常驻席位为完整 agent 轮次；tokens 用量见各子会话，cost_estimate 一律为估算口径',
      };
    },
  });
}
