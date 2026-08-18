export { measureSqliteBlockingOnEventLoop, type SqliteBlockingProbeResult } from "./diagnostics/sqlite-blocking-probe.js";
export { StorageError, isDuplicateKeyError, type StorageErrorCode } from "./shared/index.js";
export {
  initDatabase,
  closeCachedDatabase,
  StorageDatabase,
  getCurrentSchemaSummary,
  configureSqliteWriteQueuePort,
  getSqliteWriteQueuePort,
  createInMemorySqliteWriteQueuePort,
  createSerialSqliteWriteQueuePort,
  createWorkerThreadSqliteWriteQueuePort,
  resolveSqliteWriteQueueWorkerUrl,
  ALAYA_SQLITE_WRITE_QUEUE_ENV,
  installDefaultSqliteWriteQueue,
  isSqliteWriteQueueDisabled,
  prepareTemporalCandidate,
  inspectTemporalProjectionSelection,
  isTemporalProjectionSelected,
  selectTemporalProjection,
  rollbackTemporalProjection,
  type InitDatabaseOptions,
  type SqliteWriteJob,
  type SqliteWriteJobKind,
  type SqliteWriteQueuePort,
  type SqliteWriteStatement,
  type WorkerThreadSqliteWriteQueueOptions,
  type TemporalCandidateFileDigest,
  type TemporalCandidatePreparation,
  acquireTemporalMaintenanceLease,
  type TemporalMaintenanceLease,
  type RollbackTemporalProjectionInput,
  type SelectTemporalProjectionInput,
  type TemporalProjectionSelectionAuditEntry,
  type TemporalProjectionSelectionState
} from "./sqlite/index.js";
export {
  readSchemaMigrationLedger
} from "./sqlite/db.js";
export {
  SqliteWorkspaceRepo,
  type WorkspaceCreateInput,
  type WorkspaceRepo
} from "./repos/runtime/index.js";
export { SqliteRunRepo, type RunCreateInput, type RunRepo } from "./repos/runtime/index.js";
export {
  SqliteEngineBindingRepo,
  type EngineBindingRecordCreateInput,
  type EngineBindingRepo
} from "./repos/control/index.js";
export {
  SqliteEventLogRepo,
  type EventLogAppendInput,
  type EventLogPageOptions,
  type EventLogRepo
} from "./repos/runtime/index.js";
export {
  SqliteRecallRoutingKeyProjectionRepo,
  SqliteSignalRepo,
  type SignalRepo,
  type StoredRecallRoutingKeyProjection
} from "./repos/signal/index.js";
export {
  RecallQualifiedEvidenceReader,
  SqliteEvidenceCapsuleRepo,
  SqliteEvidenceRecallEmbeddingRepo,
  readObjectKeyEvidenceSources,
  scanObjectKeyRetrofitSources,
  type EvidenceCapsuleRepo,
  type EvidenceCapsuleListPageOptions,
  type EvidenceCapsuleKeywordHit,
  type EvidenceRecallEmbeddingRecord,
  type EvidenceRecallEmbeddingRef,
  type EvidenceRecallEmbeddingSource,
  type EvidenceSearchMatch,
  type EvidenceSearchProjectionIdentity,
  type RecallQualifiedEvidence,
  type StoredObjectKeyEvidenceSource,
  type ObjectKeyRetrofitOwnerRow,
  type ObjectKeyRetrofitScan,
  type VerifiedAssertionLocatorResolutionInput,
  type VerifiedAssertionLocatorResolver,
  type EvidenceSourceAnchor
} from "./repos/capsules/index.js";
export {
  SqliteMemoryEntryRepo,
  SqliteMemoryObjectKeyRepo,
  type MemoryEntryRepo,
  type MemoryEntryRepoDynamicsUpdateFields,
  type MemoryEntryRepoTierUpdateInput,
  type MemoryEntryRepoUpdateFields,
  type MemoryObjectKeyRepo
} from "./repos/memory-entry/index.js";
export {
  DEFAULT_ACTIVE_CONSTRAINTS_CAP,
  MAX_ACTIVE_CONSTRAINTS_CAP,
  findActiveConstraints,
  normalizeActiveConstraintsCap,
  type ActiveConstraintQueryResult,
  type ActiveConstraintRecord,
  type ActiveConstraintSourceChannel
} from "./repos/governance/index.js";
export {
  SqliteGlobalMemoryRepo,
  type GlobalMemoryRepo,
  type GlobalMemoryRepoListFilters,
  type GlobalMemoryRepoListPageOptions
} from "./repos/memory/index.js";
export {
  SqliteKarmaEventRepo,
  type KarmaEvent,
  type KarmaEventKind,
  type KarmaEventListPageOptions,
  type KarmaEventRepo
} from "./repos/signal/index.js";
export {
  SqliteGreenStatusRepo,
  type GreenStatusRepo
} from "./repos/health/index.js";
export {
  SqliteSynthesisCapsuleRepo,
  type SynthesisCapsuleRepo,
  type SynthesisCapsuleKeywordHit
} from "./repos/capsules/index.js";
export {
  SqliteEdgeProposalRepo,
  type EdgeProposalCreateInput,
  type EdgeProposalRepo,
  type EdgeProposalReviewInput
} from "./repos/path/index.js";
export {
  SqliteOrphanRadarRepo,
  type OrphanRadarRepo
} from "./repos/health/index.js";
export {
  SqliteClaimFormRepo,
  type ClaimFormRepo
} from "./repos/governance/index.js";
export {
  SqliteProposalRepo,
  type AcceptedMemoryUpdateInput,
  type AcceptedPathRelationGovernanceInput,
  type CreateProposalWithEventsIfAbsentResult,
  type PathRelationProposalPayload,
  type PendingProposalDedupeKey,
  type ProposalCreateInput,
  type ProposalResolutionEventInput,
  type ProposalRepo
} from "./repos/proposal/index.js";
export {
  SqliteHealthJournalRepo,
  type HealthJournalCreateInput,
  type HealthJournalQueryParams,
  type HealthJournalRepo
} from "./repos/health/index.js";

