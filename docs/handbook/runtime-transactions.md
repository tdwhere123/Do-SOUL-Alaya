# Runtime transactions and recovery

This is the write-model companion to [architecture](architecture.md#runtime-write-model).
Statement order, durable commit, audit completion, projection readiness, and
notification delivery are different facts. There is no universal transaction
that includes SQLite, arbitrary callbacks, and in-process listeners.

## Commit models

| Owner / entry | Commit and identity | Failure / recovery | Visibility |
| --- | --- | --- | --- |
| `EventPublisher.appendManyWithMutation` | Append envelopes, then synchronous state mutation in the EventLog connection transaction. Caller owns CAS/request identity. | Append or mutation error rolls back both. Postcommit propagation failure retains the result and reports diagnostics. | Other SQLite connections see both after commit; notify follows commit. |
| `mutateThenAppendMany` | Synchronous decision/mutation, append derived envelopes, optional synchronous apply and further envelopes, all in one transaction. | Same rollback rule, including a late append failure. Empty events may represent an idempotent/no-op decision; this API alone does not prove that decision. | Mutation-before-append is not an independently committed receipt. |
| `decideAppendThenApply` | Decide idempotency under the write lock, append, apply using final envelope IDs. | A duplicate decision can return its existing result with no new envelopes. | Immutable assertions and their projections share the commit. |
| `appendManyWithMutationAndDetachPropagation` | Same atomic persistence as append-many; returns without awaiting listeners. | Detached work is tracked by the audited side-effect drain. Durable progress must not depend on listener completion. | Notification is best effort, not a durable outbox. |
| `publish` | One EventLog append; no associated DB mutation callback. | Propagation failure throws `EventPublisherPropagationError` carrying the committed envelope. Re-publishing creates another envelope, not notification-only retry. | EventLog-backed read models recover from the committed history. |
| `propagateCommitted` | No new state transaction; consumes already committed envelopes. | Records postcommit diagnostics rather than inviting mutation retry. Failure to persist the diagnostic itself is warned. | It cannot make an earlier non-atomic operation atomic. |
| Evidence / memory transaction owners | Synchronous EventLog transaction and storage in-current-transaction methods. | Evidence notification can return `CommittedObjectError`; never compensate it by deleting committed evidence. | The owning transaction, not use of the EventPublisher class, establishes atomicity. |

All atomic callbacks and repositories must use the same SQLite connection.
`SqliteEventLogRepo.transactional` uses an immediate write transaction; standalone
append serializes revision allocation or delegates to the write queue, whereas
append in a current transaction remains synchronous. A savepoint is not a durable
commit. `FieldAtomicOutcome` only attests a top-level commit; rejected, unknown,
committed-but-unready, and deferred are not interchangeable.

Native async callbacks are rejected before invocation. A synchronous function
returning a thenable is rejected and its rejection observed. Rollback cannot
cancel an already scheduled continuation or reverse an external effect. The
SQLite EventLog closed-scope guard rejects its late audit writes; it is not a
universal sandbox around arbitrary repository, filesystem, or network effects.
The actual mutate-then-append apply producers (karma transition and retention
decay) use synchronous storage methods, not async callbacks.

## Projection persistence

`createProjectionRebuildingFieldStores` commits each source/incidence mutation
and its `field_projection_rebuild_requests` upsert together. The effect-decision
store does the same for its receipt. There is no process-local dirty map standing
in for durable repair intent. A failed intent write rolls back its state write;
a later projection failure does not undo a committed source or effect.

`createSqliteFieldProjectionLifecycle` serializes request reread, source snapshot,
generation build/verification/activation, generation audit, and acknowledgement
in one immediate transaction per workspace. This prevents a same-clock writer's
request from being acknowledged by a rebuild that did not observe its state.
Generation identity is the sealed source/governance frontier plus its operator
contract; repeating an unchanged frontier does not append another activation.

Immediate mode drains after the wrapper's top-level commit. Explicit-checkpoint
mode retains durable intent until its checkpoint; startup drains existing intent
before installing the deferred wrapper. A direct field write inside another
owner's SQLite transaction can rebuild synchronously inside that transaction:
all projection/audit/ack writes then roll back with the outer transaction, and
there is no notification there. This is safe nested work, not a postcommit or
externally-ready assertion. `runAtomicWithOutcome` refuses that nested case.

Pinned readers use their admitted generation. Retained source existence does not
by itself certify projection readiness, currentness, source authorization, or
successful optional interpretation. Ordinary reads retain their existing
source-currentness, erase, and snapshot gates; no new global audit-presence gate
is imposed on retained sources.

## Independent receipt-first models

### Native source admission and replacement

`createAuditedSourceAdmission` commits the exact retained source/spans and durable
projection obligation, then independently calls `appendSourceRecordAdmitted`.
Its trusted daemon service capability is not an MCP write/retry handler. A
successful promise means this invocation's audit publication completed; a thrown
error is not evidence that source persistence rolled back. Source identity binds
source ID, version and content digest within workspace; replay also validates
retained body and immutable metadata. Retirement/erasure cannot be reversed by
replay.

The native source audit is **at least once**. On notification failure the known
envelope has committed; on append failure its status remains **unknown**, since
an adapter may fail after SQLite committed. Exact request retry reuses the source
receipt but may append another audit envelope. These are repeated audit attempts
for the same admission identity, not evidence of a second source transition.
Consumers must not count envelopes as distinct source admissions. There is no
generic startup source-audit sweeper. The trusted importer owns request retry;
notification-only recovery can use a known committed envelope rather than
republishing the request. No exactly-once notification guarantee is made.

`createAuditedSourceReplacement` separately reports rejected/unknown and committed
projection-unready/deferred, audit-incomplete, notification-failed, or ready.
Its expected-predecessor CAS is not a retry token after a successful replacement.
A caller with a known committed transition can checkpoint projection and replay
exact source admission to repair audit; it must not infer this invocation's
authorship from a later current-source read. Unknown outcomes remain unknown.
Later consumers revalidate currentness even after a ready result.

### Optional evidence formation

`createEvidenceCapsule` first commits the capsule, creation audit, and any
requested Garden enrichment intent atomically. Optional field formation then
commits minimum source/spans separately from factor formation. A factor failure
retains the minimum source; optional source-audit failure is warned and swallowed.
There is no automatic replay owner for this optional source audit. The committed
evidence and its creation audit remain valid; absence of the optional event is
not proof of source absence, completed formation, or audited native admission.
This path must not be described as guaranteeing eventual optional source audit.

### Host session capture

`createDaemonHostSessionCapture` has a stronger, independent recovery model:
message admission reserves immutable round membership/root identity under a
SQLite lock. Pending rounds retain their bodies and survive restart. Capture or
bounded idle sweep resumes exact receipt admission, then
`createHostSessionSourceAudit` checks/appends under one EventLog transaction,
rejects divergent payloads, and reuses an existing matching envelope. Only after
that does the ledger complete the round and permit statement-session closure.
An erased pending receipt can finish audit without restoring plaintext or
notifying source availability. Do not replace this ledger with native admission's
at-least-once contract.

### Causal usage and Garden

`createSoulResolveHandler` records usage after the resolution result, keyed by
that resolution audit event and each used object. `recordCausalUsedReceipts`
commits the whole usage set and its new audit envelopes atomically. Duplicate
usage retains its first `occurred_at`; delivery alone does not record usage.
Usage failure is returned as `usage_recording_status = failed`, not rollback of
the already committed resolution; retry can reuse its original audit identity.

Garden scheduler claim plus dispatch uses `claimGardenTaskWithEvents` with
storage CAS and the same transaction; CAS miss rolls back the dispatch envelope.
Host-worker claim without events is ownership transfer, not dispatch evidence.
Statement-session in-process processing commits claim first, then publishes
dispatch; interruption leaves the claim's TTL/reclaim owner, not an invented
dispatch event. Completion/quarantine use atomic state+audit. Confirmation
follow-up election has its own durable lease, completion marker and original
reviewer/delivery-bound retry; a committed confirmation is not election success.

## Notification and read models

The daemon `InProcessRuntimeNotifier` catches individual listener failures, warns,
and continues fan-out. EventPublisher diagnostics handle a failing notifier port
or hot-state apply; an individual daemon listener warning does not become an
EventPublisher failure. EventLog-backed governance lease/session-override caches
invalidate their epoch on propagation failure and rehydrate from history. None
of these mechanisms promises exactly-once delivery or cancels a hung listener.

## EventPublisher caller inventory

Paths below are relative to the indicated source root. Types, tests, benchmark
harnesses and unrelated objects' `publish` methods are not runtime producers.
Adapters are listed because their callers inherit the write model, not because
the adapter owns another transaction policy.

### Atomic append-before-mutation

- `packages/core/src/runtime/`: `runs/{run-service,workspace-service,engine-binding-service,project-mapping-service,workspace-bootstrap-coordinator}.ts`, `worker-run-lifecycle-service.ts`, `dirty-state-panic-service.ts`.
- `packages/core/src/governance/`: `claims/claim-service.ts`, `policy/{constitutional-fragment-service,deferred-obligation-service}.ts`, `proposals/arbitration-service.ts`.
- `packages/core/src/relations/edge-proposals/`: `edge-proposal-{service,minter,reviewer}.ts`, `path-relation-proposal-service.ts`.
- `packages/core/src/health/`: `green-service.ts`, `health-journal-service.ts`.
- `packages/core/src/surfaces/`: `slot-service.ts`, `surface-binding-service.ts`, `surface-drift-service.ts`; `packages/core/src/tooling/extension-registry-service.ts`.
- `apps/core-daemon/src/`: `trust/state.ts`, `services/config/{config-service,config-service-runtime}.ts`, `cli/install/keychain-install-garden-config.ts`.
- `apps/core-daemon/src/runtime/`: `startup/{embedding-backfill-recovery,runtime-database}.ts`, `recall-materialization/{recall-materialization-recall-runtime,recall-materialization-wiring}.ts`.
- `apps/core-daemon/src/garden/`: `bulk-enrich/source-enrichment-runtime.ts`, `scheduler/{embedding-backfill-checkpoint,scheduler-path-graph}.ts`, `runtime/{runtime-composition,runtime-core-support}.ts` adapters.
- `apps/core-daemon/src/mcp-memory/recall/recall-usage-telemetry.ts` (event-only payload batches, no state mutation).
- `packages/storage/src/repos/garden/`: `garden-task-repo.ts`, `garden-task-source-provenance.ts`, `writes/{garden-task-claim-with-events,garden-task-pending-failure}.ts` mechanical CAS adapters.
- `packages/soul/src/garden/maintenance/`: `auditor-core.ts`, `janitor.ts` through the daemon's publisher-backed audit port.

### Other atomic modes

- Mutate-then-append: `packages/core/src/dynamics/{karma-transition-engine,retention-decay-scanner}.ts`, `packages/core/src/governance/proposals/resolution-confirm-recovery.ts`, `apps/core-daemon/src/mcp-memory/usage/causal-usage-recorder.ts`.
- Decide-append-apply: `packages/core/src/{health/green-service,memory/signal-emission-writer,memory/source-interpretation-lifecycle,relations/relation-assertions/relation-assertion-service}.ts`; `apps/core-daemon/src/garden/scheduler/embedding-backfill-checkpoint.ts`.
- Detached propagation: `packages/core/src/memory/consolidation-executor.ts` (execute and rollback).
- Propagate already committed: `packages/core/src/{governance/bankruptcy/budget-bankruptcy-service,governance/proposals/garden-proposal-writer,memory/signal-service,memory/signal-materialization-outcome,memory/memory-service/memory-lifecycle-manager,tooling/mcp-tool-discovery-service}.ts`.

### Event-only publication

- `packages/core/src/conversation/`: `context-lens-assembler.ts`, `narrative-budget-service.ts`, `task-surface-builder.ts`.
- `packages/core/src/governance/`: `claims/canonical-alias-service.ts`, `policy/governance-lease-service.ts`, `proposals/{resolution-service,session-override-service}.ts`, `security/{constraint-proxy,integration-gate,security-status-service,worker-trust-assessor}.ts`.
- `packages/core/src/health/`: `garden-backlog-telemetry-service.ts`, `green-service-verification.ts`.
- `packages/core/src/`: `embedding-recall/embedding-recall-telemetry.ts`, `memory/signal-service.ts`, `memory/evidence-create/source-admission-audit.ts`, `relations/path-relations/graph-explore-service.ts`, `runtime/runtime-event-normalizer.ts`, `surfaces/surface-drift-service.ts`.
- `packages/core/src/dynamics/`: `dynamics-audit-events.ts`, `karma-transition-engine.ts` retain async-port branches; normal daemon wiring enforces shared SQLite identity and synchronous ports in `requireAtomicKarmaTransition`, so these branches do not replace its atomic path.
- `apps/core-daemon/src/`: `garden/bulk-enrich/bulk-enrich-runtime-runner.ts`, `garden/host-worker/host-worker-task-processors.ts`, `garden/runtime/{runtime-composition,runtime-core-support}.ts`, `services/soul/{soul-approval-service,soul-topology-audit-service}.ts`, `runtime/recall-materialization/recall-materialization-edge-reconciliation.ts`, `runtime/daemon/wiring/daemon-app-composition.ts` (explicit test-trigger adapter).

Additional synchronous transaction owners include memory/evidence/synthesis
writers using `runEventLogTransaction`, daemon source-grounding-defer transitions,
field projection lifecycle, and storage-backed proposal/bankruptcy writers.
Their notification adapters do not redefine the transaction owner.

## Boundary evidence

- [Projection intent, nested rollback, lock contention and deferred restart](../../apps/core-daemon/src/__tests__/runtime/field/field-composition-admission.test.ts).
- [Actual writer SIGKILL before independent source audit, then projection and audit recovery](../../apps/core-daemon/src/__tests__/runtime/field/field-projection-crash.test.ts).
- [Incidence rollback and generation visibility](../../apps/core-daemon/src/__tests__/runtime/field/field-composition.test.ts).
- [Source replay versus duplicate audit attempts](../../apps/core-daemon/src/__tests__/runtime/field/audited-source-admission.test.ts) and [replacement outcome distinctions](../../apps/core-daemon/src/__tests__/runtime/field/audited-source-replacement.test.ts).
- [Usage SQLite write/audit failures and notification failure](../../apps/core-daemon/src/__tests__/mcp-memory/usage/causal-usage-recorder.test.ts), [resolution consumer outcomes](../../apps/core-daemon/src/__tests__/mcp-memory/usage/soul-resolve-causal-usage.test.ts).
- [Async callback rejection, rollback and closed EventLog scope](../../packages/core/src/__tests__/runtime/event-publisher.sqlite.test.ts).
- [Host-session interrupted audit, competing capture and erase recovery](../../apps/core-daemon/src/__tests__/garden/host-session-recovery.test.ts).
- [Scheduler CAS](../../apps/core-daemon/src/__tests__/garden/garden-scheduler-sqlite.test.ts), [quarantine atomicity](../../apps/core-daemon/src/__tests__/garden/garden-task-quarantine-atomic.test.ts), [confirmation/election recovery](../../packages/core/src/__tests__/governance/confirm-election-recovery.sqlite.test.ts).
