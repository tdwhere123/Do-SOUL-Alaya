# Phase 2 — Wave 2: Services + Garden + Repos + Security

Phase 2 ports the bulk of the memory subsystem: storage repositories,
core services (memory / evidence / signal / recall / green / governance
/ synthesis / proposal / output-shaping / narrative-budget /
manifestation / health-journal / event-publisher), the Garden engine
(Auditor / Janitor / Librarian / Scheduler / materialization-router /
bootstrapping), and the security defense stack (permission policy /
zero-day / worker safety / trust assessor / stance resolution /
constraint proxy).

This is the largest phase with ~30 cards and the highest parallelism
opportunity (20-25 codex instances).

## Card Groups

### 2A. Storage Repos (6 batches, 5-7 codex parallel)

| Card ID | Repos |
|---|---|
| P2-repos-batch-1 | memory-entry / evidence-capsule / synthesis-capsule / claim-form / event-log / health-journal |
| P2-repos-batch-2 | green-status / governance-lease / session-override / orphan-radar / memory-graph-edge / proposal |
| P2-repos-batch-3 | memory-embedding / global-memory-recall-cache / path-relation / path-graph-snapshot / activation-candidate / synthesis |
| P2-repos-batch-4 | workspace / run / engine-binding / project-mapping / extension-descriptor / tool-spec |
| P2-repos-batch-5 | slot / surface-state / signal / canonical-alias / constitutional-fragment / narrative-budget |
| P2-repos-batch-6 | event-publisher / runtime-event-normalizer / dynamics-constants / remaining repos |

### 2B. Core Services (independent cards, fully parallel)

| Card ID | Service | Approx LOC |
|---|---|---|
| P2-svc-memory | MemoryService | 624 |
| P2-svc-evidence | EvidenceService | 208 |
| P2-svc-signal | SignalService | 319 |
| P2-svc-recall | RecallService | 1157 |
| P2-svc-embedding-recall | EmbeddingRecallService | 744 |
| P2-svc-global-recall | GlobalMemoryRecallService | 274 |
| P2-svc-green | GreenService (ELIGIBLE/GRACE/REVOKED state machine) | 757 |
| P2-svc-governance-lease | GovernanceLeaseService | 408 |
| P2-svc-session-override | SessionOverrideService | 359 |
| P2-svc-synthesis | SynthesisService | 487 |
| P2-svc-proposal | ProposalService | 587 |
| P2-svc-output-shaping | OutputShapingService | 196 |
| P2-svc-narrative-budget | NarrativeBudgetService | 188 |
| P2-svc-manifestation | ManifestationResolver | 439 |
| P2-svc-health-journal | HealthJournalService + KarmaEventStore | 6.0K + 1.9K |
| P2-svc-event-publisher | EventPublisher + RuntimeEventNormalizer | ~10K |

### 2C. Garden Engine (4 batches, 4-5 codex parallel)

| Card ID | Garden roles |
|---|---|
| P2-garden-batch-1 | Auditor + GardenScheduler |
| P2-garden-batch-2 | Janitor + Librarian |
| P2-garden-batch-3 | materialization-router + related helpers |
| P2-garden-batch-4 | bootstrapping + remaining smaller roles |

### 2D. Security Defense Stack (2 codex parallel)

| Card ID | Services |
|---|---|
| P2-security-1 | PermissionPolicyService + ZeroDaySecurityLayer + ConstraintProxy |
| P2-security-2 | WorkerSafetyGate + WorkerTrustAssessor + StanceResolutionService + CrossCuttingPermissionService |

### 2E. Barrel update (sequential, end of Phase 2)

| Card ID | Subject |
|---|---|
| P2-barrel-protocol | Update `packages/protocol/src/index.ts` to export all ported types |
| P2-barrel-storage | Update `packages/storage/src/index.ts` to export all ported repos |
| P2-barrel-core | Update `packages/core/src/index.ts` to export all ported services |
| P2-barrel-soul | Update `packages/soul/src/index.ts` to export all ported Garden roles |

## Gate-2 Acceptance

- All Phase 2 cards land with reviewer-pass closure.
- All ported `__tests__/` pass for each touched package.
- Cross-package integration tests pass on producer → consumer paths
  inside core (e.g. MemoryService → EvidenceService → EventLog flow).
- Code-map and runtime-status updated.
- `pnpm build` succeeds for all packages.

## Parallelism Notes

- 2A repos can run all 6 batches in parallel **only after** P1-storage-
  shared landed.
- 2B services can run in parallel; serialize only on shared core/index
  barrel updates.
- 2C Garden batches can run in parallel.
- 2D security cards can run in parallel.
- 2E barrel-update cards are sequential and run last.
