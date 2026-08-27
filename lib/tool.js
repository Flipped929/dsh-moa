/**
 * moa 工具：评审融合。并行调度 roster 席位出独立意见，主模型（会话当前模型）聚合裁决。
 * 主模型纯 GUI 选择，本插件从不钉定或切换它。
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, relative, sep, isAbsolute, join } from 'node:path';
import { runAdvisors, buildAdvisorPrompt } from './advisor.js';
import { redactText, truncateMiddle } from './redact.js';

const MODES = {
  review: ['analyst', 'critic', 'devil'],
  research: ['analyst'],
  write: ['analyst', 'critic'],
};

function safeRead(workspaceRoot, relPath, maxChars) {
  const target = resolve(workspaceRoot, relPath);
  const rel = relative(workspaceRoot, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return { path: relPath, error: 'outside-workspace' };
  if (!existsSync(target)) return { path: relPath, error: 'not-found' };
  return { path: relPath, content: truncateMiddle(readFileSync(target, 'utf8'), maxChars) };
}

export function createMoaTool(ctx, resolved, roster, state) {
  return defineTool({
    name: 'moa',
    description: 'Mixture-of-Agents 评审融合：并行调度多个子模型 advisor 对任务/材料出独立意见，主模型（当前会话模型）负责聚合裁决。席位来自 roster 角色文件（包内默认 + ~/.dsh/moa/roles/ 用户层，/moa roles 可查）。成本提示：每席位一次独立模型调用；单文件或 <10 分钟的小任务请主模型直接做，不要动用本工具。',
    parameters: {
      task: { type: 'string', required: true, description: '评审/调研/写作任务描述' },
      mode: { type: 'string', description: 'review(默认，三席对抗) | research(调研) | write(写作)' },
      roles: { type: 'array', items: { type: 'string' }, description: '指定席位角色名；缺省按 mode 阵容' },
      context_files: { type: 'array', items: { type: 'string' }, description: '工作区内材料文件相对路径（白名单读取并入 advisor 上下文）' },
      overrides: { type: 'array', items: { type: 'object', additionalProperties: true }, description: '单次覆盖：[{role, provider, model}]' },
      writeResultCard: { type: 'boolean', description: '把各席位结果卡写入 .pi/moa/<task-id>/results/' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: value?.summary ?? 'moa run finished' }],
    },
    async execute(args, exec) {
      const mode = MODES[args.mode] ? args.mode : 'review';
      const names = Array.isArray(args.roles) && args.roles.length ? args.roles : MODES[mode];
      const seats = roster.seatsFor(names).map((seat) => {
        const ov = (args.overrides ?? []).find((o) => o && o.role === seat.name);
        return ov ? { ...seat, provider: ov.provider ?? seat.provider, model: ov.model ?? seat.model } : seat;
      });
      if (!seats.length) throw new Error(`moa: no roster seats resolved for roles [${names.join(', ')}]`);
      const wsRoot = ctx.get?.('sandboxPolicy')?.workspaceRoot ?? process.cwd();
      const files = (args.context_files ?? []).map((p) => safeRead(wsRoot, p, resolved.maxToolResultChars ?? 6000));
      const prompt = buildAdvisorPrompt({ task: args.task, files: files.filter((f) => f.content), maxChars: resolved.maxAdvisorContextChars });
      const results = await runAdvisors(ctx, seats, {
        prompt: redactText(prompt),
        maxTokens: resolved.referenceMaxTokens,
        temperature: resolved.referenceTemperature,
        signal: exec.signal,
      });
      const tokensByModel = {};
      for (const r of results) {
        if (!r.usage) continue;
        const key = `${r.seat.provider}/${r.seat.model}`;
        const u = r.usage;
        tokensByModel[key] = tokensByModel[key] ?? { input: 0, output: 0 };
        tokensByModel[key].input += u.input ?? u.inputTokens ?? 0;
        tokensByModel[key].output += u.output ?? u.outputTokens ?? 0;
      }
      const taskId = `moa-${Date.now()}`;
      const cards = results.map((r) => ({
        role: r.seat.name, provider: r.seat.provider, model: r.seat.model,
        ok: r.ok, errorKind: r.errorKind ?? null, error: r.error ?? null, text: r.text,
      }));
      if (args.writeResultCard) {
        const dir = resolve(wsRoot, resolved.resultCardDir, taskId, 'results');
        if (relative(wsRoot, dir).startsWith('..')) throw new Error('resultCardDir escapes workspace');
        mkdirSync(dir, { recursive: true });
        for (const c of cards) {
          const p = join(dir, `${c.role}.md`);
          if (!existsSync(p)) {
            writeFileSync(p, `---\nactor: ${c.role}\ntask_id: ${taskId}\nmodel: ${c.provider}/${c.model}\n---\n\nstatus: ${c.ok ? 'done' : 'failed'}\n\n${c.text}\n`);
          }
        }
      }
      const okCount = cards.filter((c) => c.ok).length;
      return {
        status: okCount ? 'done' : 'failed',
        mode,
        taskId,
        summary: `moa/${mode}: ${okCount}/${cards.length} 席完成（${names.join('+')}）→ 请主模型聚合裁决`,
        seats: cards,
        tokens_by_model: tokensByModel,
        costNote: 'cost_estimate 一律为估算口径（价格表 v1.1 峰谷版）',
      };
    },
  });
}
