
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
import { randomUUID } from 'node:crypto';
import { runAdvisors, buildAdvisorPrompt } from './advisor.js';
import { redactText, truncateMiddle } from './redact.js';
import { assignSeats, isImagePath, isPeakHour } from './scheduler.js';

const MODES = {
  review: ['analyst', 'critic', 'devil'],
  research: ['analyst'],
  write: ['analyst', 'critic'],
  'review-full': [],
  'dev-backend': [],
  'dev-frontend': [],
  test: [],
  audit: [],
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
  const rolePrompt = seat.systemPrompt ?? `你是 MoA 的 ${seat.name} 席。`;
  const prompt = [
    '【席位协议】',
    '本协议优先于角色立场里的不调用工具声明；你只允许使用 read/grep/glob/read_image/moa_write_card。',
    `1. 你是常驻席位：本进程跨任务存续，后续任务会带着你之前的上下文接续。`,
    `2. 每次任务把结果卡写到任务卡指定的路径（frontmatter 全部在 --- 内：actor/task_id/model/status/summary/findings/concerns；status 为闭集：done=完成 / partial=部分完成 / failed=失败，禁止其他取值），那是你的唯一写产物。`,
    `3. 独立意见正文 ≤${wordCap} 字；确需更多篇幅，先交 ${wordCap} 字版并在结果卡末尾写【申请扩写：理由】，由主模型定夺。`,
    '4. 你不能委派/再派任何子代理；需要协作时在结果卡 concerns 里写明，由主模型转发。',
    '5. 完成任务后用一句话（≤50 字）总结回复。',
    '6. 每个任务工具调用预算 ≤15 次：达到预算立即用已有证据收尾写卡，禁止反复重扫。',
    '',
    '【角色立场】',
    rolePrompt,
  ].join('\n');
  return redactText(prompt);
}

