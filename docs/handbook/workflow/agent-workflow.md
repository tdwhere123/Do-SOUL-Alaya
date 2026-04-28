# Agent Workflow

This is the maintained execution workflow for task-card and phase-
planning work in Alaya v0.1. For parallel task work, repeated fix
loops, or wave-level coordination, also follow
[`subagent-dispatch.md`](./subagent-dispatch.md).

## Per-Card Pipeline

1. Read `docs/v0.1/INDEX.md`.
2. Read the relevant task card. If a phase is README-only, read the
   phase README and split a task card or get explicit user scope
   before implementing code.
3. Read `docs/handbook/invariants.md`.
4. Read `docs/handbook/port-protocol.md` (every Phase 1+ task card is
   a port).
5. Read the affected handbook pages.
6. Freeze scope from task card sections 2, 3, 4, and 5. For README-
   only phases, freeze only the relevant task row, key deliverables,
   cross-task constraints, and gate checklist.
7. For live-path or multi-package work, map the real producer and
   consumer path before dispatching a worker. If the task mutates
   durable state, runtime lifecycle, or live MCP / CLI surface state,
   run the Stateful Mutation Checklist before implementation and
   again before closeout.
8. Confirm the source files in `vendor/do-what-new-snapshot/` exist
   and match what the task card claims. If they do not, return
   `BLOCKED` with the missing paths.
9. Write or update tests first when practical. For port tasks, port
   the source `__tests__/` first, then port the implementation.
10. Implement the smallest change that satisfies the task card. For
    port tasks, copy first; rewrite is rejected (see
    `port-protocol.md`).
11. Verify using the task card section 6 commands. For README-only
    phase edits, verify against the phase gate checklist and run
    targeted documentation sweeps.
12. Write the completion report if the card requires one (under
    `docs/v0.1/<phase>-briefs/reports/`).
13. Run a targeted doc/code consistency sweep for changed contracts.

## Per-Wave Pipeline

1. Confirm every card has a clear `Prerequisite`, `Blocks`, `Depends`,
   and readiness level.
2. Execute independent cards in parallel only when write sets do not
   overlap. Cards that touch shared barrel files
   (`packages/*/src/index.ts`) MUST serialize through a barrel-update
   card.
3. Stop dependent workers when the prerequisite card is still under
   review or when shared-contract work is not yet green.
4. Review each card against architecture invariants and acceptance
   criteria.
5. Re-review every fix loop before merge; worker `DONE` is not an
   acceptance signal.
6. Update phase README status and reports after each completed card.
7. Do not mark a gate as passed without fresh evidence and a gate
   report.

## Task-Type Reading Matrix

Every task starts with the "Any" row. Add the matching row based on
task type. Use `rg`, `sed`, `head`, or `tail` for sectioned reads. Do
not read files larger than 30 KB in full.

| Task type | Minimum reading (in addition to "Any") |
| --- | --- |
| Any | `docs/v0.1/INDEX.md`, the relevant task card or phase README, `docs/handbook/invariants.md`, `docs/handbook/port-protocol.md`, this file, `docs/handbook/backlog.md` for the touched area |
| Backend port (`packages/protocol`, `packages/storage`, `packages/core`, `packages/soul`, `packages/engine-gateway`, `apps/core-daemon`) | `docs/handbook/code-map.md`, `docs/handbook/runtime-status.md`, the matching `vendor/do-what-new-snapshot/<source>` files, the upstream `vendor/do-what-new-snapshot/docs/handbook/code-map.md` |
| Docs / phase README / task brief | `docs/handbook/maintenance.md`, the relevant phase README, upstream and downstream phase READMEs that share the contract or readiness gate |
| Review | the diff or changed files, `docs/handbook/workflow/review-protocol.md`, the source file in `vendor/do-what-new-snapshot/` for port verification |

## Stateful Mutation Checklist

Run this checklist for tasks that change durable state, runtime
lifecycle, transport behavior, or live producer → consumer → MCP / CLI
paths. The goal is to catch lifecycle bugs before they escape into
review-fix tails.

- **EventLog-first:** confirm the touched write path, including any
  new error, rollback, compensation, or cleanup branch, still obeys
  append → DB mutate → broadcast. A task that does not emit new
  events must still prove its new branches do not bypass or reorder
  that sequence.
- **Audit-before-broadcast:** every state change records an audit row
  before any consumer (MCP tool reply, CLI output) can observe it.
