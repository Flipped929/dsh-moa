# 异构 agent runtime 席位（codex 等外部 agent）

> 设计原则：**不重复造轮子**。外部 agent runtime（codex 等）的接入完全复用 DSH 原生 subagents 注册表与 dsh-moa 的席位池/黑板协议，不新增编排层。

## 通道与前提

| 通道 | 前提 | 形态 |
|---|---|---|
| `subagent_codex` 工具 | profile 装 `@deepseek-ai/dsh-subagent-codex` + patch 行 `subagent-codex` + preset 启用（去掉 disabled）+ 重启 | 主 agent 直接把任务派给 codex（一次性 ephemeral 线程） |
| roster 席位 `runtime: "codex"` | 同上 | moa 的 seats 参数可派 codex 当执行席 |

## codex 运行时的特性（来自 provider 契约）

- 每次运行 = `codex app-server --stdio` 起一个 **ephemeral 线程**，任务文本 + 父会话 cwd，**不继承父上下文**（`inheritsParentContext: false`）；
- 无人值守设计：审批请求自动取非批准决策（优先 cancel/decline），权限/输入/MCP 请求一律空答；
- **无 toolFilter/maxDepth 等能力位**——它不是 DSH 进程内子代理，权限边界由 codex 自己的 sandbox/approval 配置承担（`~/.codex/config.toml`）；
- 结果经 SubagentRun.result 回流最终答案（`final_answer` 阶段为准）。

## 与常驻席位（spawn 通道）的分工

> v0.3.3 修订（2026-09-02，alpha.4 实证）：**GLM 评审席已全部改回 spawn 常驻**——`zai-coding-cn` provider（GLM coding plan 订阅）可在 DSH 内直接 spawn（fast 直连 + 常驻交卡均已实测跑通）。codex 通道收窄为 **executor 执行类角色专用**（写代码/跑测试需要其自带沙箱与工具链）。

| | spawn 常驻席位（默认） | codex 执行席 |
|---|---|---|
| 上下文 | 跨任务保留（连续任务表现好） | **v0.2.0 起有保留**：席位池按 codex CLI 会话存储续接（`--json` 捕获 thread_id，`resume <id>` 续跑，2026-08-28 实证记忆接续正确）；DSH provider 通道为 ephemeral 一次性（实证 NO_CONTINUITY），上游 continuable 草案见 docs/continuable-codex-provider-issue.md |
| 能力 | DSH 工具面子集（toolFilter） | codex 完整工具链 + GLM/任意配置模型 |
| 权限 | DSH 沙箱/审批 | codex 自有沙箱（派任务前确认其档位） |
| 适用 | 评审/核查/连续顾问 | 独立执行片段（改代码、跑测试） |

## 角色文件写法

```json
{
  "name": "executor-codex",
  "description": "codex 异构执行席（GLM/自带沙箱）",
  "runtime": "codex",
  "provider": "codex",
  "model": "codex"
}
```

`runtime` 缺省 `llm`（llm.stream/spawn 通道）；`codex` 时 provider/model 仅作记录，真实模型由 codex 自己的 config 决定。
