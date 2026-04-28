# Phase 2 — Wave 2: Services + Garden + Repos + Security

Phase 2 ports the bulk of the memory subsystem: storage repositories,
core services (memory / evidence / signal / recall / green / governance
/ synthesis / proposal / output-shaping / narrative-budget /
manifestation / health-journal / event-publisher / runtime-event-
normalizer), the Garden engine (Auditor / Janitor / Librarian /
Scheduler / materialization-router / bootstrapping), the security
defense stack (permission policy / zero-day / worker safety / trust
assessor / stance resolution / constraint proxy), and the embedding
backfill pipeline.

This is the largest phase with 31 cards.

## Service Wave Ordering (within Phase 2B)

Per review B6, services have heavy interdependencies (ConversationService
imports nearly everything; even leaf services have small chains). To
avoid trivial-copy port-mode escalation, services land in dependency-
depth order:

```
Wave 2B.0 (foundation, mostly parallel): output-shaping, event-publisher,
                                         health-journal+karma
Wave 2B.0 follow-on: narrative-budget after event-publisher
Wave 2B.1 (depend on 2B.0, parallel up to 6): evidence, signal, memory,
                                              green, governance-lease,
                                              session-override
Wave 2B.2 (depend on 2B.1, parallel up to 4): recall, embedding-recall,
                                              global-recall, manifestation
Wave 2B.3 (depend on 2B.2, parallel up to 2): synthesis, proposal
Wave 2B.4: ConversationService is in Phase 3 (P3-conversation), not Phase 2
```

A service trivial-copy that finds its imports unsatisfied MUST return
`BLOCKED` rather than rewrite the import or self-degrade to
adapt-and-port.

## Card Groups

### 2A. Storage Repos (6 batches, integrated verification)

Per review B5, batch lists are corrected against the actual vendor
directory `vendor/do-what-new-snapshot/packages/storage/src/repos/`.
There are 42 real repo files; every repo file is owned exactly once.
The source tests cross-instantiate repos from other batches and several
tests import through the storage barrel, so the batches are owned as
separate card/report units but must be ported and verified on one
integrated storage branch with `P2-barrel-storage`.

| Card ID | Repos |
|---|---|
| P2-repos-batch-1 | memory-entry-repo, evidence-capsule-repo, synthesis-capsule-repo, claim-form-repo, event-log-repo, health-journal-repo, karma-event-repo |
| P2-repos-batch-2 | global-memory-repo, global-memory-recall-cache-repo, memory-embedding-repo, memory-graph-edge-repo, path-relation-repo, path-graph-snapshot-repo, orphan-radar-repo |
| P2-repos-batch-3 | workspace-repo, run-repo, engine-binding-repo, project-mapping-anchor-repo, extension-descriptor-repo, config-repo, file-repo |
| P2-repos-batch-4 | slot-repo, surface-identity-repo, surface-anchor-repo, surface-binding-repo, tool-spec-repo, tool-execution-record-repo, node-instance-repo |
| P2-repos-batch-5 | green-status-repo, drift-lease-repo, conflict-matrix-repo, cross-cutting-repo, strong-ref-repo, deferred-obligation-repo, dirty-state-dossier-repo |
| P2-repos-batch-6 | worker-run-repo, handoff-gap-repo, bootstrapping-record-repo, cascade-delete, garden-data-ports, signal-repo, proposal-repo |

Each batch card §2 lists exact source filenames and source tests.
Nonexistent stale names such as `session-override-repo`,
`activation-candidate-repo`, `synthesis-repo`,
`project-mapping-repo`, `surface-state-repo`,
`canonical-alias-repo`, and `narrative-budget-repo` are not used.

### 2B. Core Services (per Service Wave Ordering above)

