# Changelog

## 0.3.5 (2026-09-02)

- **fix：图片材料任务卡措辞强化**——常驻席位任务卡的图片材料从"请自行查看"改为"必须用 read_image 读取此指定路径，禁止自选其他文件替代"（实证事故：vision-exp 席位在 A/B 多模态题中未读指定图而自行 glob 了三张合同图，OCR 质量虽好但对象错误）
- vision-check 角色 prompt 同步强化（指定路径纪律 + 无图像输入能力时 failed 并注明原因）
- 实证发现记录：GLM-5.3-flash 多模态需在 DSH 模型配置补 `inputModalities: [text, image]`（否则 read_image 报 "does not declare image input"）；vision-exp 在 fast 通道疑因 deepseek 官方配置 thinking=max 导致短任务偶发空产出（5 战 4 败），fast 短任务建议用 GLM-flash/k3

## 0.3.4 (2026-09-02)

- **高 stakes critic 回滚 v4-pro**（A/B 双跑实证）：52 目录 3 个历史难评审任务双跑 glm-5.3 vs v4-pro 单席 critic，四维评判（具体性/证据准确性/重要性/可操作性）**v4-pro 3:0 胜**——glm-5.3 胜率 0% 触发预设回滚判据（<60%）；deepModel 槽位移除，常规 critic 仍 GLM-flash 订阅不变
- navigator 交叉核查背书：题 1 glm 卡 PASS（6/6 属实）；题 3 v4-pro 卡 PASS（含一处"锚点可疑"批评被源码反证的自纠错记录）
- GLM-5.3 保留为 review-full 的 GLM 家族深审视角（roster 自带，非高 stakes critic 槽位）
- 调度矩阵单测 23/23 绿（高 stakes 断言改为两平面统一 v4-pro）

## 0.3.3 (2026-09-02)

- **GLM 评审席 spawn 常驻化**（用户裁定）：analyst/critic/reviewer-glm/reviewer-glm-flash 与矩阵 cheapModel/deepModel 槽位从 codex CLI 改回 DSH spawn 常驻（`zai-coding-cn` provider）——alpha.4 实证 GLM 直连 spawn 全流程（进程保留 + 席位自写卡 + DSH 工具面 read/grep/glob/read_image）
- executor 系列（executor-glm/executor-glm-flash/executor-codex）保持 codex CLI runtime：执行类任务需要其沙箱与工具链
- 评审席 spawn 化的收益：跨任务上下文接续（连续评审带上轮记忆）、卡片席位自写（非插件代写）、视觉材料席位可自行 read_image
- 调度矩阵单测 23 项全绿（评审席断言 runtime=undefined / provider=zai-coding-cn）

## 0.3.2 (2026-09-02)

- fix: package exports 开放 `./lib/*` 子路径——smoke.mjs 的 roster 探测此前因 `Package subpath './lib/roster.js' is not defined by "exports"` 而 FAIL（alpha.4 升级实测中发现，升级韧性流程起效）
- 实证记录（alpha.4 + v0.3.1）：三 DSH provider 通道全部跑通——GLM-5.3-flash/GLM-5.3/kimi-k3 fast 直连 ✅；GLM-flash spawn 常驻席位 moa 全流程（任务卡→结果卡→完成通知）✅；navigator 异步内控派发 ✅；smoke 5/5 ✅

## 0.3.1 (2026-09-02)

- 视觉辅助席（用户裁定）：有视觉材料的任务在 analyst 席（k3）之外追加 `vision-aux` 子代理（DeepSeek-V4-flash-vision-exp，官方多模态），与 k3 并行读图交叉核验；audit 等无 analyst 阵容不追加
- 新增 `roles/vision-aux.json`（角色自带模型，矩阵不覆盖）；describeMatrix 同步更新
- 调度矩阵单测 23 项（新增：vision-aux 出现条件 / review-full 末席追加 / audit 不追加）

## 0.3.0 (2026-09-02)

- 订阅优先调度矩阵（用户裁定）：常规=GLM-5.3-flash、高 stakes critic=GLM-5.3（dev 平面 v4-pro 不同源）、视觉/devil=kimi-k3；DeepSeek 仅补充（大上下文 devil/executor-pro/navigator）
- claude 不加入席位（用户裁定）：移除 reviewer-claude 角色与 claude CLI 席位通道；review-full 收敛为 4 席（GLM 双档 + k3 跨家族）
- 矩阵槽位修复：角色文件自带模型（executor-*/architect-k3/reviewer-*/navigator）不再被常规槽位覆盖；provider=codex 自动注入 runtime
- 视觉材料只换 analyst 席（k3 多模态），其余席位保持家族多样性
- fast 通道显式拒绝 codex provider（llm.stream 仅 DSH provider），报错带指引
- DeepSeek 峰价提示只在本次确有 DeepSeek 席位时出现
- 适配 dsh-v0.1.2-alpha.4（report→send_message 不影响席位卡协议；Session.events 移除不影响插件）
- 新增 scheduler 矩阵单测（review/high-stakes/视觉/大上下文/角色保留/review-full/峰谷）+ 派活跨版本兼容单测（followup/queuePrompt 双通道）

## 0.2.0 (2026-08-28)

- 常驻席位进程池：父会话隔离 / 互斥创建 / running-gate + 卡驱动完成 / 超时 interrupt / 冷恢复重续接（Sprint 1+2，codex/GLM 执行 + captain 监工）
- 自动调度矩阵：常规=v4-flash / 高 stakes=v4-pro / 视觉=vision-exp / devil 恒跨家族 k3；峰谷时段提示
- 异构 codex 席位（runtime:"codex"）：GLM 家族接入；ephemeral 一次性（连续性见 docs/continuable-codex-provider-issue.md 上游草案）
- navigator 在线化：收官按风险分层自动内控（全过/高 stakes 必审），navigator.md 核查卡
- 每席 reasoningEffort 自定义（DSH ≥0.1.2-alpha.1 双通道）
- 安全：realpath 双向 containment / 席位 slug 校验 / 统一脱敏管道 / moa_write_card 专用写卡工具 / 席位参数白名单
- 测试：node:test ×6（redact / safeRead / slug / card-tool）

## 0.1.0 (2026-08-27)

- 首版：roster 角色文件制 + moa 评审融合工具 + /moa 命令 + fast 通道（llm.stream 单发）

## 0.2.1 (2026-08-28)

- fix(privacy): redact 第 4 条正则（sk-/AKIA/ghp_/JWT）捕获组保留密钥原文 → 改非捕获组整体替换；补回归测试（8/8）
