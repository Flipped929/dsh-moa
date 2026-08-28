# Changelog

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
