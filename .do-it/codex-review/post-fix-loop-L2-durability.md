# Post-Fix-Loop L2 Durability Review (commit 91ac7d2)

Reviewer: independent adversarial (READ-ONLY). Implementer = codex.
Range verified: `a733583..91ac7d2` (single commit `fix(spine): close post-review loop`).
Scope: async durability / crash-window slice — assigned B4, B5, I3-runtime.
Numbering note: my B4 = the fix-loop report's "B1" (signal-ref durable retry handoff).

## Verdict summary

| Issue | Verdict | One-line |
| --- | --- | --- |
| B4 signal-ref durable/retryable | CLOSED | Single durable handoff (replay-or-inline-proposal) is mutually exclusive on every branch; replay is idempotent. One residual Important (poison-pill, pre-existing surface widened). |
| B5 memory-created audit atomicity | CLOSED | SOUL_MEMORY_CREATED append + row insert + enrich_pending enqueue are one better-sqlite3 transaction, EventLog-first, notify-after-commit. Regression proves no row/marker/event/notify on any sub-step throw. |
| I3 runtime drain cap | CLOSED (runtime truth) | 50 markers/workspace/cycle (`claim_batch_size`), 32 workspaces/pass (`BULK_ENRICH_DRAIN_CAP_PER_PASS`). Runtime matches what the report states; doc wording owned by Lens 4. |

---

## B4 — signal-ref transient mint failures durable/retryable: CLOSED

State machine (verified in source):
- Inline create branches (`materialization-router.ts:676`, `:859`, `:977`) each call
  `enqueueEnrichmentAfterCreate(memory, signal)` (`:673/:856/:974`) THEN
  `createAllMemoryRefEdgesBestEffort(memoryId, signal, isSignalRefRetryAvailable(memory))`.
- `isSignalRefRetryAvailable` (`:1082`) = `enrichmentEnqueued === true || enrichPendingPort !== undefined`.
- `createAllMemoryRefEdgesBestEffort` (`:1346`): retry-available → `throw_for_retry`; else `durable_proposal`.
  - `throw_for_retry` (`submitCandidatesFromSignalRefs:1334`) THROWS on `failed` → caught at `:1357`,
    swallowed (returns `[]`) only when `retryAvailable && hasMaterializableSignalMemoryRefs`, deferring to replay.
  - `durable_proposal` (`:1337`) creates exactly one fallback proposal via
    `createFailedSignalRefPathRelationProposal` (`:1372`); no replay lane exists in this mode.
- Garden replay: `garden-runtime.ts:1172-1186` replays persisted source-signal refs BEFORE
  `markProcessed` (`:1219`); per-row catch `releaseClaim` (`:1227`) keeps the row retryable.
- `replaySignalRefs` (`materialization-router.ts:478`) always uses `throw_for_retry` and never creates a fallback proposal.
- Daemon wiring: `index.ts:1369` (`enrichSourceSignalLookup.getById → signalRepo.getById`),
  `index.ts:1373` (`enrichSignalRefReplayPort.replaySignalRefs → materializationRouter.replaySignalRefs`).

### Adversarial checklist

1. DOUBLE side-effect (inline fallback proposal AND replay both write same path) — **SAFE, does not hold.**
   Mutual exclusivity is structural, not best-effort:
   - When `enrichPendingPort` is wired (the only config that has a replay lane), the inline path runs in
     `throw_for_retry` mode and therefore CANNOT call `createFailedSignalRefPathRelationProposal` (it throws
     before that line, `:1334`). The throw is swallowed; the marker drives the single replay handoff.
   - When `enrichPendingPort` is unwired, there is no replay lane, and the inline path runs in
     `durable_proposal` mode — the proposal is the only handoff.
   The marker the `throw_for_retry` branch relies on is guaranteed durable: each create branch first runs
   `enqueueEnrichmentAfterCreate`, whose enqueue is a synchronous (`EnrichPendingPort.enqueue: () => void`,
   `:365-372`) better-sqlite3 write that throws on failure (NOT warn-and-continue, see invariant comment
   `:1053-1062`), flipping the branch to `success:false` rather than leaving a marker-less row. So there is
   no window where the inline path defers (throws+swallows) yet no marker exists.
   Tests pin this: `materialization-router.test.ts:1381-1396` (refs fail, port wired → enqueue called,
   `createPathRelationProposal` NOT called, deferred-to-retry warn), `:1402-1415` (`replaySignalRefs` throws,
   no fallback proposal).

