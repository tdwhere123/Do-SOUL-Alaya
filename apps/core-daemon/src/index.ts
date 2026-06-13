import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ControlPlaneObjectKind,
  GardenTaskKind,
  HealthIssueCauseKind,
  HealthIssueResolutionState,
  HealthIssueSeverity,
  HealthIssueSuggestedAction,
  type HealthIssueGroup,
  MemoryGovernanceEventType,
  ProposalOptionKind,
  ProposalResolutionState,
  ProposalSchema,
  RecallContextEventType,
  RetentionPolicy,
  SoulActiveConstraintSchema,
  SoulProposalCreatedPayloadSchema,
  isPathActiveForRecall,
  type MemoryEntry,
  type TransitionCausedBy
} from "@do-soul/alaya-protocol";
import {
  ArbitrationService,
  BudgetBankruptcyService,
  CanonicalAliasService,
  ClaimService,
  ConversationService,
  ContextLensAssembler,
  DynamicsService,
  EdgeAutoProducerService,
  EdgeProposalService,
  EngineBindingService,
  EvidenceService,
  ManifestationResolver,
  PathActivationCandidateProducer,
  type PathActivationCandidateProducerPathReaderPort,
  GardenBacklogTelemetryService,
  GovernanceLeaseService,
  GraphContractService,
  GraphExploreService,
  GreenService,
  HealthJournalService,
  MemoryService,
  ConflictDetectionService,
  DeferredObligationService,
  PathRelationProposalService,
  type PathCandidateSink,
  type PathFailureHealthInboxPort,
  PATH_RELATION_COUNTER_DEFAULT_TTL_MS,
  ProjectMappingService,
  ProposalService,
  ReconciliationService,
  createRuleOnlyReconciliationDecisionPort,
  ResolutionService,
  RecallService,
  RuleBasedEntityExtractor,
  RunService,
  SessionOverrideService,
  SignalService,
  SlotService,
  StrongRefService,
  SurfaceBindingService,
  SurfaceDriftService,
  SurfaceService,
  SynthesisService,
  TaskSurfaceBuilder,
  ToolSpecService,
  ZeroDaySecurityLayer,
  CoherenceEdgeProducerService,
  rebuildCountersFromEventLog,
  warmCjkSegmentation,
  type ConversationServiceDependencies,
  type GlobalMemoryRecallSubscription
} from "@do-soul/alaya-core";
import {
  SqliteDriftLeaseRepo,
  SqliteGardenTaskRepo,
  SqliteHealthIssueGroupRepo,
  createGardenBackgroundDataPorts,
  findActiveConstraints,
  initDatabase,
  warmCjkSegmentation as warmStorageCjkSegmentation
} from "@do-soul/alaya-storage";
import {
  ComputeRoutingService,
  DegradationPipeline,
  BootstrappingService,
  LocalHeuristics,
  MaterializationRouter,
  OFFICIAL_API_GARDEN_MODEL,
  OfficialApiGardenProvider,
  TopologyService,
  type GraphEdgeCreationPort,
  type PathRelationProposalPort
} from "@do-soul/alaya-soul";
import { createDaemonEmbeddingRuntime } from "./ai/daemon-embedding-runtime.js";
import { createBudgetProposalPort } from "./budget/wiring.js";
import {
  createDaemonRepositories,
  createDaemonCoreServices,
  createEngineBindingTester,
  createGardenBacklogThresholds,
  createGlobalMemoryRecallCachePort,
  createGlobalMemoryRecallPort,
  createGlobalMemoryRouteService,
  createManifestationBudgetConfigProvider,
  createRequestProtection,
  createRuntimeNotifier,
  createSoulGraphService,
  createWarnLogger,
  defaultBootstrappingTemplates,
  defaultCanonicalAliasMap,
  isRemoteDaemonOptInEnabled,
  listServerHardConstraints,
  loadConfigEnv,
  patchArbitrationClaimService,
  recordStartupStep,
  reconcileBootstrapPathsForAllWorkspaces,
  resolvePersistedGardenLastPassAt,
  resolveGardenSecretRefValue,
  resolveCoreDaemonFilesDirectory,
  resolveDatabasePath,
  resolveEdgeClassifyWiring,
  buildGardenComputeRoutingProviders,
  canResolveOfficialGardenProvider,
  createConflictDetectionLlmPort,
  createRecallMaterializationWiring,
  createPathFailureHealthInbox,
  normalizeRecallTimeConcernWindowDigest,
  finalizeAlayaDaemonRuntime,
  validateDaemonEnv,
  type AlayaDaemonListenOptions,
  type AlayaDaemonRuntime,
  type AlayaDaemonServer,
  type DaemonStartupStepRecord
} from "./runtime/index.js";
import { createReconciliationLlmDecisionPort } from "./ai/reconciliation-llm-decision.js";
import { createEdgeAutoProducerLlmPort } from "./ai/edge-auto-producer-llm-adapter.js";
import { createEdgeClassifyQueueAdapter } from "./garden/edge-classify-queue-adapter.js";
import { resolveAlayaConfigDir, resolveAlayaConfigPaths } from "./cli/config-files.js";
import {
  createTombstoneDispositionSweepPort,
  createTombstoneGcPort
} from "./garden/forget-disposition-ports.js";
import { createGardenRuntime } from "./garden/runtime.js";
import {
  createPathPlasticityService,
  createRecallPathPlasticityPort
} from "./garden/path-plasticity-runtime.js";
import { SqliteHandoffGapAdapter } from "./handoff/gap-adapter.js";
import { createManifestationContextLensAssembler } from "./manifestation/context-lens-assembler.js";
import { parseZeroDayPoliciesJson } from "./security/zero-day-policies.js";
import { createSecurityStatusBootstrapServices } from "./security/status-bootstrap.js";
import { createConfigService } from "./services/config-service.js";
import { createEnvironmentStatusService } from "./services/environment-status-service.js";
import { GardenComputeProviderResolver } from "./services/garden-compute-provider-resolver.js";
import { createGraphHealthService } from "./services/graph-health-service.js";
import {
  CORE_DAEMON_ENVIRONMENT_TOOLS,
  derivePrincipalCodingAvailability
} from "./services/principal-coding-availability.js";
import { createRecallUtilizationService } from "./services/recall-utilization-service.js";
import {
  buildSingleUsedAnchorPayload,
  type SingleUsedAnchorTelemetryEmitter
} from "./routes/recall-utilization.js";
import { createSoulApprovalService } from "./services/soul-approval-service.js";
import { SoulTopologyAuditService } from "./services/soul-topology-audit-service.js";
import { createTrustStateRecorder } from "./trust/state.js";

