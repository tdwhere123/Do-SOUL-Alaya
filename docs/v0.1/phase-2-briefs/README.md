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

This is the largest phase with ~30 cards.

## Service Wave Ordering (within Phase 2B)

Per review B6, services have heavy interdependencies (ConversationService
imports nearly everything; even leaf services have small chains). To
avoid trivial-copy port-mode escalation, services land in dependency-
depth order:

```
Wave 2B.0 (leaf, parallel up to 4): output-shaping, narrative-budget,
                                    health-journal+karma, event-publisher
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

### 2A. Storage Repos (6 batches, 5-7 codex parallel)

Per review B5, batch-6 was wrong (listed services as repos). Corrected
listing of all real repos (per upstream
`vendor/do-what-new-snapshot/packages/storage/src/repos/`):

| Card ID | Repos |
|---|---|
| P2-repos-batch-1 | memory-entry-repo, evidence-capsule-repo, synthesis-capsule-repo, claim-form-repo, event-log-repo, health-journal-repo |
| P2-repos-batch-2 | green-status-repo, drift-lease-repo, session-override-repo, orphan-radar-repo, memory-graph-edge-repo, proposal-repo |
| P2-repos-batch-3 | memory-embedding-repo, global-memory-recall-cache-repo, path-relation-repo, path-graph-snapshot-repo, activation-candidate-repo, synthesis-repo |
| P2-repos-batch-4 | workspace-repo, run-repo, engine-binding-repo, project-mapping-repo, extension-descriptor-repo, tool-spec-repo |
| P2-repos-batch-5 | slot-repo, surface-state-repo, signal-repo, canonical-alias-repo, constitutional-fragment-repo, narrative-budget-repo |
| P2-repos-batch-6 | deferred-obligation-repo, dirty-state-dossier-repo, strong-ref-repo, tool-execution-record-repo, worker-run-repo, node-instance-repo, handoff-gap-repo, cascade-delete, garden-data-ports, bootstrapping-record-repo |

Each batch card §2 lists exact source filenames; the batch grouping
above is a planning hint, not a contract. Card author verifies each
file exists in `vendor/do-what-new-snapshot/packages/storage/src/repos/`
during card writing.

### 2B. Core Services (per Service Wave Ordering above)

| Card ID | Service | Approx LOC | Wave |
|---|---|---|---|
| P2-svc-output-shaping | OutputShapingService | 196 | 2B.0 |
| P2-svc-narrative-budget | NarrativeBudgetService | 188 | 2B.0 |
| P2-svc-health-journal | HealthJournalService + KarmaEventStore | 6.0K + 1.9K | 2B.0 |
| P2-svc-event-publisher | EventPublisher + RuntimeEventNormalizer (no SSE — Alaya-internal listeners only, per invariant §11) | ~10K | 2B.0 |
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

| Card ID | Subject |
|---|---|
| P2-svc-embedding-pipeline | `packages/core/src/embedding-backfill-handler.ts` + the daemon-side trigger (deferred wiring to Phase 4). Owns the producer side of the embedding index so EmbeddingRecallService is not schema-only at Gate-2. | trivial-copy | live-event-ready |

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

## Gate-2 Acceptance

- All Phase 2 cards close with reviewer-pass.
- All ported `__tests__/` pass for each touched package.
- Cross-package integration tests pass on the producer→consumer paths
  inside core (e.g. MemoryService→EvidenceService→EventLog flow).
- Garden cards pass the `Stateful Mutation Checklist` for Auditor /
  Janitor / Librarian (they mutate durable state).
- Code-map and runtime-status updated.
- `pnpm build` succeeds for all Phase 2 packages.

## Parallelism Notes

- 2A repos can run all 6 batches in parallel **only after**
  P1-storage-shared landed. Batch 6 explicitly includes
  `garden-data-ports` (review I4), so 2C garden cards depend on
  batch-6 closing.
- 2B services follow the sub-wave ordering above; 2B.0 first.
- 2C garden batches wait for 2B.0 + 2B.1 (services that Garden
  consumes) AND batch-6 (garden-data-ports adapter).
- 2D security cards run in parallel anytime after Phase 1.
- 2B' embedding pipeline depends on 2B.2 EmbeddingRecallService.
- 2E barrel-update cards are sequential and run last.