2. POISON PILL / permanent-`rejected` vs transient-`failed` — **mostly SAFE; one residual Important (B4-R1).**
   - `rejected` is terminal and never retries: produced by `validateObjectAnchors` BEFORE any write
     (`path-relation-proposal-service.ts:559-567`). A deleted/foreign/missing object → `rejected`. The router
     treats `rejected` as a clean quiet drop (no throw, no fallback proposal at `:1326` — only `failed` is handled).
     So a permanently-bad ref does NOT spin the claim forever. Verified by `garden-runtime-bulk-enrich.test.ts:686-690`
     (re-drain after a rejected memory claims nothing, no service re-invoked).
   - `already_present` (idempotency): replay of a ref already applied inline returns `already_present`
     (`materialize:534-548` via `findByAnchorMemoryId` + `pathRelationMatchesIdentity`,
     `protocol/src/soul/path-relation.ts:278-307`). It does NOT throw, so a partial inline write + replay does
     not duplicate. The replay re-submits with identical relation_kind / recallBias sign / object IDs, so the
     identity family matches. **Idempotency confirmed.**
   - RESIDUAL (Important, B4-R1): a ref that *persistently* returns `failed` (a true transient that never
     clears — e.g. a wiring fault that always throws, a never-clearing `SQLITE_BUSY`, or a sink that always
     throws on a specific input) will `throw_for_retry` every pass → `releaseClaim` → reclaim → forever, with
     NO attempt cap, NO backoff, NO dead-letter. `enrich_pending` has only `claimed_at`/`processed_at`
     (`enrich-pending-repo.ts:89-156`), no retry counter. This is a PRE-EXISTING property of the BULK_ENRICH
     no-drop seam (edgeProducer/conflictDetection already release-claim on transient failure), but this fix
     newly routes signal-refs through the same seam, widening the surface that can be stuck. See below.

3. CLAIM LEAK / lost work on crash after release / partial replay — **SAFE.**
   `releaseClaim` sets `claimed_at = NULL`, making the row immediately reclaimable; `reclaimStale`
   (`enrich-pending-repo.ts:148-156`, TTL 10 min) re-arms a claim stranded by a crash between
   `claimBatch` and `markProcessed`. A crash after release just leaves a claimable row; the next pass
   replays. Because replay is idempotent (item 2), partial-write-then-throw does not double-apply or drop.
   Verified `garden-runtime-bulk-enrich.test.ts:726-754` (replay throw → releaseClaim, NOT markProcessed,
   countPending stays 1).

4. ORDERING (replay-before-markProcessed; replay P then markProcessed throws → re-replay P) — **SAFE.**
   Replay runs before `edgeProducer`/`conflictDetection`/`markProcessed` (`garden-runtime.ts:1172-1219`).
   If any later step throws, the whole row is released and the next pass re-runs replay. Replay re-mint of an
   already-written path returns `already_present` (item 2), so no duplicate. `markProcessed` + the
   `UNIQUE(workspace,memory)` enrich_pending constraint also prevent re-drain duplication.

5. NEW crash windows (create → enrich_pending → claim → replay → markProcessed) — **SAFE.**
   - create→marker: atomic (single transaction, B5 fix). No window.
   - marker→claim: a marker with no claim is just claimable; reclaimStale/next pass picks it up.
   - claim→replay→markProcessed: crash anywhere leaves the row claimed; reclaimStale re-arms it; replay
     idempotent. No double-apply, no silent drop. The only residual is B4-R1 (no attempt cap), not a NEW window.

