export { StorageError, type StorageErrorCode } from "./shared/index.js";
export { initDatabase, StorageDatabase, getCurrentSchemaSummary, type InitDatabaseOptions } from "./sqlite/index.js";
export {
  SqliteWorkspaceRepo,
  type WorkspaceCreateInput,
  type WorkspaceRepo
} from "./repos/workspace-repo.js";
export { SqliteRunRepo, type RunCreateInput, type RunRepo } from "./repos/run-repo.js";
export {
  SqliteEngineBindingRepo,
  type EngineBindingRecordCreateInput,
  type EngineBindingRepo
} from "./repos/engine-binding-repo.js";
export {
  SqliteEventLogRepo,
  type EventLogAppendInput,
  type EventLogRepo
} from "./repos/event-log-repo.js";
export { SqliteSignalRepo, type SignalRepo } from "./repos/signal-repo.js";
export {
  SqliteEvidenceCapsuleRepo,
  type EvidenceCapsuleRepo,
  type EvidenceCapsuleKeywordHit
} from "./repos/evidence-capsule-repo.js";
export {
  SqliteMemoryEntryRepo,
  type MemoryEntryRepo,
  type MemoryEntryRepoDynamicsUpdateFields,
  type MemoryEntryRepoTierUpdateInput,
  type MemoryEntryRepoUpdateFields
} from "./repos/memory-entry-repo.js";
export {
  DEFAULT_ACTIVE_CONSTRAINTS_CAP,
  MAX_ACTIVE_CONSTRAINTS_CAP,
  findActiveConstraints,
  normalizeActiveConstraintsCap,
  type ActiveConstraintQueryResult,
  type ActiveConstraintRecord,
  type ActiveConstraintSourceChannel
} from "./repos/active-constraints.js";
export {
  SqliteGlobalMemoryRepo,
  type GlobalMemoryRepo,
  type GlobalMemoryRepoListFilters
} from "./repos/global-memory-repo.js";
export {
  SqliteKarmaEventRepo,
  type KarmaEvent,
  type KarmaEventKind,
  type KarmaEventRepo
} from "./repos/karma-event-repo.js";
export {
  SqliteGreenStatusRepo,
  type GreenStatusRepo
} from "./repos/green-status-repo.js";
export {
  SqliteSynthesisCapsuleRepo,
  type SynthesisCapsuleRepo,
  type SynthesisCapsuleKeywordHit
} from "./repos/synthesis-capsule-repo.js";
export {
  SqliteEdgeProposalRepo,
  type EdgeProposalCreateInput,
  type EdgeProposalRepo,
  type EdgeProposalReviewInput
} from "./repos/edge-proposal-repo.js";
export {
  SqliteOrphanRadarRepo,
  type OrphanRadarRepo
} from "./repos/orphan-radar-repo.js";
export {
  SqliteClaimFormRepo,
  type ClaimFormRepo
} from "./repos/claim-form-repo.js";
export {
  SqliteProposalRepo,
  type AcceptedMemoryUpdateInput,
  type AcceptedPathRelationGovernanceInput,
  type PathRelationProposalPayload,
  type ProposalCreateInput,
  type ProposalResolutionEventInput,
  type ProposalRepo
} from "./repos/proposal-repo.js";
export {
  SqliteHealthJournalRepo,
  type HealthJournalCreateInput,
  type HealthJournalQueryParams,
  type HealthJournalRepo
} from "./repos/health-journal-repo.js";

export {
  SqliteSlotRepo,
  type SlotRepo
} from "./repos/slot-repo.js";

export {
  SqliteToolSpecRepo,
  type ToolSpecRepo
} from "./repos/tool-spec-repo.js";
export {
  SqliteToolExecutionRecordRepo,
  type ToolExecutionRecordRepo
} from "./repos/tool-execution-record-repo.js";
export {
  SqliteStrongRefRepo,
  type StrongRefRepo
} from "./repos/strong-ref-repo.js";
export {
  SqlitePathRelationRepo,
  type PathRelationRepo
} from "./repos/path-relation-repo.js";
export {
  SqliteCoUsageCounterRepo,
  type CoUsageCounterIncrementInput,
  type CoUsageCounterRepo
} from "./repos/co-usage-counter-repo.js";
export {
  SqliteEnrichPendingRepo,
  type EnrichPendingClaim,
  type EnrichPendingEnqueueInput,
  type EnrichPendingRepo
} from "./repos/enrich-pending-repo.js";
export {
  SqlitePathPlasticityWatermarkRepo,
  type PathPlasticityWatermarkRecord,
  type PathPlasticityWatermarkRepo
} from "./repos/path-plasticity-watermark-repo.js";
export {
  SqliteBootstrappingRecordRepo,
  type BootstrappingRecordRepo
} from "./repos/bootstrapping-record-repo.js";
export {
  SqlitePathGraphSnapshotRepo,
  type PathGraphSnapshotRepo
} from "./repos/path-graph-snapshot-repo.js";
export {
  SqliteExtensionDescriptorRepo,
  type ExtensionDescriptorRepo
} from "./repos/extension-descriptor-repo.js";
export {
  SqliteWorkerRunRepo,
  type WorkerRunRepo
} from "./repos/worker-run-repo.js";
export {
  SqliteDeferredObligationRepo,
  type DeferredObligationRepo
} from "./repos/deferred-obligation-repo.js";
export {
  SqliteDirtyStateDossierRepo,
  type DirtyStateDossierRepo
} from "./repos/dirty-state-dossier-repo.js";
export {
  SqliteConflictMatrixRepo,
  type ConflictMatrixRepo
} from "./repos/conflict-matrix-repo.js";

