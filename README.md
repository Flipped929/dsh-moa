# dsh-moa 🐙

**dsh-moa 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）上的多模型协同运行时（Mixture-of-Agents）：主模型纯 GUI 选择做 captain，DSH 注册的每个模型都能做子模型，常驻席位跨任务保留上下文，异构 codex 席位接入 GLM，navigator 内控官异步核查。**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) · [![Version: 0.2.0](https://img.shields.io/badge/version-0.2.0-blue.svg)](CHANGELOG.md)

## 它是什么

一句话：**把"一个模型从头干到尾"改成"你选的 captain 调度 + 多模型席位对抗/执行 + 内控官核查"**。

- **主模型不钉定**：你在主界面正常选模型，那个模型就是 captain/聚合器——本插件从不切换或覆盖你的选择。
- **子模型任意注册**：roster 角色文件制（包内默认 + `~/.dsh/moa/roles/` 用户层覆盖），加一个 JSON 文件即注册新角色/新模型。
- **自动调度矩阵**：不指定席位时，插件按 模型特性 × 任务类型 × 成本 自动分派（常规=v4-flash / 高 stakes=v4-pro / 视觉=v4-flash-vision-exp / devil 恒跨家族=k3）。
- **常驻席位进程**：同一席位跨任务保留进程与上下文（续任务带着上轮记忆），冷恢复跨重启存续。
- **异构 codex 席位**：GLM 家族经 codex runtime 接入（独立 agent runtime，自带沙箱与工具链）。
- **navigator 内控官**：任务收官后按风险分层自动核查（全过必审/高 stakes 必审），产出核查卡与成本对比。

## 解决什么痛点

1. **单模型盲区**——同模型自审等于没审。解法：跨家族对抗（devil=k3）+ 对抗立场 prompt + 独立上下文。
2. **旗舰模型干机械活**——解法：成本分层（flash 档承包、pro 档承接难片、captain 只做裁决），峰谷时段提示。
3. **多模型集成的假多样性**——解法：真异构（家族差异+档位差），审查者档位 ≥ 被审者（stakes=high 时 critic 自动升 v4-pro）。
4. **纯路由无治理**——解法：黑板协议全程留痕（`.pi/moa/<task-id>/` 结果卡）+ navigator 内控核查 + 成本估算台账。

## 30 秒理解架构

```
你（DSH 主会话 · GUI 选主模型 = captain，插件永不钉定）
  │ 任务设计/拆分（前提）：moa(task, mode, seats?)
  ▼
moa 工具 ── 自动调度矩阵（特性×任务×成本）
  ├─ 常驻评审席（spawn continuable，跨任务保留上下文，冷恢复跨重启）
  │     analyst/critic（v4-flash）· devil（k3 跨家族）· stakes=high 时 critic→v4-pro
  ├─ 异构执行席（codex runtime，ephemeral 一次性）
  │     executor-glm-flash / executor-glm（GLM 经 codex，自带沙箱）
  └─ 视觉席 vision-check（v4-flash-vision-exp）
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

# 3. （可选）异构 codex 席位：装后端 + patch 行
dsh plugin --profile web add @deepseek-ai/dsh-subagent-codex
- insert:
    - id: subagent-codex
      name: '@deepseek-ai/dsh-subagent-codex'

# 4. 重启该 profile
```

要求：DSH ≥ 0.1.2-alpha.1（每席位 reasoningEffort 需要该版本；更早版本自动降级忽略）。

## 使用

```
# 最简：一句话（自动调度矩阵选席位）
用 moa 评审一下 10-工作区/xxx.md

# 模型可见的 moa 工具参数
task / mode(review|research|write|dev-backend|dev-frontend|test|audit)
seats=[{role, provider?, model?, focus?}]   # 按任务指派（任何已注册模型）
stakes="high"                                # critic 自动升 v4-pro
fast=true                                    # 无状态 llm.stream 单发通道（省费）
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

包内默认在 `roles/`（analyst/critic/devil/navigator/executor-pro/architect-k3/vision-check/executor-glm-flash/executor-glm/executor-codex）。用户层 `~/.dsh/moa/roles/` 同名覆盖、新文件即新角色：

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

生效白名单：`name/description/provider/model/maxTokens/temperature/systemPrompt/tools/reasoningEffort/runtime`——角色只能做减法；sandbox/approval 永远继承父会话；`runtime:"codex"` 走异构通道。

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

实测兼容：0.1.2-alpha.1 / 0.1.2-alpha.2。`reasoningEffort` 席位档位需 ≥ 0.1.2-alpha.1（更早版本自动忽略该字段）。

## Roadmap

- v0.1：roster + moa 工具 + /moa 命令 ✅
- v0.2：常驻席位池 + 自动调度矩阵 + codex 异构席 + Sprint 1/2 加固 ✅
- v0.3（本版）：navigator 在线化（收官自动内控）+ reasoningEffort 双通道 ✅
- v0.4：workflow batch 子模式 · telemetry 周报 · 上游 continuable codex provider（见 docs/continuable-codex-provider-issue.md）

## Credits

移植与借鉴：[pi-moa](https://www.npmjs.com/package/@duyviet1804/pi-moa)（MIT）、[openai/codex](https://github.com/openai/codex)（角色文件/Guardian 内控官）、[DataFlow-Harness](https://github.com/OpenDCAI/DataFlow-webui)（live-registry grounding）、[pi-moa 双平面实践](https://github.com/Flipped929/pi-moa)（三卡协议/调度矩阵/门禁分级）。

## License

MIT