| Card ID | Service | Approx LOC | Wave |
|---|---|---|---|
| P2-svc-output-shaping | OutputShapingService | 196 | 2B.0 |
| P2-svc-narrative-budget | NarrativeBudgetService | 188 | 2B.0 |
| P2-svc-health-journal | HealthJournalService + KarmaEventStore | 6.0K + 1.9K | 2B.0 |
| P2-svc-event-publisher | EventPublisher + RuntimeEventNormalizer redesigned without SSE transport (Alaya-internal listeners only, per invariant §11) | ~10K | 2B.0 |
| P2-svc-evidence | EvidenceService | 208 | 2B.1 |
| P2-svc-signal | SignalService | 319 | 2B.1 |
| P2-svc-memory | MemoryService | 624 | 2B.1 |
| P2-svc-green | GreenService (ELIGIBLE/GRACE/REVOKED state machine) | 757 | 2B.1 |
| P2-svc-governance-lease | GovernanceLeaseService | 408 | 2B.1 |
| P2-svc-session-override | SessionOverrideService | 359 | 2B.1 |
| P2-svc-recall | RecallService | 1157 | 2B.2 |
| P2-svc-embedding-recall | EmbeddingRecallService (recall-side query only) | 744 | 2B.2 |
| P2-svc-global-recall | GlobalMemoryRecallService | 274 | 2B.2 |
| P2-svc-manifestation | ManifestationResolver | 439 | 2B.2 |
| P2-svc-synthesis | SynthesisService | 487 | 2B.3 |
| P2-svc-proposal | ProposalService | 587 | 2B.3 |

### 2B'. Embedding Backfill Pipeline (NEW, per review I2)

| Card ID | Subject | Port mode | Closing label |
|---|---|---|---|
| P2-svc-embedding-pipeline | `packages/core/src/embedding-backfill-handler.ts`; daemon-side trigger wiring is deferred to Phase 4. Owns the producer-side handler for the embedding index so EmbeddingRecallService is not schema-only at Gate-2. | trivial-copy | implementation-ready |

### 2C. Garden Engine (4 batches, 4-5 codex parallel)

Per review I4, Garden cards must enumerate the
`garden-data-ports` and adapter wiring they consume. The Garden roles
themselves live in `packages/soul/src/garden/`; the adapter wiring
lives in `packages/storage/src/repos/garden-data-ports.ts` (handled
under P2-repos-batch-6) and in daemon glue (handled under P4
auxiliary). Each garden card §6 lists the adapter contract files it
depends on.

| Card ID | Garden roles |
|---|---|
| P2-garden-batch-1 | Auditor + GardenScheduler |
| P2-garden-batch-2 | Janitor + Librarian |
| P2-garden-batch-3 | materialization-router + degradation-pipeline + handoff-gap-handler |
| P2-garden-batch-4 | bootstrapping + session-override-remediation + backlog-telemetry + remaining smaller roles |

### 2D. Security Defense Stack (2 codex parallel)

| Card ID | Services |
|---|---|
| P2-security-1 | PermissionPolicyService + ZeroDaySecurityLayer + ConstraintProxy |
| P2-security-2 | WorkerSafetyGate + WorkerTrustAssessor + StanceResolutionService + CrossCuttingPermissionService |

### 2E. Barrel Updates (sequential, end of Phase 2)

| Card ID | Subject |
|---|---|
| P2-barrel-storage | Update `packages/storage/src/index.ts` to export every ported repo. |
| P2-barrel-soul | Update `packages/soul/src/index.ts` to export every ported Garden role. |

(`packages/core/src/index.ts` is updated by P3-core-barrel after
Phase 3, since P3 services also export through it.)

**Total: 31 cards.**

## Gate-2 Acceptance

- All Phase 2 cards close with reviewer-pass.
- All ported `__tests__/` pass for each touched package.
- Cross-package integration tests pass on the producer→consumer paths
  inside core (e.g. MemoryService→EvidenceService→EventLog flow).
- Garden cards pass the `Stateful Mutation Checklist` for Auditor /
  Janitor / Librarian (they mutate durable state).
- Code-map and runtime-status updated.
- `rtk pnpm build` succeeds for all Phase 2 packages.

## Parallelism Notes

- 2A repo files remain split into 6 ownership batches, but their
  upstream tests are not parallel-isolated. Port and verify the repo
  batches with `P2-barrel-storage` on one integrated storage branch.
  Batch 6 explicitly includes `garden-data-ports` (review I4), so 2C
  garden cards depend on batch-6 closing.
- 2B services follow the sub-wave ordering above; 2B.0 first.
- 2C garden batches wait for 2B.0 + 2B.1 (services that Garden
  consumes) AND batch-6 (garden-data-ports adapter).
- 2D security cards run in parallel anytime after Phase 1.
- 2B' embedding pipeline depends on 2B.2 EmbeddingRecallService.
- 2E barrel-update cards are sequential and run last.