### B4 verdict: CLOSED. One residual Important carried below (B4-R1).

---

## B5 — memory-created audit atomicity: CLOSED

Verified consolidation:
- `memory-service.ts:243-256` builds the `SOUL_MEMORY_CREATED` event input (no longer appended up front).
- `createRowMaybeAtomicallyEnqueued` (`:289-350`): when the storage seam exists (production), runs inside
  `createWithinTransaction` with `beforeCreate` = `appendCreatedEventSynchronously` (EventLog row),
  then the row insert, then `afterCreate` = enrich_pending enqueue. All three in ONE better-sqlite3
  transaction (`memory-entry-repo.ts:365-377`: `connection.transaction(beforeCreate → runCreateStatement →
  afterCreate).immediate()`), committing in EventLog-first order or none.
- `notifyEntry(event)` runs at `:263`, AFTER `createRowMaybeAtomicallyEnqueued` returns = after commit.
- `appendCreatedEventSynchronously` (`:344-350`) hard-fails if the EventLog append is async, guaranteeing the
  audit row really commits inside the txn (production `SqliteEventLogRepo.append` is synchronous,
  `event-log-repo.ts:306`).

Adversarial:
- notify-before-commit anywhere? NO — only one create-path notify (`:263`), after commit. The other
  `notifyEntry` calls (`:446/:447/:502/:552/:675`) are archive/state-change/update lifecycle, unrelated.
- event reorder / changed success-path events? NO — exactly one `SOUL_MEMORY_CREATED` append exists
  (`:244`); the txn path (`:346`) and the non-atomic fallback (`:338`) are mutually exclusive branches, only
  one fires. Order is now `event_log → repo_create → enqueue → notify` (pinned by test).
- non-atomic fallback risk: the `eventLogRepo.append` then `memoryEntryRepo.create` fallback (`:337-339`)
  only runs when `createWithinTransaction === undefined` AND `enqueueEnrichment === undefined` — i.e. minimal
  test fakes. Production wires `SqliteMemoryEntryRepo` (`index.ts:257`) which implements
  `createWithinTransaction`, so production never hits the non-atomic branch. Confirmed.

Regression proving enqueue-failure leaves NO row / marker / memory-created event / notify:
- `memory-service.test.ts` success: `order === ["event_log","repo_create","enqueue","notify"]` +
  `appendEvents[0].event_type === "soul.memory.created"`.
- New: "rolls back the whole create when the EventLog append throws before the row insert" →
  `order === ["event_log"]`, `plainCreate` NOT called, `enqueueSpy` NOT called, `notifySpy` NOT called.
- Existing: "rolls back ... when the enrich_pending enqueue throws" → `notifySpy` NOT called.
The fakes simulate better-sqlite3 by propagating the throw; true rollback is the real
`connection.transaction(...).immediate()` in the SQLite repo.

### B5 verdict: CLOSED.

---

## I3-runtime — per-workspace drain cap: CLOSED (runtime truth)

- `DYNAMICS_CONSTANTS.enrich.claim_batch_size = 50` (`dynamics-constants.ts:113`); documented at `:98-100`
  as the max markers one BULK_ENRICH cycle claims+processes.
- `garden-runtime.ts:1154-1158`: `claimBatch(task.workspace_id, claim_batch_size, ...)` → at most 50
  rows per BULK_ENRICH task.
- One BULK_ENRICH task per workspace per ~60s pass (`enqueueBulkEnrichForAllWorkspaces` deduped via
  `bulkEnrichEnqueuedThisPass`, `:1630-1631`), and at most `BULK_ENRICH_DRAIN_CAP_PER_PASS` (32) tasks
  dispatched per pass (`:1640-1644`).
