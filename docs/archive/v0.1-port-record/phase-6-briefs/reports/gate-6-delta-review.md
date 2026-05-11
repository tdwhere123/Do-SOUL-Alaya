# Gate-6 Delta Review (Codex Lens + 3 Claude Lenses)

**Date:** 2026-05-06
**Branch:** `worktree-review-phase-6-delta`
**Baseline:** Gate-6 closeout (`gate-6-closeout.md`, commit `0405d1a`)
**Lens drafts (worktree-only, not committed):**
`.do-it/findings/p6-delta/{codex-lens,red-team-lens,reviewer-lens,spec-lens}.md`

## Why This Pass Exists

Gate-6 closed Phase 6 with five lenses (spec / correctness / red-team /
domain-language / install) reporting **zero Blocking + zero Important**.
That pass did **not** include an independent Codex lens, which is the
team's standing requirement for multi-lens reviews. This delta pass adds
Codex (`codex:codex-rescue`) plus three fresh Claude lenses
(`red-team-reviewer` / `reviewer` / `spec-compliance-reviewer`) targeting
eight risk surfaces identified during planning.

## Headline Result

| Severity      | Gate-6 closeout | Delta pass |
|---------------|-----------------|------------|
| Blocking      | 0               | **1**      |
| Important     | 0               | **5**      |
| Nice-to-have  | 0               | **4**      |

The delta pass **contests** the Gate-6 zero-Blocking/zero-Important
verdict. Codex and reviewer-lens both flagged that two Phase-6
acceptance claims (cross-surface parity; cwd-workspace concurrent first
registration) are under-tested rather than proven; red-team-lens
discovered a fresh authorization defect in the MCP-stdio path that the
Gate-6 red-team round did not surface; and red-team-lens additionally
exposed a cross-proposal write-skew window plus a Garden→EventLog gap.

## Confirmed Clean Across Multiple Lenses

These surfaces were re-checked and held up — recording them so future
review-loops do not re-litigate:

- **§31 single-transaction atomicity for per-proposal accept→apply**
  — `packages/storage/src/repos/proposal-repo.ts:876-981` runs proposal
  pending-CAS, workspace match, archived guard, four EventLog inserts,
  proposal state flip, and the memory mutation inside one
  `db.connection.transaction(...)` body. Process-crash mid-tx leaves
  proposal pending and memory unchanged. Confirmed by red-team + spec +
  reviewer.
- **§10 audit-precedes-broadcast for new SOUL_REVIEW_* /
  SOUL_PROPOSAL_RESOLVED events** — events commit to EventLog before
  `runtimeNotifier.notifyEntry` fires
  (`apps/core-daemon/src/mcp-memory-proposal-workflow.ts:364-366`).
  Confirmed by red-team + spec.
- **Workspace binding for `soul.{recall, open_pointer, list_pending_proposals,
  explore_graph, report_context_usage, apply_override,
  propose_memory_update, review_memory_proposal}`** — all bind workspace
  from `McpMemoryToolCallContext`; payload `workspace_id` is absent
  from these tools' MCP schemas
  (`packages/protocol/src/soul/mcp-types.ts:100-194`). Confirmed by spec
  + red-team.
- **§19 no production caller of `memoryService.update` outside
  proposal-accept** — grep across `packages/`+`apps/` finds zero
  non-test callers; durable mutation only flows through
  `proposalRepo.acceptPendingMemoryUpdateWithEvents`. Confirmed by
  reviewer.
- **§21a exact agent surface count** — exactly 9 `soul.*` MCP tools
  (`apps/core-daemon/src/mcp-memory-tool-catalog.ts:4-12`) and exactly
  13 alaya CLI verbs (registered across `cli/register.ts:44-103`).
  Inspector binds `127.0.0.1` only and is unreachable from MCP/CLI
  agent flow. Confirmed by spec.
- **`alaya tools call --json` review-impersonation guard**
  (`cli/tools.ts:82-90`) and **`alaya review` env-spoof resistance**
  (`cli/review.ts:378-408`) — both deliberately ignore
  `ALAYA_AGENT_TARGET`. Confirmed by red-team.
- **Garden auto-start idempotence** — `daemon-runtime-lifecycle.ts:49-68`
  guards on `backgroundStarted`; multiple attached agents do not double
  start. Confirmed by red-team.
