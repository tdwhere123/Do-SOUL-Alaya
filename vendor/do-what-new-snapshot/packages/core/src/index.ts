export { CoreError, type CoreErrorCode } from "./errors.js";
export {
  DEFAULT_ACTOR,
  SYSTEM_ACTOR,
  SYSTEM_WORKSPACE_ID,
  resolveSystemWorkspaceId
} from "./shared/actors.js";
export {
  addDuration,
  ensureIsoDatetime,
  readClockSnapshot,
  readNow,
  systemNow,
  type NowProvider
} from "./shared/time.js";
export {
  normalizeOptionalNonEmptyString,
  parseNonEmptyString,
  parseObjectId
} from "./shared/validators.js";
export { SURFACE_URI_PATTERN, parseSurfaceUri } from "./shared/surface-uri.js";
export {
  ConversationService,
  type ConversationExecutionStanceResolverParams,
  type ConversationExecutionStanceResolverPort,
  type ConversationOutputShapingPort,
  type ConversationGovernanceLeasePort,
  type ConversationContextLensAssemblerPort,
  type ConversationEventLogRepoPort,
  type ConversationGardenComputeProviderPort,
  type ConversationResponse,
  type ConversationRunRepoPort,
  type ConversationSessionOverridePromotionPort,
  type ConversationSignalReceiverPort,
  type ConversationServiceDependencies,
  type ConversationWarnPort,
  type ConversationWorkspaceRepoPort,
  type SendMessageInput
} from "./conversation-service.js";
export {
  StanceResolutionService,
  type ResolveStanceParams,
  type StancePolicyProviderPort,
  type StanceResolutionDependencies,
  type StanceResolutionEventLogWriterPort
} from "./stance-resolution-service.js";
export {
  ManifestationResolver,
  type ManifestationBudgetConfigProviderPort,
  type ManifestationResolverDependencies,
  type ManifestationResolverEventLogWriterPort,
  type ResolveManifestationParams
} from "./manifestation-resolver.js";
export {
  EngineBindingService,
  type EngineBindingRepoPort,
  type EngineBindingServiceDependencies,
  type EngineBindingWorkspaceRepoPort
} from "./engine-binding-service.js";
export {
  EventPublisher,
  EventPublisherPropagationError,
  type EventPublisherDependencies,
  type EventPublisherEventLogRepoPort,
  type SseBroadcaster
} from "./event-publisher.js";
export {
  CanonicalAliasService,
  type CanonicalAliasEventPublisherPort,
  type CanonicalAliasServiceDependencies,
  type GovernanceSubjectCanonicalizationContext,
  type GovernanceSubjectCanonicalizationPlan
} from "./canonical-alias-service.js";
export {
  OutputShapingService,
  type OutputShapingDecision,
  type OutputShapingDependencies,
  type ShapeBatchResult,
  type ShapeableOutput
} from "./output-shaping-service.js";
export {
  RuntimeEventNormalizer,
  type NormalizerContext,
  type NormalizerEventLogRepoPort,
  type NormalizerSseBroadcasterPort,
  type RuntimeEventNormalizerDependencies
} from "./runtime-event-normalizer.js";
export { assertWorkerTransition } from "./worker-run-state-machine.js";
export {
  WorkerRunLifecycleService,
  type WorkerRunLifecycleServiceDependencies,
  type WorkerRunRepoPort
} from "./worker-run-lifecycle-service.js";
export {
  IntegrationGate,
  IntegrationGatePublicationError,
  VERIFIED_CLAUDE_RUNTIME_CAPABILITY_PROFILE,
  WORKER_INTEGRATION_STATUS_EVENT_TYPE,
  type ExpectedRuntimeCapabilityProfile,
  type IntegrationGateDecision,
  type IntegrationGateDependencies,
  type RuntimeCapabilityMismatch
} from "./integration-gate.js";
export {
  SerialDelegationService,
  type ConstraintProxyPort,
  type DirtyStatePanicServicePort,
  type DispatchWorkerInput,
  type IntegrationGatePort,
  type RuntimeEventNormalizerPort,
  type SerialDelegationServiceDependencies,
  type SerialDelegationWorkerRunRepoPort,
  type WorkerSafetyGatePort,
  type ZeroDaySecurityLayerPort
} from "./serial-delegation-service.js";
export {
  DeferredObligationService,
  type CreateDeferredObligationInput,
  type DeferredObligationRepoPort,
  type DeferredObligationServiceDependencies
} from "./deferred-obligation-service.js";
export {
  ConstraintProxy,
  type ConstrainedOperation,
  type ConstraintProxyDependencies
} from "./constraint-proxy.js";
export {
  DirtyStatePanicService,
  type DirtyStateDossierRepoPort,
  type DirtyStatePanicServiceDependencies,
  type DirtyStatePanicWorkerRunRepoPort
} from "./dirty-state-panic-service.js";
export {
  WorkerSafetyGate,
  type WorkerSafetyGateDependencies
} from "./worker-safety-gate.js";
export {
  ZeroDaySecurityLayer,
  type ZeroDaySecurityLayerDependencies
} from "./zero-day-security-layer.js";
export {
  SecurityStatusService,
  type SecurityStatusServiceDependencies
} from "./security-status-service.js";
export {
  WorkerTrustAssessor,
  type TrustAssessmentContext,
  type WorkerTrustAssessorDependencies
} from "./worker-trust-assessor.js";
export {
  NarrativeBudgetService,
  type NarrativeBudgetRepoPort,
  type NarrativeBudgetServiceDependencies
} from "./narrative-budget-service.js";
export {
  ConstitutionalFragmentService,
  type ConstitutionalFragmentEventLogReaderPort,
  type ConstitutionalFragmentServiceDependencies,
  type ConstitutionalFragmentStorePort
} from "./constitutional-fragment-service.js";
export { PromptAssetRegistry } from "./prompt-asset-registry.js";
export {
  WORKER_IDENTITY_FRAGMENT,
  buildSafetyConstitutionalFragment
} from "./system-prompt/constitutional-fragments.js";
export {
  WorkerDispatchPromptAssembler,
  type WorkerDispatchPromptAssemblerDependencies,
  type WorkerDispatchPromptAssemblyInput
} from "./system-prompt/worker-dispatch-prompt.js";
export {
  SignalService,
  type SignalMaterializationResult,
  type SignalMaterializationTargetKind,
  type SignalMaterializedObject,
  type SignalServiceDependencies,
  type SignalServiceEventLogRepoPort,
  type SignalServicePostTriageMaterializer,
  type SignalServiceReceiveResult,
  type SignalServiceSignalRepoPort,
  type SignalServiceWarnPort,
  type SignalSseBroadcaster,
  type SignalTriageResult
} from "./signal-service.js";
export {
  EvidenceService,
  type EvidenceCapsuleInput,
  type EvidenceServiceDependencies,
  type EvidenceServiceEvidenceCapsuleRepoPort,
  type EvidenceServiceEventLogRepoPort,
  type EvidenceSseBroadcaster
} from "./evidence-service.js";
export {
  GardenBacklogTelemetryService,
  type GardenBacklogTelemetryEventLogPort,
  type GardenBacklogTelemetrySchedulerPort,
  type GardenBacklogTelemetryServiceDependencies,
  type GardenBacklogTelemetrySseBroadcasterPort,
  type GardenBacklogTelemetryStopResult,
  type GardenBacklogTelemetryWarnPort
} from "./garden-backlog-telemetry-service.js";
export {
  MemoryService,
  type MemoryEntryInput,
  type MemoryEntryRepoUpdateFields,
  type MemoryEntryUpdateFields,
  type MemoryServiceDependencies,
  type MemoryServiceDynamicsPort,
  type MemoryServiceEvidenceServicePort,
  type MemoryServiceGreenPort,
  type MemoryServiceEventLogRepoPort,
  type MemoryServiceMemoryEntryRepoPort,
  type MemorySseBroadcaster
} from "./memory-service.js";
export {
  GraphExploreService,
  type GraphExploreAddEdgeParams,
  type GraphExploreOptions,
  type GraphExploreServiceDependencies,
  type GraphExploreServiceEdgeRepoPort,
  type GraphExploreServiceEventLogRepoPort,
  type GraphExploreServiceMemoryRepoPort,
  type GraphExploreServiceSseBroadcaster
} from "./graph-explore-service.js";
export {
  SynthesisService,
  type SynthesisCapsuleInput,
  type SynthesisServiceDependencies,
  type SynthesisServiceEventLogRepoPort,
  type SynthesisServiceEvidenceServicePort,
  type SynthesisServiceMemoryServicePort,
  type SynthesisServiceSynthesisCapsuleRepoPort,
  type SynthesisSseBroadcaster
} from "./synthesis-service.js";
export {
  SlotService,
  type SlotElectionDecision,
  type SlotElectionResult,
  type SlotServiceArbitrationResult,
  type SlotServiceArbitrationServicePort,
  type SlotServiceDependencies,
  type SlotServiceEventLogRepoPort,
  type SlotServiceSlotRepoPort,
  type SlotSseBroadcaster
} from "./slot-service.js";
export {
  ToolSpecService,
  type ToolSpecServiceDependencies,
  type ToolSpecServiceRepoPort
} from "./tool-spec-service.js";
export {
  ExtensionRegistryService,
  type ExtensionRegistryDependencies,
  type ExtensionStorePort
} from "./extension-registry-service.js";
export {
  McpToolDiscoveryService,
  type McpToolCatalogPort,
  type McpToolDiscoveryDependencies
} from "./mcp-tool-discovery-service.js";
export {
  ToolSubstrate,
  type ToolExecutionContext,
  type ToolSubstrateDependencies
} from "./tool-substrate/index.js";
export {
  ApprovalSink,
  ConversationToolExecutor,
  CircuitBreaker,
  ToolFastPath,
  ToolHotPathFull,
  type ToolFastPathDependencies
} from "./tool-hot-path/index.js";
export type {
  ApprovalSinkPort,
  ApprovalSinkDependencies,
  ConversationToolExecutionRequest,
  ConversationToolExecutorDependencies,
  CircuitBreakerConfig,
  CircuitBreakerDependencies,
  CircuitBreakerEventLogRepoPort,
  CircuitBreakerSseBroadcasterPort,
  CircuitBreakerState,
  HotPathEventLogRepoPort,
  HotPathExecuteInput,
  HotPathOutcomeRecorderPort,
  HotPathSseBroadcasterPort,
  HotPathToolExecutionRecordRepoPort,
  ToolHotPathExecuteResult,
  ToolHotPathFastPathPort,
  ToolHotPathFullDependencies,
  ToolHotPathGovernanceClientPort,
  ToolHotPathTargetRevalidatePort
} from "./tool-hot-path/index.js";
export {
  ToolGovernanceClient,
  type ToolGovernanceClientDependencies
} from "./ports/tool-governance-client.js";
export { resolvePermission } from "./permission-policy/index.js";
export type {
  PermissionDecision,
  PermissionDecisionReasonCode,
  PermissionResolutionInput
} from "./permission-policy/index.js";
export {
  TaskSurfaceBuilder,
  STRATEGY_RECALL_DEFAULTS,
  type NodeStrategy,
  type TaskSurfaceBuilderBuildParams,
  type TaskSurfaceBuilderDependencies,
  type TaskSurfaceBuilderEventLogRepoPort,
  type TaskSurfaceBuilderSurfaceRepoPort
} from "./task-surface-builder.js";
export {
  RecallService,
  type RecallCandidate,
  type RecallResult,
  type RecallServiceDependencies,
  type RecallServiceEmbeddingRecallPort,
  type RecallServiceEventLogRepoPort,
  type RecallServiceGraphSupportPort,
  type RecallServiceBudgetPenaltyPort,
  type RecallServiceMemoryRepoPort,
  type RecallServiceProjectMappingPort,
  type RecallServiceSlotRepoPort,
  type RecallServiceClaimResolverPort
} from "./recall-service.js";
export {
  EmbeddingRecallService,
  OpenAIEmbeddingClient,
  type EmbeddingProviderPort,
  type EmbeddingRecallEventLogPort,
  type EmbeddingRecallRepoPort,
  type EmbeddingRecallServiceDependencies,
  type EmbeddingRecallSupplementResult,
  type EmbeddingSimilarityHint,
  type EmbeddingVectorRecord
} from "./embedding-recall-service.js";
export {
  EmbeddingBackfillHandler,
  type EmbeddingBackfillHandleResult,
  type EmbeddingBackfillHandlerDependencies,
  type EmbeddingBackfillMemoryRepoPort,
  type EmbeddingBackfillRepoPort
} from "./embedding-backfill-handler.js";
export type {
  GlobalMemoryRecallCacheClassification,
  GlobalMemoryRecallCachePort,
  GlobalMemoryRecallCacheRecord,
  GlobalMemoryRecallEntry,
  GlobalMemoryRecallPort
} from "./global-memory-recall-port.js";
export {
  createGlobalMemoryRecallPort,
  loadGlobalRecallCandidates,
  type GlobalMemoryRecallCandidate,
  type GlobalMemoryRecallRecord,
  type GlobalMemoryRecallProjectMappingPort,
  type GlobalMemoryRecallSourcePort
} from "./global-memory-recall-service.js";
export {
  ProjectMappingService,
  StrictConfirmationRequired,
  type ProjectMappingServiceDependencies,
  type ProjectMappingServiceEventLogRepoPort,
  type ProjectMappingServiceMemoryRepoPort,
  type ProjectMappingServiceProjectMappingRepoPort,
  type ProjectMappingServiceSseBroadcaster
} from "./project-mapping-service.js";
export {
  BudgetBankruptcyService,
  type BudgetBankruptcyDeclareParams,
  type BudgetBankruptcyDeclareResult,
  type BudgetBankruptcyResolveParams,
  type BudgetBankruptcyServiceDependencies,
  type BudgetBankruptcyServiceEventLogPort,
  type BudgetBankruptcyServiceProposalPort,
  type BudgetBankruptcySseBroadcasterPort
} from "./budget-bankruptcy-service.js";
export {
  ContextLensAssembler,
  type AssembleResult,
  type LensAssemblerBankruptcyPort,
  type LensAssemblerClaimRepoPort,
  type LensAssemblerDependencies,
  type LensAssemblerEventLogRepoPort,
  type LensAssemblerMemoryRepoPort,
  type LensAssemblerOverridePort,
  type LensAssemblerRecallPort,
  type LensAssemblerSseBroadcasterPort,
  type LensAssemblerSlotRepoPort,
  type LensAssemblerTaskSurfacePort,
  type LensAssemblerWarnPort
} from "./context-lens-assembler.js";
export {
  SessionOverrideService,
  type SessionOverrideServiceDependencies,
  type SessionOverrideServiceEventLogPort
} from "./session-override-service.js";
export {
  GovernanceLeaseService,
  type GovernanceLeaseServiceDependencies,
  type GovernanceLeaseServiceEventLogPort
} from "./governance-lease-service.js";
export {
  DEFAULT_SURFACE_DRIFT_LEASE_TTL_MS,
  SurfaceDriftService,
  type DriftLeaseRepoPort,
  type SurfaceDriftEventPublisherPort,
  type SurfaceDriftServiceDependencies
} from "./surface-drift-service.js";
export {
  StrongRefService,
  type StrongRefRepoPort,
  type StrongRefServiceDependencies
} from "./strong-ref-service.js";
export {
  TargetRevalidateService,
  type TargetCurrencyCheckPort,
  type TargetRevalidateServiceDependencies
} from "./target-revalidate-service.js";
export {
  HealthJournalService,
  type HealthJournalServiceDependencies,
  type HealthJournalServiceEventLogPort,
  type HealthJournalServiceRepoPort,
  type HealthJournalServiceSseBroadcasterPort
} from "./health-journal-service.js";
export {
  GreenService,
  type GreenServiceDependencies,
  type GreenServiceEventLogRepoPort,
  type GreenServiceGreenStatusRepoPort,
  type GreenServiceLeasePort,
  type GreenServiceMemoryRepoPort,
  type GreenServiceReevaluationOutcome,
  type GreenServiceStatusResolverPort,
  type GreenWarnPort
} from "./green-service.js";
export {
  SurfaceService,
  type SurfaceServiceDependencies,
  type SurfaceServiceSurfaceAnchorRepoPort,
  type SurfaceServiceSurfaceIdentityRepoPort,
  type SurfaceSseBroadcaster
} from "./surface-service.js";
export {
  SurfaceBindingService,
  type SurfaceBindingRecordView,
  type SurfaceBindingServiceCrossCuttingLookupPort,
  type SurfaceBindingServiceCrossCuttingPermissionLookupRecord,
  type SurfaceBindingServiceDependencies,
  type SurfaceBindingServiceSurfaceBindingRepoPort,
  type SurfaceBindingSseBroadcaster
} from "./surface-binding-service.js";
export {
  CrossCuttingPermissionService,
  type CrossCuttingPermissionRecordView,
  type CrossCuttingPermissionServiceDependencies,
  type CrossCuttingPermissionServiceRepoPort,
  type CrossCuttingPermissionSseBroadcaster
} from "./cross-cutting-permission-service.js";
export {
  ArbitrationService,
  type ArbitrationResult,
  type ArbitrationServiceClaimRepoPort,
  type ArbitrationServiceClaimServicePort,
  type ArbitrationServiceConflictMatrixRepoPort,
  type ArbitrationServiceDependencies,
  type ArbitrationServiceEventLogRepoPort,
  type ArbitrationServiceSlotRepoPort,
  type ArbitrationSseBroadcaster,
  type ConflictMatrixEdgeInput,
  type ConflictMatrixRebuildResult
} from "./arbitration-service.js";
export {
  ClaimService,
  type ClaimFormInput,
  type ClaimServiceClaimFormRepoPort,
  type ClaimServiceDependencies,
  type ClaimServiceEventLogRepoPort,
  type ClaimSseBroadcaster
} from "./claim-service.js";
export {
  InMemoryKarmaEventStore,
  SqliteKarmaEventStore,
  type KarmaEvent,
  type KarmaEventKind,
  type KarmaEventStore,
  type KarmaEventStoreRepoPort,
  type KarmaEventStoreWarnPort
} from "./karma-event-store.js";
export {
  ProposalService,
  type DynamicsServiceProcessPort,
  type ProposalServiceClaimServicePort,
  type ProposalServiceDependencies,
  type ProposalServiceEventLogRepoPort,
  type ProposalServiceProposalRepoPort,
  type ProposalServiceSynthesisServicePort,
  type ProposalServiceWarnPort,
  type ProposalSseBroadcaster,
  type ReviewAction
} from "./proposal-service.js";
export {
  DynamicsService,
  type DynamicsServiceDependencies,
  type DynamicsServiceEventLogRepoPort,
  type DynamicsServiceGreenPort,
  type DynamicsServiceKarmaEventRepoPort,
  type DynamicsServiceMemoryRepoPort,
  type DynamicsUpdateFields
} from "./dynamics-service.js";
export { ClaudeRuntimeAdapter } from "./runtime-adapters/claude-runtime-adapter.js";
export { NodeClaudeSDKClientFactory } from "./runtime-adapters/node-claude-sdk-client.js";
export {
  SlashCommandService,
  type DispatchSlashCommandInput,
  type ListSlashCommandsInput,
  type SlashCommandRunRepoPort,
  type SlashCommandServiceDependencies,
  type SlashCommandWorkspaceRepoPort
} from "./slash-command-service.js";
export {
  type DiscoveredCommandSource,
  type DiscoveredSlashCommand
} from "./slash-local-skill-discovery.js";
export { NodeTemplateResolver } from "./node-template-resolver.js";
export * from "./test-doubles/index.js";
export {
  DIMENSION_DEFAULT_DECAY_PROFILE,
  FRESHNESS_DECAY_DAYS,
  INITIAL_ACTIVATION_FROM_CONFIDENCE_FACTOR,
  clamp01,
  computeDecayedRetention,
  computeFreshnessFactor,
  computeRetentionFromProfile,
  determineManifestation
} from "./dynamics-constants-runtime.js";
export {
  RunHotStateService,
  type RunHotStateEventLogRepoPort,
  type RunHotStateRunRepoPort,
  type RunHotStateServiceDependencies
} from "./run-hot-state-service.js";
export {
  WorkspaceService,
  type CreateWorkspaceInput,
  type WorkspaceBootstrappingPlannerPort,
  type WorkspaceBootstrappingRecordRepoPort,
  type WorkspaceEngineConfigRepoPort,
  type WorkspacePathRelationRepoPort,
  type WorkspaceRepoPort,
  type WorkspaceRunRepoPort,
  type WorkspaceServiceDependencies
} from "./workspace-service.js";
export {
  RunService,
  type CreateRunInput,
  type RunRepoPort,
  type RunServiceDependencies,
  type RunWorkspaceRepoPort
} from "./run-service.js";
export { rebuildMessageHistory } from "./message-history.js";
export { resolveStoredFilePath } from "./file-path.js";
export { buildSystemPrompt } from "./system-prompt/template.js";