function buildTaskPacket({ task, taskId, focus, files, cardPath, wordCap, allowLong, runtime }) {
  if (runtime === 'codex') {
    // codex 是独立 runtime：没有 DSH 工具（moa_write_card 等），结果卡由插件代写
    const sections = [
      '## 任务卡',
      `goal: ${task}`,
      focus ? `focus: ${focus}` : null,
      '',
      '## 输出协议',
      `0. 本任务 task_id: ${taskId}`,
      '1. 把完整产出直接作为最终回复返回（评审意见/代码补丁/分析全文均可，不写任何文件，不委派）',
      '2. 若产出是代码：给出每个改动文件的完整新内容，用 === FILE: <相对路径> === 分隔',
    ].filter(Boolean);
    for (const f of files ?? []) {
      if (f.image) sections.push(`\n## 材料 ${f.path}\n（图片文件，请自行查看后评审）`);
      else sections.push(`\n## 材料 ${f.path}\n${f.content}`);
    }
    return redactText(sections.join('\n'));
  }
  const sections = [
    '## 任务卡',
    `goal: ${task}`,
    focus ? `focus: ${focus}` : null,
    '',
    '## 输出协议',
    `0. 本任务 task_id: ${taskId}`,
    `1. 结果卡写到：${cardPath}（frontmatter 全在 --- 内；status 闭集：done/partial/failed）`,
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

function validateResultCard(card, taskId) {
  if (!card) return 'result card not found';
  const frontmatter = card.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontmatter) return 'result card has no frontmatter';
  const taskIdLine = frontmatter[1].match(/^task_id:\s*(["']?)(.*)\1\s*$/m);
  if (!taskIdLine || taskIdLine[2].trim() !== taskId) {
    return `result card frontmatter task_id is missing or does not match ${taskId}`;
  }
  const statusLine = frontmatter[1].match(/^status:\s*(["']?)(.*)\1\s*$/m);
  if (!statusLine || statusLine[2].trim() !== 'done') return 'result card frontmatter status is not done';
  return null;
}

function errorText(error) {
  return String(error?.message ?? error);
}

export function createMoaTool(ctx, resolved, roster, state, seatPool) {
  return defineTool({
    name: 'moa',
    description: 'Mixture-of-Agents 评审融合：只需给任务，插件按模型特性×任务类型×成本自动分派席位（订阅优先：GLM-5.3-flash 常规/GLM-5.3 高 stakes/kimi-k3 跨家族与视觉；DeepSeek 仅补充 navigator、大上下文与难片，devil 恒跨家族），主模型（当前会话模型）聚合裁决。席位默认常驻（跨任务保留上下文），fast=true 走单发省费通道（仅 DSH provider）。要自定义再用 seats/roles 参数；stakes=high 时 critic 自动升 GLM-5.3（dev 平面升 v4-pro）。成本提示：每席位是完整 agent 轮次；单文件或 <10 分钟小任务请主模型直接做。',
    parameters: {
      task: { type: 'string', required: true, description: '任务描述（主模型应先做好任务设计/拆分再派发）' },
      mode: { type: 'string', description: 'review(默认三席) | review-full(联评满编：GLM 双档+k3 四席) | research(调研) | write(写作) | dev-backend(后端开发) | dev-frontend(前端开发) | test(测试) | audit(异步内控核查)' },
      seats: { type: 'array', items: { type: 'object', additionalProperties: true }, description: '按任务指派席位：[{role, provider?, model?, focus?}]；provider/model 缺省用角色文件默认' },
      roles: { type: 'array', items: { type: 'string' }, description: '简化形式：只点名角色名，模型取角色文件默认' },
      context_files: { type: 'array', items: { type: 'string' }, description: '工作区内材料文件相对路径（白名单读取并入任务卡）' },
      stakes: { type: 'string', description: "high=关键产出/高 stakes（critic 席自动升 GLM-5.3；dev 平面升 v4-pro）" },
      fast: { type: 'boolean', description: 'true=无状态 llm.stream 单发通道（省费快）；缺省 false=常驻席位进程' },
      allowLong: { type: 'boolean', description: '批准席位扩写（≤2000 字），用于批准【申请扩写】后的续跑' },
      writeResultCard: { type: 'boolean', description: 'fast 通道下由插件代写结果卡（常驻模式席位自写）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        if (!value || typeof value !== 'object') return [{ type: 'text', text: 'moa run finished' }];
        const lines = [value.summary ?? ''];
        if (value.peakNote) lines.push(`⚠️ ${value.peakNote}`);
        for (const seat of value.seats ?? []) {
          const body = seat.text ?? seat.preview ?? '(无内容)';
          const tag = seat.ok === false ? ' [失败]' : '';
          lines.push(`\n## ${seat.role} 席（${seat.provider}/${seat.model}）${tag}\n${String(body).slice(0, 1500)}`);
        }
        if (value.audit) {
          const a = value.audit;
          lines.push(`\n## navigator 内控\n${a.dispatched ? `已异步派发，核查卡：${a.cardPath}` : (a.preview ? String(a.preview).slice(0, 800) : (a.error ?? '(无卡)'))}`);
        }
        if (value.resultDir) lines.push(`\n结果卡目录：${value.resultDir}（完整卡可用 read 逐张细读）`);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    timeoutMs: 900000,
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
          // provider=codex 即 codex CLI runtime（显式 runtime 优先，其次角色文件，最后按 provider 推断）
          runtime: spec.runtime ?? base.runtime ?? ((spec.provider ?? base.provider) === 'codex' ? 'codex' : undefined),
          focus: spec.focus,
        };
      });
      for (const s of seats) {
        if (!s.provider || !s.model) throw new Error(`moa: 席位 ${s.name} 缺 provider/model（roster 与 seats 参数均未给）`);
      }

      const files = (args.context_files ?? []).map((p) => safeRead(wsRoot, p, resolved.maxToolResultChars ?? 6000));
      const taskId = randomUUID();

      // ── fast 通道：无状态 llm.stream 单发（v0.1 路径）──
      if (args.fast) {
        if (seats.some((s) => s.provider === 'codex')) throw new Error('moa: fast 通道走 DSH llm.stream，不支持 codex/GLM 席位（订阅优先矩阵默认 GLM）；请去掉 fast=true 走常驻席位，或显式指定 DSH provider 席位（如 kimi-coding/k3）');
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
            if (!existsSync(p)) writeFileSync(p, `---\nactor: ${c.role}\ntask_id: ${taskId}\nmodel: ${c.provider}/${c.model}\nstatus: ${c.ok ? 'done' : 'failed'}\n---\n\n${c.text}\n`);
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
        const knownTools = new Set((() => { try { return ctx.tools.schemas().map((t) => t.name); } catch { return []; } })());
        const seat = {
          ...s,
          bootPrompt: buildBootPrompt(s, wordCap),
          toolFilter: {
            allow: ['read', 'grep', 'glob', 'read_image', 'moa_write_card'],
            // deny 仅补充已注册工具（未知名会被 restrict 响亮拒绝）；allow 名单才是真实边界
            deny: DELEGATION_DENY.filter((n) => knownTools.has(n)),
          },
        };
        const cardPath = join(dir, `${seat.name}.md`);
        const packet = buildTaskPacket({ task: args.task, taskId, focus: seat.focus, files: files.filter((f) => f.content), cardPath, wordCap, allowLong: Boolean(args.allowLong) });
        let entry = null;
        let prepareError = null;
        let firstDelivered = false;
        if (seat.runtime === 'codex') {
          entry = seatPool.ensureCliSeat(parent, seat);
        } else {
          try {
            entry = await seatPool.ensureSeat(parent, seat, exec.signal, packet);
            firstDelivered = Boolean(entry.fresh);
          } catch (error) {
            prepareError = errorText(error);
          }
        }
        prepared.push({ seat, entry, cardPath, packet, prepareError, firstDelivered });
      }
      const runCodexSeat = async (seat, entry) => {
        const subagents = ctx.get?.('subagents');
        if (!subagents?.getProvider?.('codex')) {
          return { seat, cardPath: join(dir, `${seat.name}.md`), card: null, settle: 'error', error: 'codex runtime 未挂载（需 profile 安装 @deepseek-ai/dsh-subagent-codex 且 patch 加 subagent-codex 行）；可换第二顺位 executor-pro（deepseek-v4-pro）' };
        }
        const cardPath = join(dir, `${seat.name}.md`);
        const packet = buildTaskPacket({ task: args.task, taskId, focus: seat.focus, files: files.filter((f) => f.content), cardPath, wordCap, allowLong: Boolean(args.allowLong), runtime: 'codex' });
        if (entry) seat.codexEntry = entry;
        let text = '';
        let runError = null;
        try {
          // codex CLI 续接通道：同一席位跨任务用 resume <thread_id> 保留上下文（2026-08-28 实证）
          const r = await seatPool.taskCodexCli(parent, seat.codexEntry ?? seat, packet, exec.signal);
          text = r.text;
        } catch (e) {
          runError = String(e?.message ?? e);
        }
        const status = text ? 'done' : 'failed';
        if (!existsSync(cardPath)) {
          writeFileSync(cardPath, `---\nactor: ${seat.name}\ntask_id: ${taskId}\nmodel: codex-runtime\nstatus: ${status}\n---\n\n${text || `error: ${runError ?? 'empty output'}`}\n`, { flag: 'wx' });
        }
        return { seat, cardPath, card: existsSync(cardPath) ? readFileSync(cardPath, 'utf8') : null, settle: text ? 'completed' : 'error', error: runError ?? (text ? null : 'empty output') };
      };

      const settled = await Promise.allSettled(prepared.map(({ seat, entry, cardPath, packet, firstDelivered }) => {
        if (seat.runtime === 'codex') return runCodexSeat(seat, entry);
        if (!entry) return Promise.reject(new Error('seat was not prepared'));
        return seatPool.taskSeat(parent, entry, packet, cardPath, exec.signal, undefined, { alreadyDelivered: firstDelivered }).then((r) => ({ seat, cardPath, ...r }));
      }));
      const outcomes = settled.map((result, index) => {
        const { seat, cardPath, prepareError } = prepared[index];
        if (result.status === 'fulfilled') return result.value;
        return {
          seat,
          cardPath,
          card: null,
          settle: 'error',
          error: prepareError ?? errorText(result.reason),
        };
      });
      const cards = outcomes.map((o) => {
        const card = typeof o.card === 'string' ? o.card : null;
        const cardError = validateResultCard(card, taskId);
        const settleError = o.settle === 'timeout' || o.settle === 'aborted' ? `seat ${o.settle}` : null;
        const error = [o.error, settleError, cardError].filter(Boolean).join('; ') || null;
        return {
          role: o.seat.name, provider: o.seat.provider, model: o.seat.model,
          settle: o.settle, ok: !error, error, cardPath: o.cardPath,
          needsExpansion: Boolean(card && card.includes('【申请扩写')),
          preview: card ? redactText(card).slice(0, 400) : null,
        };
      });
      const okCount = cards.filter((c) => c.ok).length;
      const expansion = cards.filter((c) => c.needsExpansion).map((c) => c.role);
      const hasDeepSeekSeat = cards.some((c) => c.provider === 'deepseek-official');
      const peakNote = isPeakHour() && hasDeepSeekSeat
        ? '当前高峰时段（工作日 9-12/14-18 点），本次含 DeepSeek 席位，输出按峰价计费（v4-pro 27 元/M）；非紧急任务建议排低谷/周末'
        : null;

      // ── navigator 在线化：全过结论必审 / 高 stakes 必审（风险分层，其余手动 audit）──
      let audit = null;
      const shouldAudit = resolved.navigatorAutoAudit !== false && cards.length > 0
        && (okCount === cards.length || args.stakes === 'high');
      if (shouldAudit) {
        try {
          const navRole = roster.get('navigator') ?? {};
          const navSeat = {
            name: 'navigator',
            provider: state.navigator.provider,
            model: state.navigator.model,
            maxTokens: navRole.maxTokens ?? 16000,
            systemPrompt: navRole.systemPrompt,
          };
          const navCardPath = join(dir, 'navigator.md');
          const knownTools = new Set((() => { try { return ctx.tools.schemas().map((t) => t.name); } catch { return []; } })());
          const navEntry = await seatPool.ensureSeat(parent, {
            ...navSeat,
            bootPrompt: buildBootPrompt(navSeat, wordCap),
            toolFilter: { allow: ['read', 'grep', 'glob', 'moa_write_card'], deny: DELEGATION_DENY.filter((n) => knownTools.has(n)) },
          }, exec.signal);
          const auditPacket = [
            '## 内控核查任务',
            `task_id: ${taskId}`,
            `核查对象：${dir} 下的全部结果卡（${cards.map((c) => `${c.role}.md`).join('、')}）`,
            `原始任务：${args.task}`,
            args.stakes === 'high' ? '本任务 stakes=high：全量核查。' : '本任务全部席位通过：全过结论按必抽规则核查。',
            '',
            '## 核查要求',
            '1. 逐张读结果卡，对照材料核验每个关键结论是否有证据支撑（实证纪律：提交说明/措辞不算实证）；',
            '2. 检查席位间是否有真分歧被聚合掩盖、是否有全过假象；',
            '3. 输出核查卡到上述目录的 navigator.md（frontmatter: actor: navigator / task_id / status: PASS|FAIL / summary / findings / concerns），正文 ≤500 字。',
          ].join('\n');
          // 异步派发（治理面不进实时链路）：不等核查完成，核查卡落盘后由席位完成通知送达主会话
          seatPool.taskSeat(parent, navEntry, auditPacket, navCardPath, exec.signal, 600000, { alreadyDelivered: false })
            .catch((e) => console.warn(`[dsh-moa] navigator 内控失败: ${String(e?.message ?? e)}`));
          audit = {
            dispatched: true,
            cardPath: navCardPath,
            note: 'navigator 异步核查中，核查卡将落盘于该路径；完成时你会收到席位通知',
          };
        } catch (e) {
          audit = { settle: 'error', ok: false, error: errorText(e) };
        }
      }
      return {
        status: okCount ? 'done' : 'failed', mode: `${mode}/durable`, taskId,
        scheduled: cards.map((c) => `${c.role}=${c.provider}/${c.model}`),
        peakNote,
        summary: `moa/${mode}: ${okCount}/${cards.length} 席完成并交卡（${dir}）→ 请主模型读卡聚合裁决${expansion.length ? `；席位 ${expansion.join('/')} 申请扩写，如批准请用 allowLong 续跑` : ''}`,
        seats: cards,
        scheduling: (args.seats?.length || args.roles?.length) ? 'explicit' : 'auto-matrix',
        resultDir: dir,
        audit,
        seatPool: seatPool.list().map((s) => s.key),
        costNote: '常驻席位为完整 agent 轮次；tokens 用量见各子会话，cost_estimate 一律为估算口径',
      };
    },
  });
}