- **cwd-derived `workspace_id` determinism** —
  `local_<sha256(path.resolve(cwd)).slice(0,16)>` is process-stable
  (`apps/core-daemon/src/cli/workspace-context.ts:111-114`). Confirmed
  by reviewer + codex.

## Blocking

### B1 — `alaya mcp stdio` accepts `ALAYA_AGENT_TARGET` from env, defeating run-scope binding for proposal review
**Source lens:** red-team
**Invariant:** §29 (default scope must come from trusted context)

**Threat scenario.** An attacker who controls the launching environment
(operator misconfig, prompt-injection convincing the user to set the
env, malicious wrapper around the `alaya` binary that re-exports it)
starts MCP stdio with `ALAYA_AGENT_TARGET=cli`. From inside the attached
LLM, `soul.review_memory_proposal` then sees
`context.agentTarget === "cli"`, which is in
`HUMAN_REVIEWER_AGENT_TARGETS`. Combined with `runId: null`,
`assertProposalContext` returns early at the
`isHumanReviewerSurface && runId === null` branch and skips the
`scopedProposal.run_id === context.runId` check entirely. The agent
can accept any pending proposal in its workspace, regardless of
which run created it.

**Evidence.**
- `apps/core-daemon/src/cli/register.ts:226` —
  `agentTarget: ctx.env.ALAYA_AGENT_TARGET ?? "mcp"`. No allowlist.
- `apps/core-daemon/src/mcp-memory-proposal-workflow.ts:485-488` —
  `HUMAN_REVIEWER_AGENT_TARGETS = new Set(["inspector", "cli"])`.
- `apps/core-daemon/src/mcp-memory-proposal-workflow.ts:568-571` —
  human-reviewer + null runId branch returns without comparing
  `scopedProposal.run_id` to `context.runId`.
- Counter-pattern that protects the other surfaces:
  `apps/core-daemon/src/cli/review.ts:378-408` (deliberately ignores
  the env, pins `agentTarget = "cli"`),
  `apps/core-daemon/src/cli/tools.ts:82-90` (rejects
  `agentTarget ∈ HUMAN_REVIEWER_AGENT_TARGETS` for `tools call`).
  Only the MCP stdio path leaks the env.

**Fix direction (no code in this report).** Treat the MCP stdio surface
as untrusted by construction. Drop the env fallback in `register.ts:226`
and pin `agentTarget` to a non-human value (`"mcp"` or
`"agent-attached"`). If a future surface needs to override it, do so
through a typed, audited path. Defense-in-depth: reject any
`agentTarget ∈ HUMAN_REVIEWER_AGENT_TARGETS` inside
`runAlayaMcpStdioServer` / `mcp-server.ts` before forwarding to the
handler. Per §30, fix at the boundary that constructs the call context,
not at every caller of `assertProposalContext`.

## Important

### I1 — Cross-proposal lost-update on the same `memory_entry` (no version CAS in the apply transaction)
**Source lens:** red-team
**Invariant:** §31 (single-source concurrency)

**Threat scenario.** Two pending proposals A and B both target memory
entry `M` (A proposes `content="X"`, B proposes `content="Y"`, both
based on `M=V0`). Reviewer accepts A (M becomes `V1`). Reviewer accepts
B back-to-back. The workflow's pre-validation (`prepareAcceptedProposalApply`)
runs **outside** the storage transaction, reading `M` and running
`validateUpdate` against whatever it observed. Inside the transaction,
the storage layer only re-checks workspace and lifecycle_state — it
does **not** verify that `M` is still at the version the proposal was
written against. B's accept overwrites A's applied content with `Y`,
even though B's `proposed_changes` were a delta from `V0`.

**Evidence.**
- `apps/core-daemon/src/mcp-memory-proposal-workflow.ts:395-441`
  (`prepareAcceptedProposalApply`) runs `findByIdScoped` and
  `validateUpdate` outside the SQLite transaction.
- `packages/storage/src/repos/proposal-repo.ts:876-981`
  (`acceptPendingMemoryUpdateWithEvents`) opens the transaction at line
  876, fetches the memory row at 886-895, but only checks `workspace_id`
  (896-901) and `lifecycle_state` (902-907). No version / `updated_at`
  baseline check.
- `packages/storage/src/repos/proposal-repo.ts:1115-1134`
  (`assertAcceptedMemoryUpdateMatchesProposal`) compares
  `proposed_changes` between the proposal row and the input —
  proposal-vs-input — but never proposal-vs-current-memory-state.
