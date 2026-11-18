# Runtime Transactions and Recovery

Write-model companion to [architecture](architecture.md#runtime-write-model).
Statement order, durable commit, audit completion, projection readiness, and
notification delivery are distinct states; no universal transaction spans
SQLite, arbitrary callbacks, and in-process listeners.

## Commit Models

| Owner / entry | Commit and identity | Failure / recovery | Visibility |
|---|---|---|---|
| `EventPublisher.appendManyWithMutation` | Appends envelopes, then runs synchronous DB mutation in one EventLog connection transaction; caller owns CAS/request identity. | Error in either rolls back both; post-commit propagation failure keeps state and reports diagnostics. | Other connections see both after commit; notify follows commit. |
| `mutateThenAppendMany` | Synchronous guarded mutation, derived envelope append, optional synchronous apply in one transaction. | Same atomic rollback (including late append failure); empty events alone do not prove idempotency. | Mutation-before-append is not an independent receipt. |
| `decideAppendThenApply` | Decides idempotency under write lock, appends, applies using final envelope IDs (e.g. signal emission, relation assertions, Green). | Duplicate decision returns existing result without new envelopes. | Assertions and projections share one commit. |
| `appendManyWithMutationAndDetachPropagation` | Same atomic persistence as append-many; returns without awaiting listeners. | Audited side-effect drain tracks detached work; durability never depends on listener completion. | Notification is best-effort, not an outbox. |
| `publish` / `propagateCommitted` | Single EventLog append (no DB callback) / propagation of already-committed envelopes. | `EventPublisherPropagationError` carries the committed envelope; re-publishing creates a new envelope rather than retrying notify. | EventLog-backed read models recover from committed history. |
| Evidence / memory transaction owners | Synchronous `runEventLogTransaction` + storage in-transaction methods. | Post-commit notification errors (`CommittedObjectError`) never compensate by deleting committed evidence. | The owning SQLite transaction, not the `EventPublisher` wrapper, establishes atomicity. |

All atomic callbacks must share the same synchronous SQLite connection
(`SqliteEventLogRepo.transactional` uses `IMMEDIATE`; savepoints are not durable
commits). Native async callbacks are rejected before invocation; bound/wrapped
thenables are rejected after invocation and observed. Closed EventLog scopes
reject late audit writes, while rollback cannot cancel arbitrary
external/filesystem side effects.

## Projection Persistence

- Projection-rebuilding field stores commit each source/incidence, evidence, or
  governing effect write together with its `field_projection_rebuild_requests`
  repair intent in one transaction.
- `createSqliteFieldProjectionLifecycle` serializes request reread, source
  snapshot, generation build/verification/activation, generation audit, and
  acknowledgement in one immediate transaction per workspace, preventing a
  same-clock writer's request from being acknowledged by a stale build.
- Immediate mode drains after top-level commit; explicit-checkpoint mode retains
  durable intent until checkpoint or startup drain. Nested synchronous rebuild
  inside an outer transaction rolls back with that outer transaction
  (`runAtomicWithOutcome` rejects nested calls).

## Independent Receipt-First Models

- **Native source admission & replacement:** `createAuditedSourceAdmission`
  commits retained source/spans and projection obligation, then calls
  `appendSourceRecordAdmitted` (**at-least-once** audit). Failed/unknown audit
  does not roll back retention; exact request retry reuses the source receipt
  (and never reverses retirement/erasure). `createAuditedSourceReplacement`
  separately distinguishes rejected/unknown, committed
  projection-unready/deferred, audit-incomplete, notification-failed, and ready
  outcomes.
- **Optional evidence formation:** `createEvidenceCapsule` commits capsule,
  creation audit, and enrichment intent atomically; optional field formation
  commits source/spans separately from factor formation, and optional
  source-audit failure is warned without automatic replay.
- **Host session capture:** `createDaemonHostSessionCapture` reserves immutable
  round membership/root identity under a SQLite lock; pending rounds survive
  restart and recover exact receipt admission via `createHostSessionSourceAudit`
  under one EventLog transaction before round completion and statement-session
  closure. Erased pending receipts finish audit without restoring plaintext.
- **Causal usage & Garden:** `createSoulResolveHandler` records
  `CausalUsageReceipt`s atomically after resolution via
  `recordCausalUsedReceipts`; failure reports `usage_recording_status = failed`
  without rolling back resolution. Garden scheduler claim + dispatch uses
  `claimGardenTaskWithEvents` + storage CAS in one transaction; host-worker MCP
  claim transfers ownership without emitting dispatch events; statement-session
  in-process work commits claim before dispatch audit (reclaimable by TTL on
  interruption).

## Notification and Read Models

`InProcessRuntimeNotifier` isolates listener failures via warnings so one
failing listener neither aborts fan-out nor rolls back committed mutations.
EventLog-backed governance lease and session-override caches invalidate their
epoch on propagation failure and rehydrate from history.