export {
  SqliteSlotRepo,
  type SlotRepo
} from "./repos/governance/index.js";

export {
  SqliteToolSpecRepo,
  type ToolSpecRepo
} from "./repos/tooling/index.js";
export {
  SqliteToolExecutionRecordRepo,
  type ToolExecutionRecordRepo
} from "./repos/tooling/index.js";
export {
  SqliteStrongRefRepo,
  type StrongRefRepo
} from "./repos/memory/index.js";
export {
  SqlitePathRelationRepo,
  type PathRelationPageOptions,
  type PathRelationRepo
} from "./repos/path/index.js";
export {
  SqliteSoftAssociationPathRepo,
  type SoftAssociationPathReadOptions
} from "./repos/path/index.js";
export {
  SqliteFieldCausalUsageRepo,
  SqliteFieldDerivationJobRepo,
  SqliteFieldEraseBarrierRepo,
  SqliteFieldFactorRepo,
  SqliteFieldProjectionGenerationRepo,
  SqliteFieldProofEffectRepo,
  SqliteFieldSourceRecordRepo,
  SqliteFieldSourceSpanRepo,
  factorFromRow,
  generationFromRow,
  generationToRow,
  incidenceFromRow,
  jobFromRow,
  sourceRecordFromRow,
  sourceSpanFromRow,
  type FieldCausalUsageRepo,
  type FieldCausalUsageRow,
  type FieldDerivationJobRepo,
  type FieldDerivationJobRow,
  type FieldEraseBarrierRepo,
  type FieldEraseBarrierInput,
  type FieldEraseBarrierRow,
  type FieldFactorDescriptorRow,
  type FieldFactorIncidenceRow,
  type FieldFactorRepo,
  type FieldProjectionPinRow,
  type FieldProjectionPointerRow,
  type FieldProjectionGenerationRepo,
  type FieldProjectionGenerationRow,
  type FieldProofEffectRepo,
  type FieldProofEffectRow,
  type FieldSourceRecordRepo,
  type FieldSourceRecordRow,
  type FieldSourceSpanRepo,
  type FieldSourceSpanRow
} from "./repos/field/index.js";
export {
  assertRelationProjectionCurrent,
  digestRelationFormationEventSource,
  isLegacyPathIndexUnbound,
  isRelationProjectionReadable,
  SqliteRelationAssertionRepo,
  type RelationAssertionProjectionGeneration,
  type RelationAssertionRepo,
  type RelationFormationEventSource
} from "./repos/path/index.js";
export {
  SqliteTemporalPathProjectionReader,
  TemporalProjectionGenerationMissingError,
  type TemporalProjectionReadOptions
} from "./repos/path/index.js";
export {
  SqliteCoUsageCounterRepo,
  type CoUsageCounterIncrementInput,
  type CoUsageCounterRepo
} from "./repos/path/index.js";
export {
  SqliteEnrichPendingRepo,
  type EnrichPendingClaim,
  type EnrichPendingEnqueueInput,
  type EnrichPendingRepo
} from "./repos/garden/index.js";
export {
  SqliteSourceGroundingDeferQueueRepo,
  SOURCE_GROUNDING_DEFER_QUEUE_CAP,
  type SourceGroundingDeferEntry,
  type SourceGroundingDeferEnqueueResult,
  type SourceGroundingDeferQueueRepo,
  type SourceGroundingDeferStats
} from "./repos/garden/index.js";
export {
  SqlitePathPlasticityWatermarkRepo,
  type PathPlasticityWatermarkRecord,
  type PathPlasticityWatermarkRepo
} from "./repos/path/index.js";
export {
  SqliteBootstrappingRecordRepo,
  type BootstrappingRecordRepo
} from "./repos/runtime/index.js";
export {
  SqlitePathGraphSnapshotRepo,
  type PathGraphSnapshotRepo
} from "./repos/path/index.js";
export {
  SqliteExtensionDescriptorRepo,
  type ExtensionDescriptorRepo
} from "./repos/tooling/index.js";
export {
  SqliteWorkerRunRepo,
  type WorkerRunRepo
} from "./repos/runtime/index.js";
export {
  SqliteDeferredObligationRepo,
  type DeferredObligationRepo
} from "./repos/governance/index.js";
export {
  SqliteDirtyStateDossierRepo,
  type DirtyStateDossierRepo
} from "./repos/health/index.js";
export {
  SqliteConflictMatrixRepo,
  type ConflictMatrixRepo
} from "./repos/governance/index.js";