- Mitigated *in-process* today by better-sqlite3's single-connection
  serialization, but the workflow's pre-validation phase is the brittle
  surface: any future async pre-step (embedding regen, evidence
  verification) that yields would open a real race window.

**Fix direction.** Carry the memory's `updated_at` (or a monotonic
version column) read during pre-validation through to the transaction
body, and add it as a CAS predicate to the
`UPDATE memory_entries ... WHERE object_id = ? AND updated_at = ?`
statement. On `changes === 0`, throw a `CONFLICT` the workflow
normalizes to `VALIDATION` so the reviewer sees "the proposal was made
against a stale snapshot; re-review required". Alternative (broader UX
impact): forbid two concurrent pending proposals against the same
`target_object_id` at proposal-creation time.

### I2 — Proposal-review parity is only proven for the happy-path accept (cross-surface error envelope unverified)
**Source lenses:** codex + reviewer (independent agreement)
**Invariant:** §19 / Gate-6 acceptance claim

**Evidence.**
- `apps/core-daemon/src/__tests__/proposal-review-parity.test.ts:39`
  defines a single parity case; `:109` asserts Inspector success;
  `:123` asserts CLI success; `:124` asserts the accepted response
  shape; `:197` leaves the reject path as
  `throw new Error("reject path not exercised in this test")`.
- The error envelope `{code, message}` is structurally shared because
  all three surfaces route through the same `mcpMemoryToolHandler.call`
  (`apps/core-daemon/src/mcp-memory-tool-handler.ts:571-585`,
  `apps/core-daemon/src/routes/proposals.ts:107-123`,
  `apps/core-daemon/src/cli/review.ts:185-199`). But the workflow
  branches that should fire under error are unverified at the parity
  boundary:
  - `proposal_id` not found → workflow throws `NOT_FOUND`
    (`mcp-memory-proposal-workflow.ts:257-258`)
  - target memory missing in workspace → `NOT_FOUND` (`:421-426`)
  - `validateUpdate` rejection → `CoreError("VALIDATION", ...)` from
    `packages/core/src/memory-service.ts:277,586`, classified by
    `mcp-memory-tool-handler.ts:599-622`
  - already-accepted/already-rejected → `VALIDATION` (`:262-263`)

**Why important.** Gate-6 closeout claims "MCP/CLI parity proven";
that is currently only the success path. A regression on either
inspector route, cli/review, or the workflow could ship without the
parity test catching it. Codex framed this as contesting the Gate-6
zero-Important claim; reviewer framed it identically.

**Fix direction.** Extend `proposal-review-parity.test.ts` with at
least four table-driven cases — invalid proposal_id, missing target
memory, validateUpdate rejection (archived memory and empty content),
already-accepted — driving all three surfaces (MCP, Inspector HTTP,
CLI) and asserting `error.code` and `error.message` are identical
across surfaces. Per-surface transport severity (CLI exit code, HTTP
status) can differ by design (Unix sysexit vs HTTP semantics) — assert
those are deterministic per surface, not equal across surfaces.

### I3 — cwd workspace first-registration concurrency is not proven against real storage
**Source lenses:** codex + reviewer (independent agreement)
**Invariant:** §31

**Evidence.**
- `apps/core-daemon/src/cli/workspace-context.ts:47,67` derives the
  implicit local workspace from `path.resolve(ctx.cwd)` and forwards it
  to `ensureLocalWorkspace`.
- `packages/core/src/workspace-service.ts:103-138` implements
  read-then-create with duplicate-error re-read.
- `packages/core/src/__tests__/workspace-service.test.ts:136-186` fakes
  the race symptom with sequenced `getById` mocks and a hand-built
  error object carrying `cause.message = "UNIQUE constraint failed:
  workspaces.workspace_id"`. There is no `Promise.all` against a real
  SQLite database.
- The duplicate-error detector at
  `packages/core/src/workspace-service.ts:426-434`
  (`isWorkspaceIdDuplicateCreateError`) string-matches against
  better-sqlite3's UNIQUE message, walking only one `cause` level —
  fragile against future storage re-wrapping or driver wording changes.
- The MCP-startup test at
  `apps/core-daemon/src/__tests__/cli-register.test.ts:112` mocks
  `ensureLocalWorkspace` outright and so cannot exercise the race
  either.

**Why important.** This is the exact race the Gate-6 closeout claims
fixed under MF-B5. The current test pins the symptom, not the race.
A real storage-backed concurrent test is what §31 demands.

