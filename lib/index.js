/**
 * DSH-MOA — Mixture-of-Agents runtime for DeepSeek Harness.
 *
 * 设计原则：
 * - 主模型纯 GUI 选择：会话当前模型即 captain/聚合器，本插件从不钉定或切换它；
 * - DSH 注册的每个模型都可注册为子模型：roster 角色文件制（包内默认 + 用户层覆盖）；
 * - navigator（内控官）为独立异步角色（2026-08-28 裁定：deepseek-v4-pro；可切 kimi-k3 省钱）；
 * - advisor = 无工具 llm.stream 直调（成本与隔离最优）；材料经 context_files 白名单读取。
 */
import z from '@deepseek-ai/schemastery';
import { createRoster } from './roster.js';
import { createMoaTool } from './tool.js';
import { createMoaCardTool } from './card-tool.js';
import { createMoaCommand } from './command.js';
import { createSeatPool } from './seats.js';

export const name = 'dsh-moa';
export const inject = ['llm', 'tools'];

export const Config = z.object({
  /** 用户层角色文件目录（JSON，同名覆盖包内默认角色）。 */
  rolesDir: z.string().default('~/.dsh/moa/roles'),
  /** navigator（内控官）席位（2026-08-28 裁定默认 v4-pro；省钱可切 kimi-coding/k3）。 */
  navigatorProvider: z.string().default('deepseek-official'),
  navigatorModel: z.string().default('deepseek-v4-pro'),
  /** advisor 上下文预算（字符，failsafe 上限）。 */
  maxAdvisorContextChars: z.number().step(1).min(0).default(12000),
  maxToolResultChars: z.number().step(1).min(1).default(6000),
  referenceMaxTokens: z.number().step(1).min(1).default(8000),
  referenceTemperature: z.number().default(0.2),
  /** 独立意见字数上限（席位协议；扩写需主模型批准）。 */
  opinionWordCap: z.number().step(1).min(100).default(500),
  /** 结果卡目录（工作区相对路径）。 */
  resultCardDir: z.string().default('.pi/moa'),
  /** navigator 自动内控开关：moa 任务收官后按风险分层自动核查（全过必审/高 stakes 必审）。 */
  navigatorAutoAudit: z.boolean().default(true),
  /** 自动调度矩阵槽位（provider/model；provider=codex 表示 codex CLI runtime）。
   *  订阅优先（2026-09-02 用户裁定；v0.3.3 起 GLM 评审席 DSH spawn 常驻——alpha.4 实证 zai-coding-cn 直连）：
   *  常规用 GLM-flash（coding plan Pro），视觉/devil 用 kimi-k3（Allegro 年会员）；
   *  DeepSeek 仅补充：高 stakes critic=v4-pro（A/B 双跑 0:3 实证回滚）、大上下文 devil、executor-pro、navigator。 */
  cheapModel: z.string().default('zai-coding-cn/glm-5.3-flash'),
  visionModel: z.string().default('kimi-coding/k3'),
  proModel: z.string().default('deepseek-official/deepseek-v4-pro'),
  devilModel: z.string().default('kimi-coding/k3'),
});

/** 启动能力自检：DSH 升级后逐项探测依赖契约，缺什么降级什么，绝不拖死宿主挂载。 */
function probeCapabilities(ctx) {
  return {
    llm: typeof ctx.llm?.stream === 'function',
    llmList: typeof ctx.llm?.listProviders === 'function',
    tools: typeof ctx.tools?.register === 'function',
    subagents: typeof ctx.get?.('subagents')?.startContinuable === 'function',
    subagentFollowup: (() => {
      const svc = ctx.get?.('subagents');
      return typeof svc?.followup === 'function'
        || typeof svc?.[Symbol.for('dsh.subagent.queuePrompt')] === 'function';
    })(),
    commands: typeof ctx.get?.('commands')?.register === 'function',
    sandboxPolicy: Boolean(ctx.get?.('sandboxPolicy')),
  };
}

export function apply(ctx, config) {
  const resolved = Config(config ?? {});
  const state = { navigator: { provider: resolved.navigatorProvider, model: resolved.navigatorModel } };
  const roster = createRoster(resolved);
  const seatPool = createSeatPool(ctx);
  const caps = probeCapabilities(ctx);

  const missing = Object.entries(caps).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) console.warn(`[dsh-moa] 能力降级：${missing.join(', ')} 不可用（可能 DSH 版本契约变动）`);

  if (!caps.tools || !caps.llm) {
    console.error('[dsh-moa] 核心契约缺失（tools/llm），插件不挂载业务面，宿主不受影响');
    return;
  }
  try {
    ctx.tools.register(createMoaTool(ctx, resolved, roster, state, seatPool));
    ctx.tools.register(createMoaCardTool(ctx));
  } catch (e) {
    console.error(`[dsh-moa] 工具注册失败（宿主继续）：${e.message}`);
  }
  if (caps.commands) {
    try {
      ctx.get('commands').register(createMoaCommand(ctx, resolved, roster, state, seatPool));
    } catch (e) {
      console.warn(`[dsh-moa] /moa 命令注册失败（不影响工具）：${e.message}`);
    }
  }
  try {
    const providers = ctx.llm.listProviders().map((p) => p.id ?? p.name ?? p.provider);
    console.log(`[dsh-moa] mounted; providers: ${providers.join(', ') || '(none)'}; roles: ${roster.list().map((r) => r.name).join(',')}; caps: ${Object.entries(caps).filter(([, v]) => v).map(([k]) => k).join(',')}`);
  } catch {
    console.log('[dsh-moa] mounted');
  }
}