export {
  SqliteSurfaceIdentityRepo,
  type SurfaceIdentityRepo
} from "./repos/surface/index.js";

export {
  SqliteHealthIssueGroupRepo,
  type HealthIssueGroupRepo
} from "./repos/health/index.js";

export {
  SqliteSurfaceAnchorRepo,
  type SurfaceAnchorRepo
} from "./repos/surface/index.js";

export {
  SqliteSurfaceBindingRepo,
  type SurfaceBindingRecord,
  type SurfaceBindingRepo
} from "./repos/surface/index.js";

export {
  SqliteDriftLeaseRepo,
  type DriftLeaseRepo
} from "./repos/lease/index.js";

export {
  SqliteReconciliationLeaseRepo,
  type ReconciliationLease,
  type ReconciliationLeaseRepo
} from "./repos/lease/index.js";

export {
  SqliteCrossCuttingPermissionRepo,
  type CrossCuttingPermissionRecord,
  type CrossCuttingPermissionRepo
} from "./repos/surface/index.js";

export {
  SqliteProjectMappingAnchorRepo,
  type AcceptedBy,
  type ProjectMappingAnchorRecord,
  type ProjectMappingAnchorRepo
} from "./repos/surface/index.js";
export {
  SqliteGlobalMemoryRecallCacheRepo,
  type GlobalMemoryRecallCacheRecord,
  type GlobalMemoryRecallCacheRepo,
  type GlobalMemoryRecallClassification
} from "./repos/memory/index.js";
export {
  SqliteMemoryEmbeddingRepo,
  type MemoryEmbeddingRecord,
  type MemoryEmbeddingMetadata,
  type MemoryEmbeddingRepo
} from "./repos/memory/index.js";
export {
  SqliteMemoryHqRepo,
  type MemoryHqEvidenceRecord,
  type MemoryHqObservationRecord,
  type MemoryHqRecord,
  type MemoryHqRepo
} from "./repos/memory/index.js";
export {
  SqliteFileRepo,
  type FileRepo
} from "./repos/runtime/index.js";
export {
  SqliteConfigRepo,
  type ConfigRepo
} from "./repos/control/index.js";
export {
  SqliteTrustStateRepo,
  type TrustStateRepo
} from "./repos/control/index.js";
export { SqliteHandoffGapRepo } from "./repos/runtime/index.js";
// invariant: storage owns an independent jieba module-state instance (Package
// Dependency Direction forbids importing core's copy). Daemon and bench-runner
// MUST warm both core's and storage's segmenters at startup so the FTS query
// path never hits the loading-state fallback on the user-visible hot path.
// see also: packages/core/src/shared/cjk-segmentation.ts, apps/core-daemon/src/index.ts.
export {
  warmCjkSegmentation,
  segmentCjkRun,
  isCjkSegmentationCandidate,
  readCjkSegmentationStatus,
  CJK_SEGMENTATION_FALLBACK_WARNING_CODE as STORAGE_CJK_SEGMENTATION_FALLBACK_WARNING_CODE,
  __resetCjkSegmentationStateForTests as __resetStorageCjkSegmentationStateForTests
} from "./repos/shared/cjk-segmentation.js";
export type { CjkSegmentationStatus } from "./repos/shared/cjk-segmentation.js";
export {
  createGardenBackgroundDataPorts,
  type GardenBackgroundDataPorts,
  type GardenDataPortFactoryOptions
} from "./repos/garden/index.js";
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
} from "./repos/garden/index.js";