**Fix direction.** Add an integration-level test (in
`packages/core/src/__tests__/workspace-service.test.ts` or
`packages/storage`) that uses a real `SqliteWorkspaceRepo` and
`EventPublisher.appendManyWithMutation` against a shared in-memory DB,
then runs `Promise.all([ensureLocalWorkspace(...),
ensureLocalWorkspace(...)])`. Assert: exactly one row in `workspaces`,
both calls return the same `workspace_id`, audit/event rows are not
duplicated or orphaned. Strongly consider replacing string-match
detection with a structured `code: "DUPLICATE_KEY"` from the storage
layer (closes nice-to-have N3 simultaneously).

### I4 — Garden Auditor / Janitor write durable rows without an EventLog row (pre-Phase-6 pattern, still active)
**Source lens:** red-team
**Invariant:** §8 (Garden state changes go through EventLog) and §10

**Threat scenario.** A reviewer or Memory Inspector subscriber reading
EventLog will see no record that Green was revoked or that a memory
entry's `storage_tier` changed. Phase-4-era pattern that survived
Phase-6 review without being closed.

**Evidence.**
- `packages/soul/src/garden/auditor.ts:110-115` — `revokeGreen` called
  without `publishEventLogMutation`.
- `packages/soul/src/garden/auditor.ts:404-419` —
  `renewGreenPassiveStable` / `requestActiveVerification` called
  without `publishEventLogMutation`. (Compare with `:190-218`, which
  correctly wraps `pointerHealPort.clearEvidenceRef` in
  `publishEventLogMutation`.)
- `packages/storage/src/repos/garden-data-ports.ts:223-240` —
  `demoteToWarm` runs a raw `UPDATE memory_entries SET storage_tier =
  'cold' ...` with no event row.
- `packages/storage/src/repos/garden-data-ports.ts:464-476` — direct
  UPDATEs on `green_statuses`.
- `packages/protocol/src/events/green-governance.ts:21-23` defines
  `SOUL_GREEN_GRANTED` / `SOUL_GREEN_PIERCED` /
  `SOUL_GREEN_GRACE_ENTERED` but no `SOUL_GREEN_REVOKED` /
  `SOUL_GREEN_RENEWED`. Even a "use EventPublisher" patch needs new
  event-type definitions first.

