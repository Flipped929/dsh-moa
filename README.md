# DSH-MOA

**Mixture-of-Agents runtime for [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) (DSH).**

主模型纯 GUI 选择，DSH 注册的每个模型都可做子模型，异步 Navigator（内控官）独立核查。

- **主模型不钉定**：你在主界面正常选模型，那个模型就是 captain/聚合器——本插件从不切换或覆盖你的选择。
- **子模型任意注册**：roster 角色文件制，DSH 里注册过的任何模型都能绑到 advisor 席位（analyst/critic/devil/navigator…），加一个 JSON 文件即注册新角色。
- **评审融合工具 `moa`**：并行调度多个子模型 advisor 出独立意见（无工具 `llm.stream` 直调，便宜），主模型聚合裁决。
- **异步 Navigator（内控官）**：独立角色核查运行记录、抽检关键结论、产出成本对比（默认 kimi-k3，可切 deepseek-v4-pro）。
- **`/moa` 命令**：人机命令随时查看与切换（`status | roles | navigator <provider/model>`）。

移植自 [pi-moa](https://www.npmjs.com/package/@duyviet1804/pi-moa)（MIT）并借鉴 [openai/codex](https://github.com/openai/codex) 的角色文件与内控官设计、北大 DCAI [DataFlow-Harness](https://github.com/OpenDCAI/DataFlow-webui) 的 live-registry grounding。

## 安装

```bash
# 1. 把包装进某个 profile（假设你已 clone 本仓库）
dsh plugin --profile web add /path/to/dsh-moa
# 或发布到 npm 后：dsh plugin --profile web add dsh-moa

# 2. 在该 profile 的 cordis.patch.yml 加入（见 cordis.patch.example.yml）
- insert:
    - id: dsh-moa
      name: 'dsh-moa'

# 3. 重启该 profile
dsh --profile web
```

## 使用

```
# 模型可见的 moa 工具（主 agent 在适当时机调用）
moa(task="评审这份方案", mode="review", context_files=["10-工作区/x.md"], writeResultCard=true)

# 人机命令（模型不可见）
/moa status                     # providers、navigator、roster 席位
/moa roles                      # 全部角色文件
/moa navigator kimi-coding/k3   # 切换内控官席位
```

## roster 角色文件

包内默认角色在 `roles/`（analyst/critic/devil/navigator）。用户层目录 `~/.dsh/moa/roles/` 下的同名 JSON **覆盖**包内角色，新文件名即新角色：

```json
{
  "name": "critic-pro",
  "description": "高 stakes 深审席",
  "provider": "deepseek-official",
  "model": "deepseek-v4-pro",
  "maxTokens": 16000,
  "temperature": 0.2,
  "systemPrompt": "你是 MoA 评审的 critic-pro 席……"
}
```

生效白名单：`name/description/provider/model/maxTokens/temperature/systemPrompt`——角色只能做减法，sandbox/approval 永远继承父会话。

## 配置（cordis.patch.yml config 段）

| 键 | 默认 | 说明 |
|---|---|---|
| `rolesDir` | `~/.dsh/moa/roles` | 用户层角色文件目录 |
| `navigatorProvider` / `navigatorModel` | `kimi-coding` / `k3` | 内控官席位（可改 `deepseek-official`/`deepseek-v4-pro`） |
| `maxAdvisorContextChars` | `12000` | advisor 上下文预算 failsafe（字符） |
| `referenceMaxTokens` | `8000` | 每席位输出上限 |
| `referenceTemperature` | `0.2` | advisor 温度 |
| `resultCardDir` | `.pi/moa` | 结果卡目录（工作区相对路径） |

## 治理边界

- 本会话产出 = 读、分析、起草；工程执行不归本插件。
- 发往 advisor 的上下文经过双层脱敏（值库 + 模式）；`context_files` 白名单限定在工作区内读取。
- 结果卡 `createIfAbsent`，不覆盖既有文件；成本字段一律标注"估算"。
- 凭证复用 DSH 已配置的 llm adapter 路由，本插件不新增任何凭证字段。

## Roadmap

- v0.1：roster + moa 工具 + /moa 命令（本版）
- v0.2：navigator 异步巡航（startContinuable）+ 抽检/核查 + 成本周报
- v0.3：门控层（checkpoint/final 有序 fallback、fail-closed）
- v0.4：workflow batch 子模式 + telemetry

## License

MIT（与 pi-moa 一致）
