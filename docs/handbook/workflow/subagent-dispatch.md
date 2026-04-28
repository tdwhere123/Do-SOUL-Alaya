# Sub-Agent Dispatch and Rework Control

This page covers how the main thread coordinates parallel sub-agents
(claude-code subagents, codex instances, or any other dispatched
worker) and how it handles failure modes that show up across waves.

For per-card execution detail, see
[`agent-workflow.md`](./agent-workflow.md).
For review-time rules, see [`review-protocol.md`](./review-protocol.md).

## Two-Layer Workflow (D4)

The main thread:

1. Freezes scope before dispatching: the task card sections 2-5
   (Allowed Scope / Deferred / AC / Verification) are final at
   dispatch time. Any in-flight scope expansion must come back to the
   main thread first.
2. Writes or freezes the test contracts the sub-agent must satisfy
   (when the contract is non-obvious from the card).
3. Dispatches one card per sub-agent. The sub-agent does not pick
   work; the main thread assigns.
4. Reviews each card via reviewer mode (see
   `review-protocol.md`). A worker `DONE` is not acceptance.

The sub-agent:

1. Reads the task card and the minimum required handbook pages
   (Task-Type Reading Matrix from `agent-workflow.md`).
2. Returns `BLOCKED` with exact missing paths if the card cannot be
   completed within scope. Does not silently expand.
3. Implements the smallest change that satisfies the card.
4. Verifies via the card §6 commands.
5. Reports `DONE` with completion-report fields per
   `agent-workflow.md`.

## Dispatching Codex Instances

Codex (OpenAI Codex CLI) is available to the main thread as a
sub-agent runtime. Use it when:

- the work fits one card and the main thread does not need the
  context window to coordinate other things,
- multiple cards can run in parallel and the main thread wants to
  fan out,
- the work is mechanical port (trivial-copy heavy) and codex's strong
  literal-execution profile matches the task.

Each dispatched codex instance receives the **Sub-Agent Contract**
from `agent-workflow.md` plus:

- The exact source path under `vendor/do-what-new-snapshot/` for
  every file the card ports.
- The required port mode (`trivial-copy` / `adapt-and-port` /
  `requires-redesign`) and the §2 enumeration if non-default.
- The output destination (`packages/<x>/...` or
  `apps/core-daemon/...`).
- The list of shared files the card MUST NOT touch (barrels,
  workspace `package.json`, `tsconfig.base.json`).
- The verification commands that prove the card is done.

## Parallel Wave Execution

Within a Wave, only cards with **disjoint write sets** may run in
parallel. The Wave plan in `docs/v0.1/INDEX.md` enumerates the
exclusion table:

- Storage shared utils (`packages/storage/src/repos/shared/*.ts`)
  must complete before any storage repo card.
- Barrel files (`packages/*/src/index.ts`) are owned by a dedicated
  barrel-update card per package; no other card edits them.
- Migration sequence numbers are assigned by INDEX before dispatch;
  no two cards may claim the same number.
- The workspace root config (`package.json`, `tsconfig.base.json`,
  `vitest.workspace.mjs`) is touched only by Phase 0 cards or
  explicit follow-up cards reviewed at the wave gate.

When two cards collide on a write set, the second card BLOCKS and the
main thread serializes them.

## Failure Modes To Watch

The numbered list below seeds the `Cause Class` field of Review
Finding Records (`review-protocol.md`). Add a new mode when a
recurring failure pattern appears across two or more cards.

1. **Scope creep at dispatch.** Sub-agent expanded the file set
   beyond §2; not detected because reviewer trusted the report.
2. **Unanchored deferral.** Card deferred a subsection without a
   backlog issue number (violates R2).
3. **Schema-only landing.** Card introduced a new contract with no
   live consumer (violates R3); future card had to backfill.
4. **Bundled fix commit.** Review fix landed inside the feature
   commit or the wave-closing commit (violates R1).
5. **Live-ready over-claim.** Card claimed `live-event-ready` /
   `mcp-consumable` / `cli-consumable` without integration evidence
   (violates R5).
6. **Port-mode escalation without justification.** Card declared
   `adapt-and-port` or `requires-redesign` without enumerating
   adapter points or citing an Alaya invariant (violates
   `port-protocol.md`).
7. **Self-rewrite under trivial-copy.** Card declared `trivial-copy`
   but rewrote the function body or split helpers (the failure mode
   that triggered the v0.1 reset).
8. **Source path drift.** Card cited a `vendor/do-what-new-snapshot/`
   path that no longer exists or no longer matches the card text;
   reviewer must verify before accepting.
9. **Barrel collision.** Two cards in the same wave both wrote to a
   barrel file; merge produced silent conflicts.
10. **Idempotent overwrite under deletion.** A repo's "upsert" path
    overwrote a row that should have been treated as deleted; common
    in port adaptation when the source uses a different lifecycle
    flag.
11. **EventLog reorder under retry.** Retry path appended EventLog
    after DB mutation, breaking the EventLog-first invariant.
12. **Audit-after-broadcast.** Consumer observed state before the
    audit row landed; violates audit-before-broadcast invariant.
13. **Architecture-vs-port contradiction.** Port mode declared
    `trivial-copy` but the source file embeds an architecture detail
    (e.g. SSE) that an Alaya invariant forbids. Resolution: escalate
    to `requires-redesign` with §0 charter cite, or update the
    invariant if the detail is acceptable.
14. **Ported subsystem with no Alaya consumer.** Source code ported
    but no Alaya use case calls it (e.g. ConversationService chat
    paths). Resolution: adapt-and-port with explicit Adapter Points
    deleting the unused branches, or move to backlog.
15. **Naming-spec drift.** Card uses an npm name or path alias not
    listed in `docs/handbook/code-map.md §Package Naming`. Resolution:
    fix the card, or update code-map first if the name needs to
    change.
16. **Misleading availability docs.** A doc lists a command or
    capability as "available" but the implementing card has not
    landed. Resolution: annotate the doc with the gating phase or
    card.

## When To Stop A Wave

Halt the wave (do not dispatch the next card) when:

- A blocking finding from the prior card has not been re-reviewed
  through to closure.
- Two cards from the same wave produced incompatible contract
  changes (different field shapes for the same protocol type).
- The shared-utils or barrel-update card has not landed yet.
- The vendor snapshot moved (rare; see
  `docs/handbook/maintenance.md` Vendor Snapshot Maintenance).

Resume only after the blocking condition closes through reviewer
mode.