**Why important (not Blocking).** The defect pre-dates Phase 6 and
repairing it requires protocol-level event additions, which is a
non-trivial design change. But the Phase 6 review-loop explicitly asked
for a pass over Garden direct-write paths (the brief's area E), and
these are the live ones. Spec-lens did note the analogous handoff-gap
direct delete (`garden-runtime.ts:182-190`) but assessed it as
permissibly Tier-0 control-plane under §17 — that exception does **not**
extend to memory-tier or green-status writes, which are durable
business state.

**Fix direction.** Add `SOUL_GREEN_REVOKED`, `SOUL_GREEN_RENEWED`,
`SOUL_GREEN_GRACE_REQUESTED`, and `SOUL_MEMORY_TIER_CHANGED` event
types in `packages/protocol/src/events/`, then have Auditor /
greenMaintenancePort and Janitor / tieringPort write through
`eventLogRepo.appendManyWithMutation` (the pattern Auditor already uses
for pointer-heal and orphan-radar at `auditor.ts:190-218,289-302`).

### I5 — `soul.emit_candidate_signal` request schema still requires server-bound scope fields
**Source lenses:** red-team (rated Important) + spec + codex (both rated Nice-to-have)
**Invariant:** §29 (and §30 fix-at-source)

**Severity disagreement resolved as Important.** Spec and codex framed
this as runtime-correct-but-shape-inconsistent and rated it
Nice-to-have. Red-team framed it as a §29 hardening gap (the team
explicitly stripped these fields from `SoulExploreGraphRequestSchema`,
`SoulListPendingProposalsRequestSchema`, and the proposal/review
schemas; this one was missed) and rated it Important. We resolve as
**Important** because: (a) the §29 hardening pattern was applied
unevenly within Phase 6, (b) the schema teaches every attached LLM to
learn its workspace/run/surface and pass them back — which is precisely
the prompt-injection vector the brief said was being closed, (c) the
fix is cheap, (d) leaving the field exposed is a future-regression
foot-gun (someone forgets to override after the spread).

**Evidence.**
- `packages/protocol/src/candidate-memory-signal.ts:91-105`
  (`CandidateMemorySignalInputSchema`) declares `workspace_id`,
  `run_id`, `surface_id` as required strict-mode fields.
- `packages/protocol/src/candidate-memory-signal.ts:107` re-exports it
  unmodified as `EmitCandidateSignalRequestSchema`.
- `packages/protocol/src/soul/mcp-types.ts:204` republishes that
  schema for the MCP tool.
- `apps/core-daemon/src/mcp-memory-tool-handler.ts:307,312-320`
  rejects missing trusted-context runId and overrides payload scope
  with trusted context — runtime is secure but accepts spoofed values
  into the parsed request first.
- Compare to the hardened pattern at
  `packages/protocol/src/soul/mcp-types.ts:103-109,180-194`
  (deliberately omits workspace_id).
- The Phase-6 proof at
  `apps/core-daemon/src/__tests__/phase6-agent-use-protocol.test.ts:172-175`
  sends matching values rather than proving mismatched payload scope is
  ignored.

**Fix direction.** Fork an MCP-facing input schema from the internal
`CandidateMemorySignalInputSchema` that omits `workspace_id`, `run_id`,
`surface_id`. Keep the internal schema (used by signal-service callers
that already know workspace/run) intact. The handler synthesizes scope
fields from the trusted context only.

## Nice-to-have

### N1 — MCP stdio `runId` is only validated at startup; later run lifecycle changes are ignored
**Source lens:** red-team
- `apps/core-daemon/src/cli/register.ts:209-218` calls
  `resolveTrustedCliRunId` once at MCP stdio start; the result is
  closed over by the `contextProvider` lambda for the lifetime of the
  stdio session.
- If the run later transitions to ended/cancelled (or is
  hard-deleted), every subsequent `soul.emit_candidate_signal`,
  `soul.apply_override`, etc. uses the stale `runId`.
- Today there is no enforced run lifecycle, so this is observational.
  Defer until run lifecycle becomes a first-class concept.

### N2 — `validateUpdate` evidence_refs check is racey across the workflow boundary
**Source lens:** red-team
- `MemoryService.validateUpdate`
  (`packages/core/src/memory-service.ts:260-279`) verifies
  `evidence_refs` exist *before* the storage transaction starts.
- If an evidence capsule is deleted between validateUpdate and the
  storage transaction commit, the update succeeds with stale
  `evidence_refs`. The in-tx body in
  `acceptPendingMemoryUpdateWithEvents` only revalidates workspace +
  lifecycle, not evidence existence.
- Move the evidence-ref existence check into the same transaction body
  as the memory update, or add a foreign-key constraint at the SQL
  level so the deletion order is forced.

### N3 — `isWorkspaceIdDuplicateCreateError` only walks one `cause` level
**Source lens:** reviewer (folded once I3's structured-code fix is adopted)
- `packages/core/src/workspace-service.ts:426-434` inspects
  `error.message` and `error.cause.message` only.
- A future intermediary that wraps the StorageError again moves the
  SQLite UNIQUE message two levels deep; the catch silently
  fail-throughs and re-throws a misleading "QUERY_FAILED" instead of
  doing the idempotent re-read.
- Surfacing a structured `code: "DUPLICATE_KEY"` from the storage
  layer (and re-using it in I3's fix) eliminates this brittleness.

### N4 — `MemoryService.update` is dead public API
**Source lens:** reviewer
- Grep across the entire monorepo finds zero production callers of
  `memoryService.update` (or `archive` / `transitionLifecycle`)
  outside test files.
- The method on `MemoryService`
  (`packages/core/src/memory-service.ts:210-258`) remains exposed and
  is wired into the proposalWorkflow type
  (`apps/core-daemon/src/mcp-memory-proposal-workflow.ts:144-148`) but
  is never invoked. A future agent wiring a "quick path" to it would
  bypass the proposal flow and break §19.
- Either remove `update` from `MemoryService`, or annotate `@internal`
  with a doc comment ("Do not call directly — use
  proposalRepo.acceptPendingMemoryUpdateWithEvents") and add a
  lint/runtime assertion.

## Disagreements vs Gate-6 Closeout

- **Gate-6:** "Round-3 red-team closed with zero Blocking/Important
  findings." **Delta:** Red-team-lens this round produced 1 Blocking
  (B1) and 3 Important (I1, I4, I5) on the same surfaces. Red-team
  coverage in Gate-6 did not include the agent-target env trust path
  (B1), the cross-proposal CAS gap (I1), the candidate-signal schema
  parity (I5), or the Garden green/tier direct-write paths (I4).
- **Gate-6:** "MCP/CLI parity proven." **Delta:** Codex and reviewer
  both flagged that parity is happy-path-only. The structural
  guarantee from a shared `mcpMemoryToolHandler.call` is real but
  does not substitute for an actual cross-surface error-envelope test
  (I2).
- **Gate-6:** "MF-B5 fixed: cwd workspace first-start concurrent
  registration is now idempotent." **Delta:** Codex and reviewer both
  confirmed the implementation is plausibly correct but the test does
  not exercise actual concurrency — symptom is faked with sequenced
  mocks and a hand-built error object (I3).

Spec-lens explicitly aligned with Gate-6 on Blocking/Important and
disagreed only on the schema-parity nice-to-have (which we promoted to
Important — see I5 rationale). Reviewer-lens explicitly endorsed the
§19 closure (no production caller of `memoryService.update`). Both lens
verdicts on the per-proposal accept transaction's atomicity and the
audit-precedes-broadcast ordering align with Gate-6's correctness pass.

## Recommended Next Step

Run `do-it-fix-loop` against this report. The five Important findings
break naturally into four atomic fix commits (I3 + N3 share a fix; I1
and I2 are unrelated test additions; I4 and I5 are unrelated source
edits) plus B1 as the first atomic fix commit. The fix-loop must
re-run the relevant lens after each commit and must end with
Blocking + Important = 0 in this report's successor. The four
Nice-to-have items are tracked here but do not block release-quality
acceptance for Gate-6.

Per the workflow rule against deferred backlog items, all Important
findings are expected to be closed in this delta-fix loop, not pushed
to v0.2 backlog.

## Methodology

- Worktree: `worktree-review-phase-6-delta` (off `main`)
- Lenses run in parallel:
  - `codex:codex-rescue` — independent adversarial review across all 8
    risk surfaces
  - `red-team-reviewer` — focus: txn atomicity, audit ordering,
    workspace binding, candidate-signal binding, Garden→EventLog
  - `reviewer` — focus: §19 bypass, §31 concurrency idempotence,
    parity error-paths
  - `spec-compliance-reviewer` — focus: invariants §8/§10/§19/§21a/§29/§31
- All four lenses were read-only on the codebase. No code was modified
  during this delta-review pass.
- Source lens drafts kept in worktree at `.do-it/findings/p6-delta/`
  for traceability; not committed.
- Cross-lens dedup performed by the parent agent — overlapping findings
  from distinct lenses (I2: codex+reviewer; I3: codex+reviewer; I5:
  red-team+spec+codex with severity disagreement) merged into single
  numbered entries with all source lenses cited.

## Follow-up wave (v0.1.1)

This delta review surfaced 4 structural concerns in
`.do-it/product-logic/agent-use-garden-config-diagnostic.md` (B-PL1,
B-PL2, I-PL1, I-PL2) that exceeded the spot-fix scope. Combined with
direct user UX feedback (Inspector graph centring, embedding error
visibility, recall returning empty results in cold-start), the
follow-up was scoped as the v0.1.1 *Memory Plane Coherence Wave* —
11 atomic slices across UX, Garden compute config split, recall
improvements, host-as-Garden-compute via SQLite-backed task queue, and
readiness-label honesty. See plan at
`/home/tdwhere/.claude/plans/phase-6-review-fluffy-sparrow.md` and
commit range `f4a522e..1f6fe35` plus the L1 docs commit.

Key v0.1.1 outputs that shift this report's claims:

- `mcp-consumable` is now the deprecated alias of `mcp-callable`. The
  Phase 6 readiness rows in `runtime-status.md` now read `mcp-callable`,
  with `agent-used` deferred to v0.2 under backlog
  `#BL-host-driven-autonomy-proof` (closes B-PL2 by relabeling, not by
  proving — the proof itself is deferred to v0.2).
- Garden compute is now `host-worker-ready` via H1+H2+H3 (SQLite queue,
  3 `garden.*` MCP tools, POST_TURN_EXTRACT routing). This closes B-PL1
  plus the structural truth-A gap (MCP-attached mode now has a
  daemon-side extraction path).
- doctor / status / Inspector now expose Garden compute provider truth
  (closes I-PL1 via slice C2).
- doctor surfaces attached profile instructions drift (closes I-PL2
  via slice C3).
