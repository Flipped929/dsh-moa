# dsh-moa 🐙

**dsh-moa 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）上的多模型协同运行时（Mixture-of-Agents）：主模型纯 GUI 选择做 captain，DSH 注册的每个模型都能做子模型，常驻席位跨任务保留上下文，codex 异构席位接入 GLM，navigator 内控官异步核查。**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) · [![Version: 0.3.3](https://img.shields.io/badge/version-0.3.3-blue.svg)](CHANGELOG.md)

## 适配 DSH 版本

- **官方验证版本：dsh-v0.1.2-alpha.4**（2026-09-01，当前最新）；开发/验证历史：0.1.2-alpha.1 / alpha.2 / alpha.3。
- 最低要求：dsh-v0.1.2-alpha.1（每席位 reasoningEffort 需要该版本；更早版本自动忽略该字段）。
- alpha.4 变动核对：持续子代理的 `report` 工具被 `send_message` 取代——本插件席位走自注册 `moa_write_card` 工具 + 结果卡协议，不受影响；宿主派活 API `followup` 被移除，改走 `Symbol.for('dsh.subagent.queuePrompt')` 内部符号通道——本插件已做跨版本兼容分派（≤alpha.3 用 followup，≥alpha.4 用符号通道），并有单测锁定；`Session.events` 被按需 API（`seq`/`eventAt()`/`snapshotEvents()`）取代——本插件未使用；Web PTC 模式默认移除 `workflow` 工具——本插件 deny 列表本就含 workflow。
- 升级兼容按「能力自检 + 优雅降级」设计（见文末）。

## 它是什么

一句话：**把"一个模型从头干到尾"改成"你选的 captain 调度 + 多模型席位对抗/执行 + 内控官核查"**。

- **主模型不钉定**：你在主界面正常选模型，那个模型就是 captain/聚合器——本插件从不切换或覆盖你的选择。
- **子模型任意注册**：roster 角色文件制（包内默认 + `~/.dsh/moa/roles/` 用户层覆盖），加一个 JSON 文件即注册新角色/新模型。
- **自动调度矩阵（订阅优先）**：不指定席位时，按 模型特性 × 任务类型 × 成本 自动分派——常规=GLM-5.3-flash（coding plan Pro 订阅）/ 高 stakes critic=GLM-5.3（同订阅）/ 视觉与 devil=kimi-k3（Allegro 年会员订阅）/ DeepSeek 仅补充（大上下文 devil、navigator、难片 executor-pro、视觉辅助 vision-aux=v4-flash-vision-exp 与 k3 analyst 交叉核验，批量排低谷）。
- **常驻席位**：spawn 席位跨任务保留进程与上下文（续任务带着上轮记忆），冷恢复跨重启存续；codex 席位经 thread_id resume 续接。
- **异构 codex 席位**：executor 执行类角色（写代码/跑测试）经 codex runtime 接入（独立 agent runtime，自带沙箱与工具链）；GLM 评审席自 v0.3.3 起改走 DSH spawn 常驻（zai-coding-cn 直连，alpha.4 实证）。
- **navigator 内控官**：任务收官后按风险分层自动核查（全过必审/高 stakes 必审），产出核查卡与成本对比。

## 解决什么痛点

1. **单模型盲区**——同模型自审等于没审。解法：跨家族对抗（devil=k3）+ 对抗立场 prompt + 独立上下文。
2. **旗舰模型干机械活**——解法：成本分层（GLM/k3 订阅额度承包、DeepSeek 只接难片与内控、captain 只做裁决），DeepSeek 峰谷时段提示。
3. **多模型集成的假多样性**——解法：真异构（家族差异+档位差），审查者档位 ≥ 被审者（stakes=high 时 critic 升 GLM-5.3；dev 平面 executor=glm 时 critic 强制 v4-pro 防同源自审）。
4. **纯路由无治理**——解法：黑板协议全程留痕（`.pi/moa/<task-id>/` 结果卡）+ navigator 内控核查 + 成本估算台账。

## 30 秒理解架构

```
你（DSH 主会话 · GUI 选主模型 = captain，插件永不钉定）
  │ 任务设计/拆分（前提）：moa(task, mode, seats?)
  ▼
moa 工具 ── 自动调度矩阵（订阅优先：特性×任务×成本）
  ├─ 常驻评审席（spawn continuable，跨任务保留上下文，冷恢复跨重启）
  │     analyst/critic（GLM-5.3-flash · zai-coding-cn 直连）· devil（k3 跨家族）
  │     stakes=high 时 critic→GLM-5.3（review 平面）
  ├─ 异构执行席（codex runtime · GLM 订阅 · 自带沙箱）
  │     executor-glm-flash / executor-glm · architect-k3（视觉走查）
  └─ DeepSeek 补充席：executor-pro（难片二顺位）· navigator（内控 v4-pro 异步）
        · vision-aux（v4-flash-vision-exp：有视觉材料时与 k3 analyst 交叉核验）
        │ 任务卡 → 结果卡（黑板 .pi/moa/<task-id>/results/；星型拓扑，席位间不直连）
        ▼
captain 读卡 → 聚合裁决 →（全过/高 stakes 必审）
        ▼
navigator 内控（v4-pro 异步）── navigator.md 核查卡 · tokens_by_model · cost_estimate（估算标注）
```

## 安装

```bash
# 1. 安装到 profile（本地路径或 npm）
dsh plugin --profile web add /path/to/dsh-moa     # 或 dsh plugin --profile web add dsh-moa

# 2. profile 的 cordis.patch.yml 加入（见 cordis.patch.example.yml）
- insert:
    - id: dsh-moa
      name: 'dsh-moa'

# 3. （执行席需要：dev 平面 executor 走 codex CLI；评审席已改 DSH spawn 直连）装后端 + patch 行
dsh plugin --profile web add @deepseek-ai/dsh-subagent-codex
- insert:
    - id: subagent-codex
      name: '@deepseek-ai/dsh-subagent-codex'

# 4. 重启该 profile
```

要求：DSH ≥ 0.1.2-alpha.1（官方验证 0.1.2-alpha.4）；GLM 评审席直连 DSH（需配置 `zai-coding-cn` provider，GLM coding plan 订阅）；executor 执行席另需本机 `codex` CLI 可用（`~/.codex/config.toml` 配置 GLM provider）。

## 使用

```
# 最简：一句话（自动调度矩阵选席位）
用 moa 评审一下 10-工作区/xxx.md

# 模型可见的 moa 工具参数
task / mode(review|research|write|dev-backend|dev-frontend|test|audit|review-full)
seats=[{role, provider?, model?, focus?}]   # 按任务指派（任何已注册模型）
stakes="high"                                # critic 自动升 GLM-5.3（dev 平面升 v4-pro）
fast=true                                    # 无状态 llm.stream 单发通道（仅 DSH provider）
allowLong=true                               # 批准席位扩写（≤2000字）
context_files=[...]                          # 材料白名单（工作区相对路径）

# 人机命令（模型不可见）
/moa status    # providers · 调度矩阵 · roster · 席位池 · navigator
/moa roles     # 全部角色文件
/moa seats     # 常驻席位进程池
/moa reset [key]                 # 重置席位
/moa navigator <provider/model>  # 切换内控官席位
```

## roster 角色文件

包内默认在 `roles/`（analyst/critic/devil/navigator/executor-pro/architect-k3/vision-check/vision-aux/executor-glm-flash/executor-glm/executor-codex/reviewer-glm/reviewer-glm-flash）。用户层 `~/.dsh/moa/roles/` 同名覆盖、新文件即新角色：

```json
{
  "name": "critic-pro",
  "description": "高 stakes 深审席",
  "provider": "deepseek-official",
  "model": "deepseek-v4-pro",
  "maxTokens": 16000,
  "reasoningEffort": "high",
  "systemPrompt": "你是 MoA 评审的 critic-pro 席……"
}
```

生效白名单：`name/description/provider/model/maxTokens/temperature/systemPrompt/tools/reasoningEffort/runtime`——角色只能做减法；sandbox/approval 永远继承父会话；`provider:"codex"` 自动走 codex CLI runtime（也可显式 `runtime:"codex"`）。

## 模型经济学（2026-09-02 用户裁定）

| 档位 | 模型 | 通道 | 成本口径 |
|---|---|---|---|
| 常规/初稿/评审 | GLM-5.3-flash | DSH spawn 常驻（zai-coding-cn） | coding plan Pro 订阅额度 |
| 深度/高 stakes | GLM-5.3 | DSH spawn 常驻（zai-coding-cn） | 同上 |
| 执行（写代码/跑测试） | GLM-5.3-flash / GLM-5.3 | codex CLI（自带沙箱） | 同上 |
| 跨家族/视觉/架构 | kimi-k3 | spawn 常驻 | Allegro 年会员订阅额度 |
| DeepSeek 补充 | v4-pro / v4-flash-vision-exp（vision-aux 视觉辅助） | spawn 常驻 | 峰谷计费 ¥3/9、¥9/27（高峰=工作日 9-12/14-18），批量排低谷/周末 |

- **claude 不加入席位**（2026-09-02 用户裁定）。
- 订阅额度耗竭降级链：k3 不可用→v4-pro；glm 不可用→v4-pro。

## 治理边界

- 本会话产出 = 读、分析、起草；工程执行归 codex 席位（它自己的 sandbox 承担）或人工。
- 发往席位的材料双层脱敏（值库+模式）；`context_files` 白名单 realpath 限定工作区内；
- 席位不可再派子代理（toolFilter + maxDepth 双保险）；结果卡 `wx` 防覆盖；
- 凭证复用 DSH 已配置的 llm adapter / codex 自身配置，本插件不新增凭证字段；
- 成本字段一律标注"估算"（价格表峰谷版，附录见 docs/）。

## DSH 版本升级时的兼容性

插件按"能力自检 + 优雅降级"设计：升级后挂载时逐项探测依赖契约（llm/tools/subagents/commands/sandboxPolicy），缺什么降级什么并在日志里明说，绝不因契约变动拖死宿主。

升级后两步自查：

```bash
# 1. 挂载行还在吗（升级掉 patch 行是实证过的事故）
scripts/ensure-mount.sh web        # 幂等恢复，缺了才写

# 2. 契约还兼容吗
cd ~/.dsh/profiles/web && node ~/Projects/dsh-moa/scripts/smoke.mjs
```

实测兼容：0.1.2-alpha.1 / alpha.2 / alpha.3 / **alpha.4（当前官方验证版）**。

## Roadmap

- v0.1：roster + moa 工具 + /moa 命令 ✅
- v0.2：常驻席位池 + 自动调度矩阵 + codex 异构席 + navigator 在线化 ✅
- v0.3（本版）：订阅优先矩阵（GLM/k3 优先、DeepSeek 补充）+ claude 移出席位 + DSH alpha.4 适配 + vision-aux 交叉核验席 + GLM 评审席 spawn 常驻化（v0.3.3，alpha.4 实证 zai-coding-cn 直连）✅
- v0.4：workflow batch 子模式 · telemetry 周报 · 订阅额度耗竭检测与降级链 · 上游 continuable codex provider（见 docs/continuable-codex-provider-issue.md）

## Credits

移植与借鉴：[pi-moa](https://www.npmjs.com/package/@duyviet1804/pi-moa)（MIT）、[openai/codex](https://github.com/openai/codex)（角色文件/Guardian 内控官）、[DataFlow-Harness](https://github.com/OpenDCAI/DataFlow-webui)（live-registry grounding）、[pi-moa 双平面实践](https://github.com/Flipped929/pi-moa)（三卡协议/调度矩阵/门禁分级）。

## License

MIT
