# Gate-4 attached-agent MCP proof — partial report

> Generated: 2026-04-30
> Authority: `docs/handbook/runtime-status.md:98-104` Gate-4 definition.

## What ran

Driven through `node bin/alaya.mjs <subcmd>` against the local worktree
(no remote daemon, no GUI):

| Step | Command | Result |
|---|---|---|
| 1 | `alaya doctor --json` | `overall=degraded` (provider not configured), startup ready, all 6 steps complete, MCP transport ready, garden healthy |
| 2 | `alaya status --json` | daemon up; both `codex` and `claude-code` trust rows in state `installed` |
| 3 | `alaya tools list --json` | 8 `soul.*` tools enrolled: `soul.recall`, `soul.open_pointer`, `soul.emit_candidate_signal`, `soul.propose_memory_update`, `soul.review_memory_proposal`, `soul.apply_override`, `soul.explore_graph`, `soul.report_context_usage` |
| 4 | `alaya tools call soul.recall '{"query":"hello","max_results":3,"scope_class":"project","dimension":"fact","domain_tags":[]}' --json` | OK; returned fresh `delivery_id` and empty result set (DB had no facts) |
| 5 | `alaya tools call soul.report_context_usage '{"delivery_id":"<id from step 4>",...}' --json` | **FAIL — `INTERNAL: Unknown delivery_id`** |

## Wiring gap (blocker for full Gate-4 close)

Each `alaya tools call …` invocation spawns a fresh daemon process and tears
it down on exit. `delivery_id` is in-process state (matches `#BL-018` /
`P4-trust-state` v0.1 in-process note in `docs/handbook/backlog.md:19`).
This means the recall→report_context_usage pair cannot be exercised through
single-shot CLI process invocations — the chain must run inside a single
attached-agent MCP session over the long-lived daemon transport.

**Consequence**: the spec'd Gate-4 demo path
(`docs/handbook/runtime-status.md:98-104`) requires a real attached agent
(codex or claude-code) consuming the MCP server with a persistent daemon.
That requires:

1. Real codex / claude-code installation with MCP attach.
2. A long-lived `alaya daemon` process — currently provided by Inspector
   server flow but not by the one-shot CLI flow.
3. Either: (a) a soak-style integration test harness that boots the daemon
   once and drives MCP calls in-process, or (b) the Gate-4 demo run is
   captured live with an actual attached agent.

## What this report DOES prove

- All 8 `soul.*` MCP tools are enrolled and reachable (item 3).
- `soul.recall` accepts the spec'd input shape and returns a delivery
  envelope (item 4).
- Daemon startup ordering, storage, garden, and MCP transport bootstrap
  are all green (items 1, 2).

## What this report does NOT prove (deferred)

- Cross-call delivery state (`recall → report_context_usage`).
- Candidate signal → proposal → governance reject → Garden background pass
  end-to-end across a single daemon lifetime.
- Real attached-agent (codex / claude-code) runtime invocation.

## Backlog impact

Add #BL-018 — "attached-agent MCP proof harness":
- Requirement: a test harness or scripted demo that spins up the daemon
  once, drives the full Gate-4 sequence in one process, captures stdout
  per step.
- Authority: §Gate Definitions in `docs/handbook/runtime-status.md`.
- Blocks: Gate-4 close.

Until #BL-018 is resolved, **Gate-4 cannot be closed end-to-end**, even
though P4-inspector-frontend (this card) is independently complete.

## Frontend-only Gate-4 close

P4-inspector-frontend AC1–AC8 + Reviewer Gate G1–G8 are all green via
`apps/inspector/web/scripts/gate-check.sh` and the vitest run. That card
flips to `live-event-ready` independently. Gate-4 itself remains
`pending` until #BL-018 closes.