export {
  SqliteSurfaceIdentityRepo,
  type SurfaceIdentityRepo
} from "./repos/surface-identity-repo.js";

export {
  SqliteHealthIssueGroupRepo,
  type HealthIssueGroupRepo
} from "./repos/health-issue-group-repo.js";

export {
  SqliteSurfaceAnchorRepo,
  type SurfaceAnchorRepo
} from "./repos/surface-anchor-repo.js";

export {
  SqliteSurfaceBindingRepo,
  type SurfaceBindingRecord,
  type SurfaceBindingRepo
} from "./repos/surface-binding-repo.js";

export {
  SqliteDriftLeaseRepo,
  type DriftLeaseRepo
} from "./repos/drift-lease-repo.js";

export {
  SqliteReconciliationLeaseRepo,
  type ReconciliationLease,
  type ReconciliationLeaseRepo
} from "./repos/reconciliation-lease-repo.js";

export {
  SqliteCrossCuttingPermissionRepo,
  type CrossCuttingPermissionRecord,
  type CrossCuttingPermissionRepo
} from "./repos/cross-cutting-repo.js";

export {
  SqliteProjectMappingAnchorRepo,
  type AcceptedBy,
  type ProjectMappingAnchorRecord,
  type ProjectMappingAnchorRepo
} from "./repos/project-mapping-anchor-repo.js";
export {
  SqliteGlobalMemoryRecallCacheRepo,
  type GlobalMemoryRecallCacheRecord,
  type GlobalMemoryRecallCacheRepo,
  type GlobalMemoryRecallClassification
} from "./repos/global-memory-recall-cache-repo.js";
export {
  SqliteMemoryEmbeddingRepo,
  type MemoryEmbeddingRecord,
  type MemoryEmbeddingMetadata,
  type MemoryEmbeddingRepo
} from "./repos/memory-embedding-repo.js";
export {
  SqliteFileRepo,
  type FileRepo
} from "./repos/file-repo.js";
export {
  SqliteConfigRepo,
  type ConfigRepo
} from "./repos/config-repo.js";
export {
  SqliteTrustStateRepo,
  type TrustStateRepo
} from "./repos/trust-state-repo.js";
export { SqliteHandoffGapRepo } from "./repos/handoff-gap-repo.js";
// invariant: storage owns an independent jieba module-state instance (Package
// Dependency Direction forbids importing core's copy). Daemon and bench-runner
// MUST warm both core's and storage's segmenters at startup so the FTS query
// path never hits the loading-state fallback on the user-visible hot path.
// see also: packages/core/src/shared/cjk-segmentation.ts, apps/core-daemon/src/index.ts.
export {
  warmCjkSegmentation,
  segmentCjkRun,
  isCjkSegmentationCandidate,
  __resetCjkSegmentationStateForTests as __resetStorageCjkSegmentationStateForTests
} from "./repos/shared/cjk-segmentation.js";
export {
  createGardenBackgroundDataPorts,
  type GardenBackgroundDataPorts,
  type GardenDataPortFactoryOptions
} from "./repos/garden-data-ports.js";
export {
  SqliteGardenTaskRepo,
  type GardenTaskBacklogCount,
  type GardenTaskKindBacklogCount,
  type GardenTaskClaimResult,
  type GardenTaskCompletionResult,
  type GardenTaskEnqueueInput,
  type GardenTaskEventInput,
  type GardenTaskEventPublisherPort,
  type GardenTaskExpiryInput,
  type GardenTaskReclaimInput,
  type GardenTaskRepoPort,
  type GardenTaskRow,
  type GardenTaskStatus
} from "./repos/garden-task-repo.js";
