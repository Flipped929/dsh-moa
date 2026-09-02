# Upstream Issue Draft — deepseek-harness

> 目标仓库：deepseek-harness（`@deepseek-ai/dsh-subagent-codex`）
> 状态：草案待提交（治理流程：G2 待审）

---

**Title:** `feat(subagent-codex): continuable mode — persistent app-server process + thread/resume for multi-turn seats`

## Summary

`@deepseek-ai/dsh-subagent-codex` currently runs every delegation as a fresh `codex app-server --stdio` process with an `ephemeral: true` thread. Two consecutive `start('codex', ...)` runs share no context (verified empirically on 2026-08-28: a fact planted in run 1 is invisible to run 2).

Meanwhile `codex exec resume --last` demonstrates that Codex itself supports session continuity, and the app-server protocol already exposes `thread/resume` (`ThreadResumeParams` / `ThreadResumeResponse` in `codex-rs/app-server-protocol/schema`).

Request: add an **opt-in continuable capability** to the codex provider so durable seats (MoA-style agent runtimes, long-running reviewer/executor roles) can keep their Codex thread across successive tasks.

## Current behavior

- Every `start()` spawns a new app-server process and calls `thread/start { cwd, ephemeral: true }`.
- The thread id stays private to the run and is never persisted; the run settles on the first `turn/completed`.
- The provider advertises no start-time capabilities and `inheritsParentContext: false`.

## Desired behavior

```ts
// new optional capability, off by default
subagents.startContinuable({
  provider: 'codex',
  label: 'moa-seat:executor-codex',
  request: { parent, prompt, /* … */ },
  signal,
})
// → durable childId bound to ONE persistent app-server process + ONE non-ephemeral Codex thread
subagents.followup(parent, childId, content, options) // DSH ≤0.1.2-alpha.3；≥alpha.4 为 Symbol.for('dsh.subagent.queuePrompt') 宿主通道
// → resumes/continues the SAME thread (thread/resume or turn/start on the retained thread id)
```

- Same task context accumulates across follow-ups (Codex-native continuity).
- `interrupt` maps to `turn/interrupt`; disposal terminates the process tree (existing escalation logic reused).

## Protocol support (verified)

- `thread/resume` params/response exist in the published app-server schema (codex 0.147.0).
- CLI-level precedent: `codex exec resume --last` recalls prior context correctly (verified).

## Proposal sketch

1. Keep a per-seat app-server process alive (keyed by durable child id) instead of per-run; reuse the existing process-tree ownership/termination tiers.
2. `thread/start` with `ephemeral: false` on first start; persist the thread id in the child descriptor.
3. `followup`（≤alpha.3）/ `queuePrompt`（≥alpha.4）→ `thread/resume` (cold path) or `turn/start` on the retained thread (resident path).
4. Lifecycle parity with spawn continuable children: residency eviction (persist → shutdown → reload on demand), `listChildren`/`listDescendants` compatibility.

## Backward compatibility

- One-shot `start('codex', …)` behavior unchanged (ephemeral stays the default).
- Capability-gated: deployments without the feature keep current semantics.

## Open questions

- Who owns the persistent process lifecycle budget (idle timeout / LRU eviction policy)?
- Error mapping for resumed threads (`contextWindowExceeded` etc.) — extend the existing stopReason mapping?
- Should the seat's Codex sandbox/approval config follow the delegating session's workspace, or remain host-config (`~/.codex/config.toml`)?

## Context

Downstream consumer: [dsh-moa](https://github.com/) — a Mixture-of-Agents runtime where seats are durable agents. GLM-family models are only reachable through Codex in this deployment, so continuable Codex seats are the only path to context-retained GLM workers.

（实证记录：DSH provider 两连 run 无上下文（NO_CONTINUITY）；CLI resume 有保留；协议有 thread/resume。详见 dsh-moa docs/agent-runtimes.md。）