- Therefore: per-workspace per-pass drain ceiling = 50 markers; per-pass system ceiling = 32 workspaces.
  A workspace with 500 pending drains over ~10 passes (~10 min). The report's I3 runtime claim is accurate.
  (Doc wording in runtime-status.md is Lens 4's to verify; runtime behavior matches.)

### I3-runtime verdict: CLOSED.

---

## NEW finding (Important, B4-R1): no attempt cap / dead-letter on the enrich_pending retry seam

Severity: Important (starvation / poison-pill), NOT Blocking — does not corrupt truth or lose committed data.
Pre-existing for edgeProducer/conflictDetection; this fix widens it to signal-ref replay.

Boundary: BULK_ENRICH drain seam (`garden-runtime.ts:1162-1234`) + `enrich_pending` schema.
Root cause: `releaseClaim` resets `claimed_at = NULL` with no `attempt`/`failed_count` column
(`enrich-pending-repo.ts:89-156`), so a row whose replay/enrichment returns a *non-clearing* transient
`failed` is reclaimed and retried every pass forever. The clean permanent case (`rejected`) is already
terminal, so the realistic trigger is a persistent wiring/storage/sink fault or an input the sink always
throws on. Consequence: that workspace's BULK_ENRICH cap is partly consumed by the stuck row each pass
(it sits at the front of the oldest-first claimable order, `enrich-pending-repo.ts:107-112`), delaying
other markers behind it; if many such rows accumulate they can crowd the 50/pass budget.

Concrete fix (minimal): add an `attempt_count` (and optional `last_error`) column to `enrich_pending`;
increment on `releaseClaim`; once `attempt_count >= MAX_ATTEMPTS`, move the row to a terminal/dead-letter
state (`processed_at` set with a failed-audit marker, or a dedicated `dead_lettered_at`) and emit an
auditable event, so a permanently-stuck transient cannot starve the drain. Alternatively, classify the
distinction between "retryable transient" and "exhausted" at the worker and stop releasing past a cap.
This was out of the assigned fix's stated scope (the report explicitly scopes B4 to the durable handoff),
so flagging rather than blocking.

Missing test for B4-R1: a regression that enqueues a row whose replay always throws and asserts the drain
does not retry it unboundedly (caps attempts / dead-letters) — currently no such test exists.

---

## Facts verified (commands + results)

- `git log/diff --stat a733583..91ac7d2` — single commit; touched files match the assigned slice.
- `pnpm exec vitest run --project @do-soul/alaya-core-daemon .../garden-runtime-bulk-enrich.test.ts` → 20/20 pass.
- `pnpm exec vitest run --project @do-soul/alaya-soul .../materialization-router.test.ts` → 62/62 pass.
- `pnpm exec vitest run --project @do-soul/alaya-core .../memory-service.test.ts` → 27/27 pass.
- Cited tests read and confirmed non-vacuous (assert ordering, no-fallback-on-replay, releaseClaim-not-markProcessed,
  rollback-leaves-nothing).
- Source confirmed: `EnrichPendingPort.enqueue` is synchronous void; `SqliteEventLogRepo.append` synchronous;
  `SqliteMemoryEntryRepo` wired in production with `createWithinTransaction`; single SOUL_MEMORY_CREATED append;
  `pathRelationMatchesIdentity` family+pair identity makes replay idempotent; `rejected` is pre-write terminal.

## Unknowns / not run
- Did NOT run full suite (WSL2 cap; parallel reviewers). Only the three cited package-scoped test files.
- Did NOT run the benchmark or any live daemon. The `reclaimStale` 10-min TTL and the 32/50 caps are confirmed
  by source/constants, not by a live multi-workspace backlog run.
- B5 real (not faked) rollback relies on better-sqlite3 `transaction().immediate()` semantics; verified by code
  shape, not by an integration test exercising a real on-disk SQLITE_BUSY.

## Stop reason
All assigned issues verified to source + passing cited tests; one residual Important (B4-R1) documented.
Stopping at the actionable boundary per scope.
