/**
 * DSH-MOA — Mixture-of-Agents runtime for DeepSeek Harness.
 *
 * 设计原则：
 * - 主模型纯 GUI 选择：会话当前模型即 captain/聚合器，本插件从不钉定或切换它；
 * - DSH 注册的每个模型都可注册为子模型：roster 角色文件制（包内默认 + 用户层覆盖）；
 * - navigator（内控官）为独立异步角色：kimi-k3 或 deepseek-v4-pro 可选；
 * - advisor = 无工具 llm.stream 直调（成本与隔离最优）；材料经 context_files 白名单读取。
 */
import z from '@deepseek-ai/schemastery';
import { createRoster } from './roster.js';
import { createMoaTool } from './tool.js';
import { createMoaCommand } from './command.js';
import { createSeatPool } from './seats.js';

export const name = 'dsh-moa';
export const inject = ['llm', 'tools'];

export const Config = z.object({
  /** 用户层角色文件目录（JSON，同名覆盖包内默认角色）。 */
  rolesDir: z.string().default('~/.dsh/moa/roles'),
  /** navigator（内控官）席位，默认 kimi-k3；可配 deepseek-official/deepseek-v4-pro。 */
  navigatorProvider: z.string().default('kimi-coding'),
  navigatorModel: z.string().default('k3'),
  /** advisor 上下文预算（字符，failsafe 上限）。 */
  maxAdvisorContextChars: z.number().step(1).min(0).default(12000),
  maxToolResultChars: z.number().step(1).min(1).default(6000),
  referenceMaxTokens: z.number().step(1).min(1).default(8000),
  referenceTemperature: z.number().default(0.2),
  /** 独立意见字数上限（席位协议；扩写需主模型批准）。 */
  opinionWordCap: z.number().step(1).min(100).default(500),
  /** 结果卡目录（工作区相对路径）。 */
  resultCardDir: z.string().default('.pi/moa'),
});

export function apply(ctx, config) {
  const resolved = Config(config ?? {});
  const state = { navigator: { provider: resolved.navigatorProvider, model: resolved.navigatorModel } };
  const roster = createRoster(resolved);
  const seatPool = createSeatPool(ctx);

  ctx.tools.register(createMoaTool(ctx, resolved, roster, state, seatPool));
  const commands = ctx.get?.('commands');
  if (commands) commands.register(createMoaCommand(ctx, resolved, roster, state, seatPool));

  try {
    const providers = ctx.llm.listProviders().map((p) => p.id ?? p.name ?? p.provider);
    console.log(`[dsh-moa] mounted; providers: ${providers.join(', ') || '(none)'}; roles: ${roster.list().map((r) => r.name).join(',')}`);
  } catch {
    console.log('[dsh-moa] mounted');
  }
}