- **Rollback / compensation:** identify which durable side effects
  must be undone if a later mutation step fails; fail-closed or
  compensate explicitly.
- **Delete / cascade:** verify parent deletion, descriptor removal,
  workspace teardown, or release flows do not leave orphan rows or
  false durable truth.
- **Idempotency / retry:** verify replay, retry, duplicate delivery,
  or "already gone" reads still settle to the correct state.
- **Shutdown / cleanup:** verify transports (MCP stdio / HTTP),
  runtime handles, background Garden refreshes, and temporary
  resources have an explicit teardown path.
- **Live proof:** satisfy R5 by citing an integration or end-to-end
  test that exercises the affected producer → consumer → surface
  path on real wiring (daemon, MCP transport, or cross-package
  integration harness). Unit-only proof does not clear this item.

## Anti-Tail Hard Rules

These rules exist because each tail pattern was observed in real task
execution (in upstream do-what-new and during the Alaya R1-R9 reset).
They are enforced at commit and review time.

**R1. Atomic review-fix commits with mandatory re-review.** All review
findings — Blocking, Important, and Nice-to-have — must land in a
separate commit with message shape `fix(<card-id>): <finding> [review
<severity>]` AND the fix commit body template from
[review-protocol.md](./review-protocol.md) §Fix Commit Body Template
(`Finding` / `Cause` / `Fix` / `Verify` / `Follow-up`). Subject-only
fix commits block closure. Fix commits must not be bundled into the
feature commit. Every fix commit goes through re-review before the
card closes.

**R2. Deferral requires a reopener issue.** A task card or completion
report may not list a deferred subsection without a numbered
`docs/handbook/backlog.md` issue and explicit acceptance criteria for
un-deferring.

**R3. Schema-only changes need a live consumer.** Any task that
introduces a new type, schema, enum, or wire contract must also
deliver at least one live consumer on the producer-consumer path in
the same task, or the task closes as `schema-ready` only.

**R4. Post-landing amendments need a docs-scoped commit.** Edits to a
task card or completion report after the closing commit must land as
a separate commit prefixed `docs(<card-id>):` that touches the card
and the report in the same commit. Silent amendments are forbidden.

**R5. Live-ready claims need integration evidence.** Claiming
`live-event-ready`, `mcp-consumable`, or `cli-consumable` requires
citing one integration or E2E test that exercises the producer →
surface path end-to-end. Unit-only evidence does not earn a live-ready
label.

## Discipline Rules

**D1. Fix-then-review closure.** Any fix addressing review or audit
findings must pass through reviewer mode a second time. A sub-agent's
`DONE` or `FIXED` never closes the loop. Pairs with R1.

**D2. End-to-end fix validation.** A fix is acceptable only if the
full producer → consumer → surface chain works. Silencing the local
error site without tracing the live path is not acceptance.

**D3. Verify-before-port.** Before authoring a port card, confirm the
source file exists at the cited `vendor/do-what-new-snapshot/` path
and that the source still matches what the task card describes.

**D4. Two-layer agent workflow.** For multi-card or parallel work, the
main thread freezes scope first, then dispatches sub-agents (or codex
instances). Each sub-agent implements one card; each card's
completion gate is a reviewer pass. See
[subagent-dispatch.md](./subagent-dispatch.md).

## Sub-Agent Contract

Sub-agents (including dispatched codex instances writing task cards)
should receive:

- exact task card path,
- scope boundaries,
- exact acceptance criteria that must hold on the live path,
- known producer and consumer or bootstrap path when relevant,
- allowed files or packages,
- required verification commands,
- architecture constraints from `invariants.md`,
- port-mode constraints from `port-protocol.md`,
- expected output format.

Sub-agents must not expand scope or rewrite future-phase contracts.
When a task cannot be completed without files outside the assumed
scope, the sub-agent must return `BLOCKED` with the exact missing
paths instead of silently shipping a foundation-only slice.

## Completion Report Minimum

Reports under `docs/v0.1/<phase>-briefs/reports/` must include:

- scope compliance,
- port mode used and which source files were copied,
- build and test evidence,
- architecture compliance,
- intentional deviations,
- deferred issues — each one must cite a backlog issue number (R2),
  or the report must state that nothing was deferred,
- follow-up readiness impact — any live-ready label must cite the
  integration or E2E test that earned it (R5),
- post-landing note — any later edit to the card or this report must
  land as a separate `docs(<card-id>):` commit (R4).
