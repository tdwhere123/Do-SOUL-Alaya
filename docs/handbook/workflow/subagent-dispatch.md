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
- the work is mechanical and codex's strong literal-execution profile
  matches the task.

Each dispatched codex instance receives the **Sub-Agent Contract**
from `agent-workflow.md` plus:

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

## Phase Worktree Control

For phase-level work, the main thread owns a dedicated phase controller
worktree. Sub-agents and codex instances work from that controller plan,
not from the main checkout.

- The controller worktree is created from the intended base branch
  before phase implementation starts.
- Worker worktrees, when used, branch from the same base or from a
  reviewed controller integration point named by the main thread.
- Shared files such as phase READMEs, closeout reports, package
  barrels, root manifests, and status docs remain under controller
  ownership unless explicitly assigned.
- Workers return their branch/worktree evidence to the controller. The
  controller serializes merges, resolves conflicts, and reruns
  integrated verification.
- The final phase result merges back to `main` only after review/fix
  closure and fresh gate verification. After that merge, the main
  checkout receives its own final verification before any phase gate is
  marked passed.

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
   `mcp-callable` / `host-worker-ready` / `cli-consumable` without
   integration evidence (violates R5). Especially watch for
   `agent-used` claims without a real host-driven proof.
6. **Barrel collision.** Two cards in the same wave both wrote to a
   barrel file; merge produced silent conflicts.
7. **Idempotent overwrite under deletion.** A repo's "upsert" path
   overwrote a row that should have been treated as deleted; the
   source uses a different lifecycle flag.
8. **EventLog reorder under retry.** Retry path appended EventLog
   after DB mutation, breaking the EventLog-first invariant.
9. **Audit-after-broadcast.** Consumer observed state before the
   audit row landed; violates audit-before-broadcast invariant.
10. **Naming-spec drift.** Card uses an npm name or path alias not
    listed in `docs/handbook/code-map.md §Package Naming`. Resolution:
    fix the card, or update code-map first if the name needs to
    change.
11. **Misleading availability docs.** A doc lists a command or
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

Resume only after the blocking condition closes through reviewer
mode.