export type { AlayaDaemonListenOptions, AlayaDaemonRuntime, AlayaDaemonRuntimeServices, AlayaDaemonServer, DaemonStartupStepRecord } from "./runtime/index.js";
export { resolveSecretRef } from "./secrets/index.js";
export type { ResolveSecretError, ResolvedSecret, SecretRefReader } from "./secrets/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..", "..");

export async function createAlayaDaemonRuntime(): Promise<AlayaDaemonRuntime> {
  validateDaemonEnv(process.env);
  // anchor: warm jieba (CJK word segmenter) at daemon start so the first
  // recall query already sees segmented lexical_terms instead of paying
  // the native-binding import cost on the user-visible path. AWAIT both
  // module-state instances — core owns one (recall-query-probes lane),
  // storage owns an independent one (FTS query tokenizer lane); the
  // Package Dependency Direction forbids storage importing core. A
  // fire-and-forget warm leaked a "loading" window during which sync
  // tokenizers returned the surface-only fallback (no segmentation) so
  // the first N queries — and every shard of the bench harness, which
  // boots an isolated daemon — saw raw CJK runs instead of jieba pieces.
  // Boot pays ~200-500ms once for native binding + dict load; the
  // segmenters are fail-soft so a warm failure is silent and recall
  // still degrades to surface-only matching.
  // see also: packages/core/src/shared/cjk-segmentation.ts,
  //          packages/storage/src/repos/shared/cjk-segmentation.ts.
  await Promise.all([
    warmCjkSegmentation(),
    warmStorageCjkSegmentation()
  ]);
  const startupSteps: DaemonStartupStepRecord[] = [];
  const validatedEnv = validateDaemonEnv(process.env);
  const warnLogger = createWarnLogger();
  const runtimeNotifier = createRuntimeNotifier();
  const requestProtection = createRequestProtection(validatedEnv);
  const remoteDaemonOptInEnabled = isRemoteDaemonOptInEnabled(process.env);
  const configPaths = resolveAlayaConfigPaths(resolveAlayaConfigDir({ env: process.env }));
  const configEnv = await loadConfigEnv(configPaths.envPath);
  // Fallback DB path is the user's config dir, NOT a path inside the
  // package install directory. Writing to package internals corrupts
  // future upgrades and would let a release/source-built daemon mutate
  // state inside its own package files.
  const dbPath = await resolveDatabasePath(configPaths, join(configPaths.configDir, "alaya.db"));
  const filesDirectory = resolveCoreDaemonFilesDirectory();
  const database = initDatabase({ filename: dbPath });
  recordStartupStep(startupSteps, "database");

  const {
    workspaceRepo,
    runRepo,
    bindingRepo,
    bootstrappingRecordRepo,
    configRepo,
    eventLogRepo,
    reconciliationLeaseRepo,
    signalRepo,
    edgeProposalRepo,
    evidenceCapsuleRepo,
    memoryEntryRepo,
    globalMemoryRepo,
    globalMemoryRecallCacheRepo,
    orphanDetectionEnabled,
    orphanRadarRepo,
    projectMappingAnchorRepo,
    synthesisCapsuleRepo,
    claimFormRepo,
    conflictMatrixRepo,
    slotRepo,
    surfaceIdentityRepo,
    surfaceAnchorRepo,
    surfaceBindingRepo,
    crossCuttingPermissionRepo,
    proposalRepo,
    greenStatusRepo,
    healthJournalRepo,
    fileRepo,
    karmaEventRepo,
    toolSpecRepo,
    toolExecutionRecordRepo,
    extensionDescriptorRepo,
    trustStateRepo,
    strongRefRepo,
    pathRelationRepo,
    coUsageCounterRepo,
    enrichPendingRepo,
    enqueueEnrichPending,
    pathPlasticityWatermarkRepo,
    pathGraphSnapshotRepo,
    deferredObligationRepo,
    workerRunRepo,
    workspaceEngineConfigRepo,
    sqliteHandoffGapRepo
  } = createDaemonRepositories({
    database,
    warn: warnLogger.warn
  });
  recordStartupStep(startupSteps, "repositories");

  const environmentStatusService = createEnvironmentStatusService({
    toolNames: CORE_DAEMON_ENVIRONMENT_TOOLS,
    getDatabasePath: () => database.filename,
    getFilesDirectory: () => filesDirectory
  });
  const environmentStatus = await environmentStatusService.getStatus();
  const principalCodingAvailability = derivePrincipalCodingAvailability({
    runtimeConfigured: process.env.ALAYA_PRINCIPAL_RUNTIME === "claude_code",
    tools: environmentStatus.tools
  });
  const zeroDaySecurityLayer = new ZeroDaySecurityLayer({
    loadPolicies: async () => parseZeroDayPoliciesJson(process.env.ZERO_DAY_POLICIES_JSON)
  });
  const {
    eventPublisher,
    runHotStateService,
    securityStatusService,
    workspaceService: securedWorkspaceService
  } = createSecurityStatusBootstrapServices({
    workspaceRepo,
    runRepo,
    eventLogRepo,
    runtimeNotifier,
    zeroDayLayer: zeroDaySecurityLayer,
    engineConfigRepo: workspaceEngineConfigRepo,
    bootstrappingPlanner: new BootstrappingService({
      templates: defaultBootstrappingTemplates,
      now: () => new Date().toISOString()
    }),
    pathRelationRepo,
    bootstrappingRecordRepo
  });
  const rawConfigService = createConfigService({
    configRepo,
    eventPublisher,
    configPathsProvider: () => configPaths
  });
  const manifestationBudgetConfigProvider = createManifestationBudgetConfigProvider(configRepo);
  const trustStateRecorder = createTrustStateRecorder({
    eventPublisher,
    repo: trustStateRepo,
    clock: () => new Date().toISOString()
  });
  const toolSpecService = new ToolSpecService({ toolSpecRepo });
  const strongRefService = new StrongRefService({ repo: strongRefRepo });
  const canonicalAliasService = new CanonicalAliasService({
    aliasMap: defaultCanonicalAliasMap,
    eventPublisher
  });
  // invariant: dynamicsService is constructed below; EvidenceService
  // calls into it via this ref so the evidence_gain karma emit on
  // questionable -> verified does not require reordering. see also:
  // EvidenceService.emitEvidenceGainIfPromoted.
  const dynamicsServiceRef: {
    current: {
      emitKarmaEvent(input: {
        kind: "evidence_gain";
        objectId: string;
        workspaceId: string;
        runId?: string | null;
      }): Promise<void>;
    } | null;
  } = { current: null };
  const evidenceService = new EvidenceService({
    evidenceCapsuleRepo,
    eventLogRepo,
    runtimeNotifier,
    karmaEmitter: {
      emitKarmaEvent: async (input) => {
        if (dynamicsServiceRef.current === null) {
          return;
        }
        await dynamicsServiceRef.current.emitKarmaEvent(input);
      }
    },
    memoryRefLookup: {
      findMemoriesByEvidenceRef: async (evidenceObjectId, workspaceId) => {
        const memories = await memoryEntryRepo.findByEvidenceRefs(workspaceId, [evidenceObjectId]);
        return memories.map((entry) => ({ object_id: entry.object_id }));
      }
    },
    warn: warnLogger.warn
  });
  const governanceLeaseService = new GovernanceLeaseService({ eventLogRepo });
  const healthJournalService = new HealthJournalService({
    repo: healthJournalRepo,
    eventLogRepo,
    runtimeNotifier
  });
  const greenService = new GreenService({
    greenStatusRepo,
    memoryRepo: memoryEntryRepo,
    eventLogRepo,
    runtimeNotifier,
    leaseService: governanceLeaseService,
    warn: warnLogger.warn
  });
  const dynamicsService = new DynamicsService({
    memoryRepo: memoryEntryRepo,
    karmaEventRepo,
    eventLogRepo,
    runtimeNotifier,
    greenService
  });
  dynamicsServiceRef.current = dynamicsService;
  const memoryService = new MemoryService({
    memoryEntryRepo,
    evidenceService,
    eventLogRepo,
    runtimeNotifier,
    dynamicsService,
    greenService,
    // invariant (B1): the disposition-gated physical delete authority re-verifies
    // a `compressed` member's preserving capsule at delete time (>=24h after
    // marking) before any irreversible removal. see also:
    // packages/core/src/memory/memory-service/service.ts:MemoryService.compressedPreservationStillValid
    synthesisCapsuleLookup: {
      findById: (objectId: string) => synthesisCapsuleRepo.findById(objectId)
    },
    // invariant: atomic create + enrich_pending no-drop marker. When a create
    // input carries an enqueueEnrichment intent, the row insert and this enqueue
    // commit in one storage transaction. see also:
    // packages/core/src/memory/memory-service/service.ts:MemoryService.createRowMaybeAtomicallyEnqueued
    enrichPendingWriter: { enqueue: enqueueEnrichPending }
  });
  const graphExploreService = new GraphExploreService({
    // soul.explore_graph and recall graph_support both read the unified path plane.
    pathRepo: pathRelationRepo,
    eventLogRepo
  });
  const pathRelationProposalServiceRef: {
    current: Pick<PathRelationProposalService, "submitCandidate"> | null;
  } = { current: null };
  const healthIssueGroupRepo = new SqliteHealthIssueGroupRepo(database);
  const pathFailureHealthInboxPort = createPathFailureHealthInbox({
    healthIssueGroupRepo
  });
  const edgeProposalService = new EdgeProposalService({
    memoryRepo: memoryEntryRepo,
    proposalRepo: edgeProposalRepo,
    // Accept mints a governed PathRelation; the submit port is wired after init.
    pathCandidatePort: {
      submitCandidate: async (input) => {
        if (pathRelationProposalServiceRef.current === null) {
          throw new Error("PathRelationProposalService used before recall wiring completed.");
        }
        return await pathRelationProposalServiceRef.current.submitCandidate(input);
      }
    },
    // invariant: D-EDGEAUDIT. Forward-references the health-inbox adapter
    // (declared after healthIssueGroupRepo below); invoked only at accept-mint
    // failure time, long after init. see also: pathFailureHealthInboxPort.
    healthInboxPort: {
      recordPathRelationFailure: (entry) => pathFailureHealthInboxPort.recordPathRelationFailure(entry)
    },
    eventPublisher
  });
  const topologyService = new TopologyService({
    pathRelationRepo,
    snapshotHistory: {
      getHistory: async (workspaceId, limit) => await pathGraphSnapshotRepo.findHistory(workspaceId, limit)
    }
  });
  const soulGraphService = createSoulGraphService({
    memoryEntryRepo,
    pathRelationRepo,
    proposalRepo,
    eventLogRepo
  });
  const graphHealthService = createGraphHealthService({
    pathRelationRepo,
    eventLogRepo
  });
  // Read-only path_relations projection for the Inspector Graph surface;
  // pathRelationRepo.findActive supplies the unified path plane directly.
  const graphContractService = new GraphContractService({
    pathRelationRepo
  });
  const synthesisService = new SynthesisService({
    synthesisCapsuleRepo,
    evidenceService,
    memoryService,
    eventLogRepo,
    runtimeNotifier
  });
  const slotServiceRef: { current: SlotService | null } = { current: null };
  const arbitrationService = new ArbitrationService({
    slotRepo,
    claimRepo: claimFormRepo,
    conflictMatrixRepo,
    claimService: null as never,
    eventLogRepo,
    runtimeNotifier
  } as ConstructorParameters<typeof ArbitrationService>[0]);
  const slotService = new SlotService({
    slotRepo,
    eventLogRepo,
    runtimeNotifier,
    arbitrationService: {
      arbitrateSlot: async (slotId, options) => await arbitrationService.arbitrateSlot(slotId, options)
    }
  });
  slotServiceRef.current = slotService;
  const claimService = new ClaimService({
    claimFormRepo,
    eventLogRepo,
    slotService,
    runtimeNotifier,
    eventPublisher,
    canonicalAliasService
  });
  patchArbitrationClaimService(arbitrationService, claimService);
  const sessionOverrideService = new SessionOverrideService({ eventLogRepo });
  const proposalService = new ProposalService({
    proposalRepo,
    eventLogRepo,
    runtimeNotifier
  });
  const surfaceDriftService = new SurfaceDriftService({
    leaseRepo: new SqliteDriftLeaseRepo(database),
    eventPublisher,
    healthJournal: {
      record: async (entry) => {
        await healthJournalService.record(entry);
      }
    }
  });
  const surfaceBindingService = new SurfaceBindingService({
    surfaceBindingRepo,
    crossCuttingPermissionLookup: crossCuttingPermissionRepo,
    eventPublisher,
    surfaceDriftService
  });
  const surfaceService = new SurfaceService({
    surfaceIdentityRepo,
    surfaceAnchorRepo,
    runtimeNotifier,
    surfaceDriftService,
    surfaceBindingCascader: surfaceBindingService
  });
  const taskSurfaceBuilder = new TaskSurfaceBuilder({
    surfaceRepo: surfaceIdentityRepo,
    eventLogRepo
  });
  const budgetNow = () => new Date().toISOString();
  const budgetBankruptcyService = new BudgetBankruptcyService({
    eventLogRepo,
    proposalService: createBudgetProposalPort({
      proposalRepo,
      now: budgetNow
    }),
    runtimeNotifier,
    now: budgetNow
  });
  const projectMappingService = new ProjectMappingService({
    projectMappingRepo: projectMappingAnchorRepo,
    memoryRepo: memoryEntryRepo,
    eventLogRepo,
    runtimeNotifier
  });
  const {
    globalMemoryService,
    globalMemoryRecallService,
    globalMemoryRecallInvalidationSubscription,
    embeddingStatusService,
    embeddingRecallService,
    embeddingBackfillHandler,
    embeddingDefaultPolicyDecorator,
    recallUtilizationService,
    singleUsedAnchorEmitter,
    deliveryAnchorReader,
    recallService,
    contextLensAssembler,
    conversationContextLensAssembler,
    graphEdgePort,
    edgeAutoProducerService,
    conflictDetectionService,
    reconciliationService,
    pathRelationProposalService,
    resolutionService,
    pathRelationEvictionTimer,
    materializationRouter,
    signalService,
    edgeClassifyQueueRepoHolder
  } = await createRecallMaterializationWiring({
    database,
    configEnv,
    rawConfigService,
    eventLogRepo,
    eventPublisher,
    runtimeNotifier,
    warn: warnLogger.warn,
    healthJournalService,
    memoryEntryRepo,
    pathRelationRepo,
    manifestationBudgetConfigProvider,
    projectMappingService,
    claimFormRepo,
    coUsageCounterRepo,
    evidenceCapsuleRepo,
    synthesisCapsuleRepo,
    globalMemoryRepo,
    globalMemoryRecallCacheRepo,
    budgetBankruptcyService,
    budgetNow,
    slotRepo,
    graphExploreService,
    sessionOverrideService,
    taskSurfaceBuilder,
    trustStateRecorder,
    edgeProposalService,
    dynamicsService,
    memoryService,
    proposalRepo,
    reconciliationLeaseRepo,
    deferredObligationRepo,
    claimService,
    synthesisService,
    enqueueEnrichPending,
    sqliteHandoffGapRepo,
    signalRepo,
    pathFailureHealthInboxPort,
    evidenceService
  });
  pathRelationProposalServiceRef.current = pathRelationProposalService;
  const {
    localHeuristicsProvider,
    configService,
    officialGardenProvider,
    computeRoutingService,
    conversationService,
    runService,
    engineBindingService,
    soulApprovalService,
    topologyAuditService,
    gardenBacklogThresholds,
    pathPlasticityService
  } = await createDaemonCoreServices({
    rawConfigService,
    eventLogRepo,
    runtimeNotifier,
    workspaceRepo,
    runRepo,
    bindingRepo,
    eventPublisher,
    trustStateRepo,
    pathRelationRepo,
    signalService,
    contextLensAssembler: conversationContextLensAssembler,
    governanceLeaseService,
    budgetBankruptcyService,
    healthJournalService,
    warn: warnLogger.warn,
    isPrincipalCodingEngineAvailable: () => principalCodingAvailability.available
  });
  recordStartupStep(startupSteps, "core-services");
  // invariant: the R3d terminal-forgetting authority adapter. autonomousTombstone
  // + autonomousHardDeleteTombstoned are the audited, disposition-gated service
  // methods; findTombstonedMemoriesWithDisposition is the disposition-gated repo
  // query. Both delete paths refuse a row lacking a non-null forget_disposition.
  const forgetTombstoneAuthority = {
    autonomousTombstone: (
      objectId: string,
      disposition: NonNullable<MemoryEntry["forget_disposition"]>,
      dispositionRef: string | null,
      reason: string,
      causedBy: TransitionCausedBy
    ) => memoryService.autonomousTombstone(objectId, disposition, dispositionRef, reason, causedBy),
    autonomousHardDeleteTombstoned: (objectId: string, reason: string, causedBy: TransitionCausedBy) =>
      memoryService.autonomousHardDeleteTombstoned(objectId, reason, causedBy),
    findTombstonedMemoriesWithDisposition: (workspaceId: string) =>
      memoryEntryRepo.findTombstonedMemoriesWithDisposition(workspaceId)
  };
  const gardenBackgroundDataPorts = createGardenBackgroundDataPorts(database);
  // invariant: active -> dormant is a recall-visibility change (dormant rows are
  // excluded from recall / list / FTS), so it MUST be audited like the
  // delete/tombstone paths. The raw storage UPDATE is not audited, so route the
  // demotion through the core transition authority, which appends
  // SOUL_MEMORY_STATE_CHANGED ATOMICALLY with the guarded UPDATE (one transaction,
  // via onTransition) and then notifies, while keeping the storage candidate query
  // and the Janitor port boundary intact. causedBy mirrors the forget sweep's
  // deterministic_rule attribution. see also:
  // packages/core/src/memory/memory-service/service.ts:MemoryService.demoteActiveToDormantIfActive.
  const auditedDormantDemotionPort = {
    findLowActivityActiveMemories: (workspaceId: string) =>
      gardenBackgroundDataPorts.dormantDemotionPort.findLowActivityActiveMemories(workspaceId),
    // invariant: route through the race-tolerant guarded demotion. A candidate
    // that left active between the snapshot and its turn (concurrent revival /
    // overlapping sweep / Inspector retire) resolves "skipped" (no audit, no
    // throw) so the Janitor sweep continues; an actually-demoted row gets its
    // active->dormant audit appended atomically with the guarded UPDATE.
    setLifecycleDormant: async (memoryId: string, taskId: string): Promise<"demoted" | "skipped"> => {
      const outcome = await memoryService.demoteActiveToDormantIfActive(
        memoryId,
        `autonomous_dormant_demotion: ${taskId}`,
        "deterministic_rule"
      );
      return outcome.status;
    }
  };
  const gardenDataPorts = {
    ...gardenBackgroundDataPorts,
    dormantDemotionPort: auditedDormantDemotionPort
  };
  // Coheres_with crystallization (design S): built only when embedding is on, so
  // embedding-off behavior is unchanged.
  const COHERENCE_CRYSTALLIZE_FLOOR = 0.6;
  const COHERENCE_CRYSTALLIZE_CAP_PER_NODE = 3;
  const coherenceCrystallizer =
    embeddingRecallService === undefined
      ? undefined
      : new CoherenceEdgeProducerService({
          pairSource: embeddingRecallService,
          mintPort: pathRelationProposalService,
          warn: (message: string, meta: Record<string, unknown>) => console.warn(message, meta)
        });
  const gardenRuntime = createGardenRuntime({
    databaseConnection: database.connection,
    backlogThresholds: gardenBacklogThresholds,
    eventLogRepo,
    eventPublisher,
    gardenDataPorts,
    healthJournalRepo,
    handoffGapRepo: sqliteHandoffGapRepo,
    orphanDetectionEnabled,
    orphanRadarRepo,
    healthIssueGroupRepo,
    pathGraphSnapshotRepo,
    pathRelationRepo,
    pathPlasticityWatermarkRepo,
    pathPlasticityService,
    embeddingBackfillHandler,
    configService,
    officialApiGardenProvider: officialGardenProvider,
    localHeuristicsProvider,
    signalReceiver: signalService,
    strongRefService,
    workspaceRepo,
    // invariant: GATED terminal forgetting (R3d). The disposition sweep
    // (dormant->tombstoned) and the physical GC both route their authority
    // through memoryService (audited) + memoryEntryRepo (disposition-gated SQL),
    // so an un-preserved/un-judged memory can never be autonomously removed.
    tombstoneDispositionSweepPort: createTombstoneDispositionSweepPort({
      memoryLookup: {
        findDormantMemories: (workspaceId) => memoryEntryRepo.findDormantMemories(workspaceId),
        findById: (objectId) => memoryEntryRepo.findById(objectId)
      },
      capsuleLookup: { findByWorkspaceId: (workspaceId) => synthesisCapsuleRepo.findByWorkspaceId(workspaceId) },
      tombstoneAuthority: forgetTombstoneAuthority
    }),
    tombstoneGcPort: createTombstoneGcPort({ tombstoneAuthority: forgetTombstoneAuthority }),
    // invariant: BULK_ENRICH drain wiring (S3c). The same governed services
    // materialization used to run inline now run in the Garden worker, against
    // memory rows fetched by id. enrichConflictDetectionPort is only wired when
    // conflict detection is enabled (it has its own env gate).
    enrichPendingRepo,
    enrichMemoryLookup: {
      findById: async (memoryId: string) => {
        const memory = await memoryEntryRepo.findById(memoryId);
        if (memory === null) {
          return null;
        }
        return {
          object_id: memory.object_id,
          dimension: memory.dimension,
          scope_class: memory.scope_class,
          content: memory.content,
          domain_tags: memory.domain_tags,
          workspace_id: memory.workspace_id,
          run_id: memory.run_id
        };
      }
    },
    enrichSourceSignalLookup: {
      getById: async (signalId: string) => await signalRepo.getById(signalId)
    },
    enrichSignalRefReplayPort: {
      replaySignalRefs: async ({ newMemoryId, signal }) => {
        await materializationRouter.replaySignalRefs({ newObjectId: newMemoryId, signal });
      }
    },
    enrichEdgeProducerPort: edgeAutoProducerService,
    ...(coherenceCrystallizer === undefined
      ? {}
      : {
          coherenceEdgeProducerPort: {
            crystallizeForBackfill: (params: {
              readonly workspaceId: string;
              readonly runId: string | null;
              readonly objectIds: readonly string[];
            }) =>
              coherenceCrystallizer.crystallize({
                workspaceId: params.workspaceId,
                runId: params.runId,
                objects: params.objectIds.map((objectId) => ({ objectId, sessionId: null })),
                floor: COHERENCE_CRYSTALLIZE_FLOOR,
                capPerNode: COHERENCE_CRYSTALLIZE_CAP_PER_NODE,
                crossSessionOnly: false
              })
          }
        }),
    ...(conflictDetectionService === null
      ? {}
      : { enrichConflictDetectionPort: conflictDetectionService }),
    // invariant: the ~60s GardenScheduler pass re-drives owed path mints for
    // accept->mint crash-window orphans. see also: garden-runtime.ts
    // reconcileStuckEdgeProposalAccepts; edge-proposal-service.ts reconcileStuckAccepts.
    edgeProposalReconcile: edgeProposalService,
    warn: warnLogger.warn
  });
  const gardenTaskRepo =
    typeof (database.connection as { readonly prepare?: unknown }).prepare === "function"
      ? new SqliteGardenTaskRepo(database.connection, eventPublisher)
      : undefined;
  // The EDGE_CLASSIFY queue holder is safe to bind here because it is only used after init.
  if (gardenTaskRepo !== undefined) {
    edgeClassifyQueueRepoHolder.current = gardenTaskRepo;
  }
  const gardenBacklogTelemetryService = new GardenBacklogTelemetryService({
    scheduler: gardenRuntime.backlogTelemetrySource,
    eventLogRepo,
    runtimeNotifier,
    healthJournal: healthJournalService,
    thresholds: gardenBacklogThresholds,
    warn: warnLogger.warn
  });
  gardenRuntime.setBacklogTelemetryObserver(gardenBacklogTelemetryService);
  const initialGardenLastPassAt = await resolvePersistedGardenLastPassAt({
    healthJournalRepo,
    workspaceRepo,
    warn: warnLogger.warn
  });
  recordStartupStep(startupSteps, "garden-runtime");

  void gardenRuntime.runEventLogOrphanDetection().catch((error) => {
    warnLogger.warn("event log orphan reconciler failed", {
      error: error instanceof Error ? error.message : String(error)
    });
  });
  void reconcileBootstrapPathsForAllWorkspaces({
    workspaceRepo,
    workspaceService: securedWorkspaceService,
    warn: warnLogger.warn
  }).catch((error) => {
    warnLogger.warn("bootstrap reconcile loop crashed", {
      error: error instanceof Error ? error.message : String(error)
    });
  });
  await rebuildCountersFromEventLog(eventLogRepo, trustStateRecorder);
  trustStateRecorder.markReady();
  // Co-recall accrues only for embedding-coherent pairs; when embedding is off the gate stays unset.
  const CO_RECALL_COHERENCE_FLOOR = 0.5;
  const coRecallCoherenceGate =
    embeddingRecallService === undefined
      ? undefined
      : {
          coherentPairKeys: (
            workspaceId: string,
            deliveredObjectIds: readonly string[]
          ): Promise<ReadonlySet<string>> =>
            embeddingRecallService.coherentPairKeys({
              workspaceId,
              runId: null,
              objectIds: deliveredObjectIds,
              floor: CO_RECALL_COHERENCE_FLOOR
            })
        };
  return await finalizeAlayaDaemonRuntime({
    requestProtection,
    runtimeNotifier,
    startupSteps,
    bootstrapMcpToolingInput: {
      eventLogRepo,
      extensionDescriptorRepo,
      now: () => new Date().toISOString(),
      runtimeNotifier,
      toolSpecService,
      warnLogger
    },
    attachSurfaceRegistrarInput: {
      surfaceService,
      warn: warnLogger.warn
    },
    mcpMemoryToolHandlerInput: {
      recallService,
      memoryService,
      dynamicsService: {
        emitKarmaEvent: (input) => dynamicsService.emitKarmaEvent(input)
      },
      memoryEntryRepo,
      evidenceService,
      pathRelationProposalService,
      ...(coRecallCoherenceGate === undefined ? {} : { coRecallCoherenceGate }),
      objectAnchorGate: pathRelationProposalService,
      synthesisEvidenceReader: {
        findGistById: async (evidenceId: string, scopedWorkspaceId: string) => {
          const evidence = await evidenceService.findByIdScoped(evidenceId, scopedWorkspaceId);
          return evidence === null ? null : evidence.gist;
        }
      },
      synthesisMemberResolver: {
        findMemberObjectIdsByEvidenceRefs: async (
          scopedWorkspaceId: string,
          evidenceRefs: readonly string[]
        ) => {
          const capsuleEvidence = new Set(evidenceRefs);
          const members = await memoryEntryRepo.findByEvidenceRefs(scopedWorkspaceId, evidenceRefs);
          return members
            .filter((member) => member.evidence_refs.every((ref) => capsuleEvidence.has(ref)))
            .map((member) => member.object_id);
        }
      },
      signalService,
      graphExploreService,
      edgeProposalService,
      graphEdgePort,
      sessionOverrideService,
      trustStateRecorder,
      eventPublisher,
      ...(gardenTaskRepo === undefined ? {} : { gardenTaskRepo }),
      edgeVerdictApplier: {
        applyVerdict: (verdictInput) => edgeAutoProducerService.applyVerdict(verdictInput)
      },
      eventLogRepo,
      proposalRepo,
      runtimeNotifier,
      resolutionService,
      claimSourceReader: {
        findSourceObjectRefs: async (targetObjectId: string) => {
          const claim = await claimFormRepo.findById(targetObjectId);
          return claim === null ? null : claim.source_object_refs;
        }
      }
    },
    appInput: {
      requestProtection,
      remoteDaemonOptInEnabled,
      principalCodingEngineAvailable: principalCodingAvailability.available,
      repoRoot,
      filesDirectory,
      env: process.env,
      listServerHardConstraints,
      workspaceService: securedWorkspaceService,
      engineBindingService,
      workspaceGitBindingRepo: workspaceRepo,
      runService,
      workerRunRepo,
      toolExecutionRecordRepo,
      securityStatusService,
      embeddingStatusService,
      conversationService,
      runHotStateService,
      eventLogRepo,
      governanceLeaseService,
      sessionOverrideService,
      budgetBankruptcyService,
      contextLensAssembler,
      signalService,
      evidenceService,
      gardenBacklogTelemetryService,
      memoryService,
      greenService,
      healthJournalService,
      configService,
      environmentStatusService,
      slotService,
      arbitrationService,
      recallService,
      recallUtilizationService,
      singleUsedAnchorEmitter,
      deliveryAnchorReader,
      taskSurfaceBuilder,
      synthesisService,
      claimService,
      proposalService,
      proposalRepo,
      healthIssueGroupRepo,
      fileRepo,
      runtimeNotifier,
      topologyAuditService,
      graphExploreService,
      topologyService,
      soulApprovalService,
      soulGraphService,
      graphContractService,
      projectMappingService,
      globalMemoryService,
      warn: warnLogger.warn
    },
    lifecycleControlsInput: {
      warnLogger,
      gardenBacklogTelemetryService,
      gardenRuntime,
      securityStatusService,
      globalMemoryRecallInvalidationSubscription,
      requestProtection,
      database,
      intervalsToClear: [pathRelationEvictionTimer]
    },
    serviceExports: {
      environmentStatusService,
      embeddingStatusService,
      ...(embeddingRecallService === undefined ? {} : { embeddingRecallService }),
      graphHealthService,
      configService,
      recallService,
      signalService,
      synthesisService,
      pathRelationProposalService,
      recallUtilizationService,
      runService,
      trustStateRecorder,
      workspaceService: securedWorkspaceService,
      principalCodingEngineAvailable: principalCodingAvailability.available,
      gardenRuntime,
      initialGardenLastPassAt,
      gardenTaskRepo
    }
  });
}

export async function startDaemon(options: AlayaDaemonListenOptions = {}): Promise<AlayaDaemonServer> {
  const runtime = await createAlayaDaemonRuntime();
  return await runtime.startHttpServer(options);
}

if (process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], "file://").href) {
  await startDaemon();
}
