import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ComputeProviderPriority,
  ControlPlaneObjectKind,
  GardenTaskKind,
  HealthEventKind,
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
  type RuntimeGardenComputeConfig,
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
  ResolutionService,
  type ConflictDetectionLlmPort,
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
  rebuildCountersFromEventLog,
  warmCjkSegmentation,
  type ConversationServiceDependencies,
  type GlobalMemoryRecallSubscription
} from "@do-soul/alaya-core";
import {
  SqliteBootstrappingRecordRepo,
  SqliteClaimFormRepo,
  SqliteConfigRepo,
  SqliteConflictMatrixRepo,
  SqliteCrossCuttingPermissionRepo,
  SqliteDeferredObligationRepo,
  SqliteDriftLeaseRepo,
  SqliteEngineBindingRepo,
  SqliteEdgeProposalRepo,
  SqliteEventLogRepo,
  SqliteEvidenceCapsuleRepo,
  SqliteExtensionDescriptorRepo,
  SqliteFileRepo,
  SqliteGreenStatusRepo,
  SqliteGardenTaskRepo,
  SqliteHealthIssueGroupRepo,
  SqliteHealthJournalRepo,
  SqliteHandoffGapRepo,
  SqliteKarmaEventRepo,
  SqliteMemoryEntryRepo,
  SqliteOrphanRadarRepo,
  SqliteCoUsageCounterRepo,
  SqliteEnrichPendingRepo,
  SqlitePathGraphSnapshotRepo,
  SqlitePathPlasticityWatermarkRepo,
  SqlitePathRelationRepo,
  SqliteProjectMappingAnchorRepo,
  SqliteProposalRepo,
  SqliteReconciliationLeaseRepo,
  SqliteRunRepo,
  SqliteSignalRepo,
  SqliteSlotRepo,
  SqliteStrongRefRepo,
  SqliteSurfaceAnchorRepo,
  SqliteSurfaceBindingRepo,
  SqliteSurfaceIdentityRepo,
  SqliteSynthesisCapsuleRepo,
  SqliteToolExecutionRecordRepo,
  SqliteToolSpecRepo,
  SqliteTrustStateRepo,
  SqliteWorkerRunRepo,
  SqliteWorkspaceRepo,
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
  type ComputeRoutingCandidate,
  type GraphEdgeCreationPort,
  type PathRelationProposalPort
} from "@do-soul/alaya-soul";
import { createCoreDaemonApp } from "./daemon-app-composition.js";
import { createDaemonEmbeddingRuntime } from "./daemon-embedding-runtime.js";
import { createDaemonMcpMemoryToolHandler } from "./daemon-mcp-memory-handler.js";
import { createAttachSurfaceRegistrar } from "./attach-surface-registrar.js";
import { createBudgetProposalPort } from "./budget-wiring.js";
import { defaultBootstrappingTemplates, defaultCanonicalAliasMap } from "./daemon-defaults.js";
import { bootstrapDaemonMcpTooling } from "./daemon-mcp-tooling.js";
import {
  createManifestationBudgetConfigProvider,
  createWarnLogger,
  reconcileBootstrapPathsForAllWorkspaces
} from "./daemon-runtime-helpers.js";
import { createCoreDaemonLifecycleState, createDaemonLifecycleControls } from "./daemon-runtime-lifecycle.js";
import {
  createEngineBindingTester,
  createGardenBacklogThresholds,
  createGlobalMemoryRecallCachePort,
  createGlobalMemoryRecallPort,
  createGlobalMemoryRouteService,
  createOptionalGlobalMemoryRecallCacheRepo,
  createOptionalGlobalMemoryRepo,
  createRequestProtection,
  createSoulGraphService,
  listServerHardConstraints,
  loadConfigEnv,
  patchArbitrationClaimService,
  recordStartupStep,
  resolveDatabasePath,
  resolveEdgeClassifyWiring
} from "./daemon-runtime-support.js";
import { createReconciliationLlmDecisionPort } from "./reconciliation-llm-decision.js";
import { createEdgeAutoProducerLlmPort } from "./edge-auto-producer-llm-adapter.js";
import { createEdgeClassifyQueueAdapter } from "./edge-classify-queue-adapter.js";
import { resolveAlayaConfigDir, resolveAlayaConfigPaths } from "./cli/config-files.js";
import { resolveCoreDaemonFilesDirectory } from "./files-data-dir.js";
import {
  createTombstoneDispositionSweepPort,
  createTombstoneGcPort
} from "./forget-disposition-ports.js";
import { createGardenRuntime } from "./garden-runtime.js";
import { resolveSecretRef, type ResolveSecretError } from "./secrets.js";
import {
  createPathPlasticityService,
  createRecallPathPlasticityPort
} from "./path-plasticity-runtime.js";
import { SqliteHandoffGapAdapter } from "./handoff-gap-adapter.js";
import { createManifestationContextLensAssembler } from "./manifestation-context-lens-assembler.js";
import { parseZeroDayPoliciesJson } from "./zero-day-policies.js";
import { createRuntimeNotifier } from "./runtime-notifier.js";
import { createSecurityStatusBootstrapServices } from "./security-status-bootstrap.js";
import { isRemoteDaemonOptInEnabled } from "./server-options.js";
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
import { SqliteWorkspaceEngineConfigRepo } from "./services/workspace-engine-config-repo.js";
import { createTrustStateRecorder } from "./trust-state.js";
import { getBuiltinConversationToolSpecs } from "./builtin-conversation-tool-specs.js";
import type {
  AlayaDaemonListenOptions,
  AlayaDaemonRuntime,
  AlayaDaemonServer,
  DaemonStartupStepRecord
} from "./daemon-runtime-types.js";

export type { AlayaDaemonListenOptions, AlayaDaemonRuntime, AlayaDaemonRuntimeServices, AlayaDaemonServer, DaemonStartupStepRecord } from "./daemon-runtime-types.js";
export { resolveSecretRef } from "./secrets.js";
export type { ResolveSecretError, ResolvedSecret, SecretRefReader } from "./secrets.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..", "..");
const DEFAULT_GARDEN_STATUS_WORKSPACE_ID = "default";
// doctor/status host_worker advisory: a POST_TURN_EXTRACT task claimed but not
// completed within this window counts as a stale (abandoned) claim. Mirrors the
// garden-runtime stale-claim TTL (10 min) so the advisory's "abandoned" count
// agrees with what the scheduler will reclaim back to pending.
const HOST_WORKER_EXTRACT_ADVISORY_STALE_MS = 10 * 60 * 1000;

export async function createAlayaDaemonRuntime(): Promise<AlayaDaemonRuntime> {
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
  // see also: packages/core/src/cjk-segmentation.ts,
  //          packages/storage/src/repos/shared/cjk-segmentation.ts.
  await Promise.all([
    warmCjkSegmentation(),
    warmStorageCjkSegmentation()
  ]);
  const startupSteps: DaemonStartupStepRecord[] = [];
  const warnLogger = createWarnLogger();
  const runtimeNotifier = createRuntimeNotifier();
  const requestProtection = createRequestProtection();
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

  const workspaceRepo = new SqliteWorkspaceRepo(database);
  const runRepo = new SqliteRunRepo(database);
  const bindingRepo = new SqliteEngineBindingRepo(database);
  const bootstrappingRecordRepo = new SqliteBootstrappingRecordRepo(database);
  const configRepo = new SqliteConfigRepo(database);
  const eventLogRepo = new SqliteEventLogRepo(database);
  const reconciliationLeaseRepo = new SqliteReconciliationLeaseRepo(database);
  const signalRepo = new SqliteSignalRepo(database);
  const edgeProposalRepo = new SqliteEdgeProposalRepo(database);
  const evidenceCapsuleRepo = new SqliteEvidenceCapsuleRepo(database);
  const memoryEntryRepo = new SqliteMemoryEntryRepo(database, (message, meta) =>
    warnLogger.warn(message, meta)
  );
  const globalMemoryRepo = createOptionalGlobalMemoryRepo(database);
  const globalMemoryRecallCacheRepo = createOptionalGlobalMemoryRecallCacheRepo(database);
  const orphanDetectionEnabled = process.env.ORPHAN_DETECTION_ENABLED !== "false";
  const orphanRadarRepo = orphanDetectionEnabled ? new SqliteOrphanRadarRepo(database) : null;
  const projectMappingAnchorRepo = new SqliteProjectMappingAnchorRepo(database);
  const synthesisCapsuleRepo = new SqliteSynthesisCapsuleRepo(database);
  const claimFormRepo = new SqliteClaimFormRepo(database);
  const conflictMatrixRepo = new SqliteConflictMatrixRepo(database);
  const slotRepo = new SqliteSlotRepo(database);
  const surfaceIdentityRepo = new SqliteSurfaceIdentityRepo(database);
  const surfaceAnchorRepo = new SqliteSurfaceAnchorRepo(database);
  const surfaceBindingRepo = new SqliteSurfaceBindingRepo(database);
  const crossCuttingPermissionRepo = new SqliteCrossCuttingPermissionRepo(database);
  const proposalRepo = new SqliteProposalRepo(database);
  const greenStatusRepo = new SqliteGreenStatusRepo(database);
  const healthJournalRepo = new SqliteHealthJournalRepo(database);
  const fileRepo = new SqliteFileRepo(database);
  const karmaEventRepo = new SqliteKarmaEventRepo(database);
  const toolSpecRepo = new SqliteToolSpecRepo(database);
  const toolExecutionRecordRepo = new SqliteToolExecutionRecordRepo(database);
  const extensionDescriptorRepo = new SqliteExtensionDescriptorRepo(database);
  const trustStateRepo = new SqliteTrustStateRepo(database);
  const strongRefRepo = new SqliteStrongRefRepo(database);
  const pathRelationRepo = new SqlitePathRelationRepo(database);
  const coUsageCounterRepo = new SqliteCoUsageCounterRepo(database);
  const enrichPendingRepo = new SqliteEnrichPendingRepo(database);
  // invariant: single enrich_pending enqueue adapter shared by the atomic
  // create+marker seam (core MemoryService.enrichPendingWriter) and the
  // router's loud fallback port (enrichPendingPort). enqueuedAt is stamped here.
  const enqueueEnrichPending = (params: {
    readonly workspaceId: string;
    readonly memoryId: string;
    readonly runId: string | null;
    readonly sourceSignalId: string | null;
  }): void =>
    enrichPendingRepo.enqueue({
      workspaceId: params.workspaceId,
      memoryId: params.memoryId,
      runId: params.runId,
      sourceSignalId: params.sourceSignalId,
      enqueuedAt: new Date().toISOString()
    });
  const pathPlasticityWatermarkRepo = new SqlitePathPlasticityWatermarkRepo(database);
  const pathGraphSnapshotRepo = new SqlitePathGraphSnapshotRepo(database);
  const deferredObligationRepo = new SqliteDeferredObligationRepo(database);
  const workerRunRepo = new SqliteWorkerRunRepo(database);
  const workspaceEngineConfigRepo = new SqliteWorkspaceEngineConfigRepo(database);
  const sqliteHandoffGapRepo = new SqliteHandoffGapRepo(database);
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
    // packages/core/src/memory-service.ts compressedPreservationStillValid
    synthesisCapsuleLookup: {
      findById: (objectId: string) => synthesisCapsuleRepo.findById(objectId)
    },
    // invariant: atomic create + enrich_pending no-drop marker. When a create
    // input carries an enqueueEnrichment intent, the row insert and this enqueue
    // commit in one storage transaction. see also:
    // packages/core/src/memory-service.ts createRowMaybeAtomicallyEnqueued
    enrichPendingWriter: { enqueue: enqueueEnrichPending }
  });
  const graphExploreService = new GraphExploreService({
    // soul.explore_graph and recall graph_support counts both read the unified
    // path plane via pathRelationRepo; this service is path-only.
    pathRepo: pathRelationRepo,
    eventLogRepo
  });
  const edgeProposalService = new EdgeProposalService({
    memoryRepo: memoryEntryRepo,
    proposalRepo: edgeProposalRepo,
    // invariant: accept mints a governed PathRelation, not a
    // memory_graph_edges row. The closure forward-references
    // pathRelationProposalService (declared below); it is only invoked at
    // accept time, long after init, so there is no use-before-assignment.
    // see also: packages/core/src/edge-proposal-service.ts acceptProposal.
    pathCandidatePort: {
      submitCandidate: async (input) => await pathRelationProposalService.submitCandidate(input)
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
  const globalMemoryService =
    globalMemoryRepo === null
      ? undefined
      : createGlobalMemoryRouteService({
          globalMemoryRepo,
          projectMappingService
        });
  const globalMemoryRecallService =
    globalMemoryRepo === null
      ? undefined
      : createGlobalMemoryRecallPort({
          globalMemoryRepo
        });
  const globalMemoryRecallInvalidationSubscription: GlobalMemoryRecallSubscription | null =
    globalMemoryRecallService?.subscribeToInvalidations(runtimeNotifier) ?? null;
  const {
    embeddingStatusService,
    embeddingRecallService,
    embeddingBackfillHandler,
    defaultPolicyDecorator: embeddingDefaultPolicyDecorator,
    providerWarmup: embeddingProviderWarmup
  } = createDaemonEmbeddingRuntime({
    database,
    configEnv,
    eventLogRepo,
    healthJournalService,
    memoryEntryRepo,
    warn: warnLogger.warn
  });
  // Fire-and-forget: the embedding provider warmup runs alongside the rest of
  // daemon boot. We attach a non-blocking observer so the warmup outcome is
  // visible in daemon logs, without gating any caller on it; the dynamic
  // provider.isAvailable gate and the EmbeddingRecallService degradation
  // events handle failures.
  embeddingProviderWarmup
    .then((status) => {
      if (status === "ready") {
        warnLogger.warn("embedding provider warmup ready", { status });
      }
    })
    .catch(() => undefined);
  const recallPathPlasticityPort = createRecallPathPlasticityPort({
    pathRelationRepo
  });
  // invariant: PathActivationCandidateProducer reads PathRelation rows
  // anchored on the recall candidate memory ids. The reader port adapter
  // expands each memory id to an `object` PathAnchorRef, queries
  // pathRelationRepo.findByAnchors, and filters out non-active rows
  // (retired and dormant) so only recall-active paths reach activation.
  const pathActivationReaderPort: PathActivationCandidateProducerPathReaderPort = {
    async findActiveByAnchorObjectIds(workspaceId, memoryObjectIds) {
      if (memoryObjectIds.length === 0) {
        return [];
      }
      const anchors = memoryObjectIds.map((objectId) => ({
        kind: "object" as const,
        object_id: objectId
      }));
      const paths = await pathRelationRepo.findByAnchors(workspaceId, anchors);
      return paths.filter((path) => isPathActiveForRecall(path.lifecycle.status));
    }
  };
  const pathActivationCandidateProducer = new PathActivationCandidateProducer({
    pathReader: pathActivationReaderPort
  });
  // invariant: ManifestationResolver is instantiated lazily, only when a
  // recall actually yields activation candidates. The daemon avoids
  // constructing it at boot so the live ContextLens seam remains
  // pass-through until paths produce candidates.
  let manifestationResolverInstance: ManifestationResolver | null = null;
  const getManifestationResolver = (): ManifestationResolver => {
    if (manifestationResolverInstance === null) {
      manifestationResolverInstance = new ManifestationResolver({
        budgetConfigProvider: manifestationBudgetConfigProvider,
        eventLogWriter: {
          append: async (entry) => eventLogRepo.append(entry)
        }
      });
    }
    return manifestationResolverInstance;
  };
  const manifestationSidecarPort = {
    buildBiasSidecar: async (params: Readonly<{
      readonly workspaceId: string;
      readonly runId: string;
      readonly anchorMemoryObjectIds: readonly string[];
      readonly taskSurfaceRef: Parameters<ManifestationResolver["resolveWithBias"]>[0]["taskSurfaceRef"];
    }>) => {
      const candidates = await pathActivationCandidateProducer.produce({
        workspaceId: params.workspaceId,
        runId: params.runId,
        anchorMemoryObjectIds: params.anchorMemoryObjectIds
      });
      if (candidates.length === 0) {
        return [];
      }
      const result = await getManifestationResolver().resolveWithBias({
        workspaceId: params.workspaceId,
        runId: params.runId,
        candidates,
        taskSurfaceRef: params.taskSurfaceRef
      });
      return result.biasSidecar;
    }
  };
  const recallUtilizationService = createRecallUtilizationService({ eventLogRepo });
  const singleUsedAnchorEmitter: SingleUsedAnchorTelemetryEmitter = {
    async emit(input) {
      const event = {
        event_type: RecallContextEventType.SOUL_SINGLE_USED_ANCHOR,
        entity_type: "context_delivery",
        entity_id: input.deliveryId,
        workspace_id: input.workspaceId,
        run_id: input.runId,
        caused_by: input.agentTarget,
        payload_json: buildSingleUsedAnchorPayload({
          deliveryId: input.deliveryId,
          sessionId: input.sessionId,
          runId: input.runId,
          agentTarget: input.agentTarget,
          workspaceId: input.workspaceId,
          occurredAt: input.occurredAt,
          usedAnchorObjectId: input.usedAnchorObjectId
        })
      } as const;
      try {
        await eventPublisher.appendManyWithMutation([event], () => undefined);
      } catch {
        // invariant: telemetry emission never propagates failure to the route.
      }
    }
  };
  // invariant: looks up the delivered_object_ids for a delivery so the
  // SOUL_SINGLE_USED_ANCHOR payload can attribute the reuse to a
  // concrete anchor when pointer_count === 1.
  const deliveryAnchorReader = {
    async findDeliveredObjectIds(deliveryId: string): Promise<readonly string[] | null> {
      const delivery = await trustStateRecorder.findDeliveryById(deliveryId);
      return delivery === null ? null : delivery.delivered_object_ids;
    }
  };
  const recallPathExpansionPort = {
    findByAnchors: pathRelationRepo.findByAnchors.bind(pathRelationRepo),
    findByTimeConcernWindowDigests: async (
      workspaceId: string,
      windowDigests: readonly string[]
    ) => {
      const normalized = new Set(windowDigests.map(normalizeRecallTimeConcernWindowDigest));
      const paths = await pathRelationRepo.findByWorkspace(workspaceId);
      return paths.filter((path) =>
        isPathActiveForRecall(path.lifecycle.status) &&
        [path.anchors.source_anchor, path.anchors.target_anchor].some((anchor) =>
          anchor.kind === "time_concern" &&
          normalized.has(normalizeRecallTimeConcernWindowDigest(anchor.window_digest))
        )
      );
    }
  };
  const recallActiveConstraintsPort = {
    findActiveConstraints: async (
      input: Readonly<{ readonly workspaceId: string; readonly cap?: number | null }>
    ) => {
      const result = await findActiveConstraints({
        workspaceId: input.workspaceId,
        memoryRepo: memoryEntryRepo,
        claimFormRepo,
        pathRelationRepo,
        cap: input.cap
      });
      return Object.freeze({
        constraints: Object.freeze(result.constraints.map((record) =>
          SoulActiveConstraintSchema.parse({
            object_id: record.memory.object_id,
            object_kind: record.memory.object_kind,
            content: record.memory.content,
            dimension: record.memory.dimension,
            scope_class: record.memory.scope_class,
            governance_state: {
              claim_status: record.claim_status,
              governance_class: record.governance_class,
              source_channels: record.source_channels
            }
          })
        )),
        total_count: result.total_count
      });
    }
  };
  const recallService = new RecallService({
    memoryRepo: memoryEntryRepo,
    slotRepo,
    eventLogRepo,
    graphSupportPort: graphExploreService,
    projectMappingPort: projectMappingService,
    pathPlasticityPort: recallPathPlasticityPort,
    pathExpansionPort: recallPathExpansionPort,
    activeConstraintsPort: recallActiveConstraintsPort,
    evidenceSearchPort: {
      searchByKeyword: async (workspaceId, queryText, limit) =>
        evidenceCapsuleRepo.searchByKeyword === undefined
          ? []
          : await evidenceCapsuleRepo.searchByKeyword(workspaceId, queryText, limit),
      findByIds: async (workspaceId, evidenceObjectIds) => {
        const results = await evidenceCapsuleRepo.findByIds(evidenceObjectIds);
        const scoped = [];
        for (const evidence of results) {
          if (evidence.workspace_id === workspaceId) {
            scoped.push(evidence);
          }
        }
        return scoped;
      }
    },
    // L2 synthesis FTS source. Recall joins synthesis_capsule hits as an
    // additional candidate channel. see also: migration 079.
    synthesisSearchPort: {
      searchByKeyword: async (workspaceId, queryText, limit) =>
        synthesisCapsuleRepo.searchByKeyword === undefined
          ? []
          : await synthesisCapsuleRepo.searchByKeyword(workspaceId, queryText, limit),
      findByIds: async (objectIds) => {
        const scoped = [];
        for (const objectId of objectIds) {
          const synthesis = await synthesisCapsuleRepo.findById(objectId);
          if (synthesis !== null) {
            scoped.push(synthesis);
          }
        }
        return scoped;
      }
    },
    ...(globalMemoryRepo === null
      ? {}
      : {
          globalRecallPort: globalMemoryRecallService,
          ...(globalMemoryRecallCacheRepo === null
            ? {}
            : {
                globalRecallCachePort: createGlobalMemoryRecallCachePort({
                  globalMemoryRecallCacheRepo,
                  now: () => new Date().toISOString()
                })
              })
        }),
    budgetPenaltyPort: {
      getSnapshot: async (runId: string) => await budgetBankruptcyService.getSnapshot(runId, budgetNow())
    },
    claimResolverPort: claimFormRepo,
    embeddingRecallService,
    manifestationSidecarPort,
    ...(embeddingDefaultPolicyDecorator === undefined
      ? {}
      : { defaultPolicyDecorator: embeddingDefaultPolicyDecorator }),
    // see also: packages/core/src/entity-extraction-rules.ts
    entityExtractionPort: new RuleBasedEntityExtractor(),
    warn: warnLogger.warn
  });
  const contextLensAssembler = new ContextLensAssembler({
    recallService,
    taskSurfaceBuilder,
    slotRepo,
    claimRepo: claimFormRepo,
    memoryRepo: memoryEntryRepo,
    eventLogRepo,
    overrideService: sessionOverrideService,
    degradationPipeline: new DegradationPipeline(),
    bankruptcyService: budgetBankruptcyService,
    warn: warnLogger.warn
  });
  const conversationContextLensAssembler = createManifestationContextLensAssembler({
    delegate: contextLensAssembler
  });
  const sqliteHandoffGapAdapter = new SqliteHandoffGapAdapter(sqliteHandoffGapRepo);
  // Shared automatic graph-edge producer port. Producers create reviewable
  // proposals; only EdgeProposalService.batchReview(accept) writes edges.
  const graphEdgePort: GraphEdgeCreationPort = {
    createEdge: async (params) => {
      await edgeProposalService.proposeEdge(params);
    }
  };
  // invariant: the folded edge producers (EdgeAutoProducer,
  // ConflictDetectionService, signal-ref router) submit governed path
  // candidates here instead of writing memory_graph_edges. The closure
  // forward-references pathRelationProposalService (declared below); it is
  // only invoked at materialization time, long after init, so there is no
  // use-before-assignment. governance is clamped to recall_allowed and
  // plasticity decides promotion downstream.
  // see also: packages/core/src/path-candidate-sink.ts PathCandidateSink.
  const pathCandidatePort: PathCandidateSink = {
    submitCandidate: async (input) => await pathRelationProposalService.submitCandidate(input)
  };
  // invariant: the product default is zero-own-LLM. The synchronous in-process
  // edge-LLM pair-classifier (a direct cloud call from the daemon) is STRICT
  // OPT-IN — it runs only when an operator sets ALAYA_EDGE_PRODUCER_LLM_ENABLED
  // to 1/true. With host_worker the product default and this flag unset, B-2
  // edge classification makes NO external call: the deterministic heuristic
  // produces the edge inline and, under host_worker, the LLM-quality verdict is
  // deferred to the attached CLI agent via the EDGE_CLASSIFY garden task. The
  // garden compute config is read once and shared so the routing decision below
  // (host_worker -> defer) and the opt-in cloud port use a single source of
  // truth. invariant: no new cloud dependency may be introduced here; the cloud
  // port runs on the operator's existing official_api garden compute config or
  // is disabled.
  const sharedGardenComputeConfig = await rawConfigService.getRuntimeGardenComputeConfig();
  // invariant: the single B-2 edge-classify routing decision. resolveEdgeClassifyWiring
  // is the PURE source of truth for cloud-llm vs host-worker-defer vs
  // heuristic-only; index.ts must derive both branches from it so the
  // zero-cloud-by-default guarantee cannot drift between the daemon and its
  // regression test. see also: daemon-runtime-support.ts resolveEdgeClassifyWiring.
  const edgeClassifyWiring = resolveEdgeClassifyWiring(
    process.env,
    sharedGardenComputeConfig
  );
  const edgeAutoProducerLlmEnabled = edgeClassifyWiring.llmEnabled;
  const edgeAutoProducerGardenComputeConfig = edgeAutoProducerLlmEnabled
    ? sharedGardenComputeConfig
    : null;
  const edgeAutoProducerGardenApiKey = ((): string | null => {
    if (
      edgeAutoProducerGardenComputeConfig === null ||
      !canResolveOfficialGardenProvider(edgeAutoProducerGardenComputeConfig)
    ) {
      return null;
    }
    try {
      return resolveGardenSecretRefValue(
        edgeAutoProducerGardenComputeConfig.secret_ref as string
      );
    } catch {
      return null;
    }
  })();
  // The synchronous cloud port is created only when opt-in AND the official_api
  // garden config resolves a real key AND that config carries an explicit
  // provider_url. providerUrl/model come straight from that config — there is NO
  // yunwu.ai default URL: an opt-in without a configured provider_url leaves the
  // port null, so the service falls back to the deterministic heuristic instead
  // of calling out to a hardcoded host.
  const edgeAutoProducerProviderUrl =
    edgeAutoProducerGardenComputeConfig?.provider_url ?? null;
  const edgeAutoProducerLlmPort =
    edgeAutoProducerLlmEnabled &&
    edgeAutoProducerGardenApiKey !== null &&
    edgeAutoProducerProviderUrl !== null
      ? createEdgeAutoProducerLlmPort({
          config: {
            providerUrl: edgeAutoProducerProviderUrl,
            model:
              edgeAutoProducerGardenComputeConfig?.model_id ?? OFFICIAL_API_GARDEN_MODEL,
            apiKey: edgeAutoProducerGardenApiKey
          }
        })
      : null;
  // invariant: host-worker defer for the B-2 LLM-quality verdict. When ON (mode
  // == "host_worker_defer"), the EDGE_CLASSIFY garden task is enqueued for the
  // attached CLI agent (the compute) instead of the synchronous in-process
  // llmPort; the deterministic heuristic still produces the edge inline for
  // strong-overlap pairs. Auto-ON whenever the resolved garden compute
  // provider_kind is host_worker (the product default) so edge-classify routes
  // to the agent rather than a cloud call; an operator can also force it with
  // ALAYA_EDGE_CLASSIFY_HOST_WORKER=1/true regardless of provider_kind. The
  // gardenTaskRepo the queue closure reads is created later in init; the closure
  // is only invoked at materialization time, long after assignment, so there is
  // no use-before-assignment. The branch is derived from the same pure
  // resolveEdgeClassifyWiring decision as edgeAutoProducerLlmEnabled.
  // see also: edge-classify-queue-adapter.ts.
  const edgeClassifyHostWorkerEnabled = edgeClassifyWiring.hostWorkerEnabled;
  let edgeClassifyQueueRepoHolder:
    | { enqueue: typeof SqliteGardenTaskRepo.prototype.enqueue; findById: typeof SqliteGardenTaskRepo.prototype.findById }
    | undefined;
  const edgeClassifyQueue = edgeClassifyHostWorkerEnabled
    ? createEdgeClassifyQueueAdapter({
        gardenTaskRepo: {
          enqueue: (input) => {
            if (edgeClassifyQueueRepoHolder === undefined) {
              throw new Error("EDGE_CLASSIFY queue used before the garden task repo was wired.");
            }
            return edgeClassifyQueueRepoHolder.enqueue(input);
          },
          findById: (taskId) => {
            if (edgeClassifyQueueRepoHolder === undefined) {
              return null;
            }
            const row = edgeClassifyQueueRepoHolder.findById(taskId);
            return row === null ? null : { id: row.id };
          }
        },
        now: () => new Date().toISOString(),
        warn: warnLogger.warn
      })
    : null;
  const edgeAutoProducerService = new EdgeAutoProducerService({
    memoryRepo: memoryEntryRepo,
    pathCandidatePort,
    // invariant: directional-dedup read port. applyVerdict consults the path
    // plane to collapse a heuristic+host-verdict family-swap (e.g. heuristic
    // supports vs verdict derives_from on the SAME ordered pair) into one
    // positive-associative slot, so an untrusted worker verdict cannot mint a
    // SECOND parallel positive path and double the pair's recall-bias.
    existingPathReader: {
      findByBackingObjectId: (workspaceId, objectId) =>
        pathRelationRepo.findByBackingObjectId(workspaceId, objectId)
    },
    // invariant: when the host-worker queue is wired the synchronous llmPort is
    // NOT passed — the LLM-quality verdict is deferred. The service still runs
    // the heuristic inline either way.
    ...(edgeClassifyQueue !== null
      ? { edgeClassifyQueue }
      : edgeAutoProducerLlmPort === null
        ? {}
        : { llmPort: edgeAutoProducerLlmPort }),
    warn: warnLogger.warn
  });
  // invariant: ConflictDetectionService rule path is ON by default.
  // Rule-path findings submit governed negative-family path candidates
  // through pathCandidatePort (recall_bias -); durable truth is
  // never mutated by this service alone, and no permanent edge is
  // auto-accepted. The cost of findByDimension + findByWorkspaceId is
  // paid per materialization; high-frequency seeding paths (bench
  // harness, bulk import) opt OUT with ALAYA_CONFLICT_DETECTION_ENABLED=0.
  // The LLM ambiguous-band path stays disabled by default (it would
  // re-introduce a per-materialization cloud call) and is gated by the
  // separate createConflictDetectionLlmPort credentials check.
  const conflictDetectionEnabled = (() => {
    const raw = process.env.ALAYA_CONFLICT_DETECTION_ENABLED?.toLowerCase();
    if (raw === undefined || raw === "") {
      return true;
    }
    return raw !== "0" && raw !== "false";
  })();
  const conflictDetectionLlmPort = conflictDetectionEnabled
    ? createConflictDetectionLlmPort()
    : null;
  const conflictDetectionRuleEnabled = (() => {
    const raw = process.env.ALAYA_CONFLICT_RULE_ENABLED?.toLowerCase();
    if (raw === undefined || raw === "") {
      return true;
    }
    return raw !== "0" && raw !== "false";
  })();
  const conflictDetectionService = conflictDetectionEnabled
    ? new ConflictDetectionService({
        memoryRepo: {
          findByDimension: async (workspaceId, dimension) =>
            await memoryEntryRepo.findByDimension(workspaceId, dimension),
          findBySharedDomainTags: async (workspaceId, tags) =>
            await memoryEntryRepo.findBySharedDomainTags(workspaceId, tags)
        },
        pathCandidatePort,
        ...(conflictDetectionLlmPort === null ? {} : { llmPort: conflictDetectionLlmPort }),
        karmaEmitter: {
          emitKarmaEvent: (input) => dynamicsService.emitKarmaEvent(input)
        },
        ruleEnabled: conflictDetectionRuleEnabled,
        warn: warnLogger.warn
      })
    : null;
  // invariant: ingest reconciliation is opt-in — the bench enables it via
  // ALAYA_INGEST_RECONCILIATION_ENABLED to measure token economy; the
  // production default is blind append. The two ingest behaviors diverging
  // by flag is intentional, not an oversight (recall-optimization §18a). It
  // covers the materializeMemoryEntryOnly path (the bench `fact` kind);
  // materialize_and_claim is intentionally not reconciled.
  // When enabled each fact pays one lexical FTS query, a findByIds
  // fetch, and — only for an ambiguous-band neighbor — one disk-cached
  // garden-LLM decision call. The LLM is the field-standard semantic
  // judge of refines-vs-distinct; a token-superset heuristic wrongly
  // merges distinct facts and erases answers. The DELETE / supersede
  // path stays owned by ConflictDetectionService; reconciliation only
  // flags it.
  // see also: packages/core/src/reconciliation-service.ts
  const ingestReconciliationEnabled =
    process.env.ALAYA_INGEST_RECONCILIATION_ENABLED === "1" ||
    process.env.ALAYA_INGEST_RECONCILIATION_ENABLED?.toLowerCase() === "true";
  // The ambiguous-band decision needs the garden LLM. The credential is
  // the canonical garden compute config's secret_ref — the same one the
  // garden compute provider resolves — RESOLVED here to the live key.
  // Passing the secret-ref string straight through would send
  // `Authorization: Bearer file:/…` and 401 every decision.
  //
  // The whole config — provider_url, model_id, secret_ref — is read ONCE
  // so providerUrl and model are always a matched pair (two independent
  // reads could pair a stale URL with a fresh model). The secret_ref is
  // resolved ONLY when the config satisfies the same enabled /
  // provider_kind condition canResolveOfficialGardenProvider uses, so a
  // disabled or local-heuristics garden never credentials reconciliation
  // off a config it does not actually drive. An unresolved ref yields
  // apiKey:null so createReconciliationLlmDecisionPort returns null and
  // reconciliation cleanly stays off — an honest no-op beats a silently
  // weakened gate.
  const reconciliationGardenComputeConfig =
    ingestReconciliationEnabled
      ? await rawConfigService.getRuntimeGardenComputeConfig()
      : null;
  const reconciliationGardenApiKey = ((): string | null => {
    if (
      reconciliationGardenComputeConfig === null ||
      !canResolveOfficialGardenProvider(reconciliationGardenComputeConfig)
    ) {
      return null;
    }
    try {
      return resolveGardenSecretRefValue(reconciliationGardenComputeConfig.secret_ref as string);
    } catch {
      return null;
    }
  })();
  // invariant: reconciliation's per-fact refines-vs-distinct decision routes
  // through the SAME zero-own-LLM compute model as B-2 — it never operates a
  // self-owned cloud LLM and there is NO yunwu.ai default URL. The cloud
  // decision port is created only when the official_api garden config resolves
  // a real key (reconciliationGardenApiKey !== null, which already requires
  // provider_kind=official_api + enabled) AND that config carries an explicit
  // provider_url. Under the host_worker product default the key is null, so the
  // port is null and reconciliation cleanly stays off (an honest no-op — the
  // host-worker / rule path owns the decision, not a daemon-operated LLM).
  // providerUrl + model are taken as one unit from the resolved garden config so
  // a stale URL can never pair with a fresh model.
  const reconciliationProviderUrl = reconciliationGardenComputeConfig?.provider_url ?? null;
  const reconciliationLlmDecisionPort =
    ingestReconciliationEnabled &&
    reconciliationGardenApiKey !== null &&
    reconciliationProviderUrl !== null
      ? createReconciliationLlmDecisionPort({
          config: {
            providerUrl: reconciliationProviderUrl,
            model: reconciliationGardenComputeConfig?.model_id ?? OFFICIAL_API_GARDEN_MODEL,
            apiKey: reconciliationGardenApiKey
          }
        })
      : null;
  const reconciliationService =
    ingestReconciliationEnabled && reconciliationLlmDecisionPort !== null
      ? new ReconciliationService({
          keywordSearch: {
            searchByKeyword: async (workspaceId, queryText, limit) =>
              await memoryEntryRepo.searchByKeyword(workspaceId, queryText, limit)
          },
          memoryRepo: {
            findByIds: async (objectIds) => await memoryEntryRepo.findByIds(objectIds)
          },
          memoryUpdate: {
            update: async (objectId, fields, reason) =>
              await memoryService.update(objectId, fields, reason)
          },
          eventLog: {
            append: (event) => eventLogRepo.append(event)
          },
          llmDecision: reconciliationLlmDecisionPort,
          lease: reconciliationLeaseRepo,
          warn: warnLogger.warn
        })
      : null;
  const pathRelationCounterTtlMs = (() => {
    const raw = process.env.ALAYA_PATHREL_COUNTER_TTL_MS;
    if (raw === undefined || raw === "") {
      return undefined;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  })();
  // Override-capable co-usage threshold. Default (undefined) falls through to
  // DYNAMICS_CONSTANTS.path_plasticity.co_usage_threshold inside the service;
  // bench lowers it to surface paths early.
  const pathRelationCoUsageThreshold = (() => {
    const raw = process.env.ALAYA_PATHREL_CO_USAGE_THRESHOLD;
    if (raw === undefined || raw === "") {
      return undefined;
    }
    const parsed = Number(raw);
    return Number.isInteger(parsed) && parsed >= 1 ? parsed : undefined;
  })();
  const pathRelationProposalService = new PathRelationProposalService({
    repo: {
      create: (relation) => pathRelationRepo.create(relation),
      findByAnchorMemoryId: async (memoryId, workspaceId) =>
        await pathRelationRepo.findByBackingObjectId(workspaceId, memoryId)
    },
    counterStore: coUsageCounterRepo,
    // invariant: object-anchor mints are gated by real memory existence +
    // ownership at the durable sink. findById returns the owning workspace so
    // an agent/Garden ref to a missing or cross-workspace object is refused
    // before any path_relations row is written.
    // see also: packages/core/src/path-relation-proposal-service.ts validateObjectAnchors
    memoryExistence: {
      workspaceOfObject: async (objectId) => {
        const entry = await memoryEntryRepo.findById(objectId);
        return entry === null ? null : entry.workspace_id;
      }
    },
    eventPublisher,
    // invariant: D-EDGEAUDIT. Forward-references the health-inbox adapter
    // (declared after healthIssueGroupRepo below); invoked only at anchor-reject
    // time, long after init. see also: pathFailureHealthInboxPort.
    healthInboxPort: {
      recordPathRelationFailure: (entry) => pathFailureHealthInboxPort.recordPathRelationFailure(entry)
    },
    ...(pathRelationCounterTtlMs === undefined ? {} : { counterTtlMs: pathRelationCounterTtlMs }),
    ...(pathRelationCoUsageThreshold === undefined ? {} : { threshold: pathRelationCoUsageThreshold }),
    warn: warnLogger.warn
  });
  // invariant: durable counter rows are bounded by periodic eviction. The
  // daemon sweeps once per TTL interval; sub-threshold pairs whose updated_at
  // is older than the TTL are DELETEd so long no-promote tails do not grow.
  // invariant: DeferredObligationService is the producer for path-anchor
  // `obligation` refs and the destination of soul.resolve `defer`
  // resolutions. Wired into the daemon so its create/fulfill/expire ports
  // are callable from the materialization router and the resolve handler.
  const deferredObligationService = new DeferredObligationService({
    repo: deferredObligationRepo,
    eventPublisher
  });
  // invariant: ResolutionService is the typed dispatcher behind
  // soul.resolve. confirm activates draft claims; defer creates
  // obligations through DeferredObligationService; stale flips
  // memory_entry active -> dormant.
  // see also: packages/core/src/resolution-service.ts
  // see also: apps/core-daemon/src/mcp-memory-resolve-handler.ts
  const resolutionService = new ResolutionService({
    eventPublisher,
    claimRepo: claimFormRepo,
    memoryRepo: memoryEntryRepo,
    claimService,
    memoryService,
    deferredObligationService
  });
  const pathRelationEvictionIntervalMs = pathRelationCounterTtlMs ?? PATH_RELATION_COUNTER_DEFAULT_TTL_MS;
  const pathRelationEvictionTimer = setInterval(() => {
    void pathRelationProposalService.evictExpired().catch((error: unknown) => {
      warnLogger.warn("PathRelation counter eviction failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }, pathRelationEvictionIntervalMs);
  pathRelationEvictionTimer.unref?.();
  const pathRelationProposalPort: PathRelationProposalPort = {
    assertPathRelationProposalAvailable: async (input) => {
      await proposalRepo.countPending(input.workspaceId);
    },
    createPathRelationProposal: async (input) => {
      const timestamp = new Date().toISOString();
      const proposalId = randomUUID();
      const proposal = ProposalSchema.parse({
        runtime_id: proposalId,
        object_kind: ControlPlaneObjectKind.PROPOSAL,
        task_surface_ref: null,
        expires_at: null,
        derived_from: input.targetObjectId,
        retention_policy: RetentionPolicy.SESSION_ONLY,
        proposal_id: proposalId,
        dossier_ref: null,
        recommended_option_id: null,
        proposal_options: [
          {
            option_id: `path_relation_${proposalId}`,
            option_kind: ProposalOptionKind.REQUEST_CONFIRMATION,
            preserves_protected_constraints: true,
            dropped_candidates: [],
            unresolved_after_apply: [],
            requires_confirmation: true
          }
        ],
        resolution_state: ProposalResolutionState.PENDING,
        last_updated_at: timestamp
      });
      const created = await proposalRepo.createProposalWithEvents(
        {
          proposal,
          workspace_id: input.workspaceId,
          run_id: input.runId,
          target_object_kind: "path_relation",
          proposed_change_summary: `${input.reason} Source signal: ${input.sourceSignalId}.`,
          proposed_path_relation: input.proposedPathRelation,
          created_at: timestamp
        },
        [
          {
            event_type: MemoryGovernanceEventType.SOUL_PROPOSAL_CREATED,
            entity_type: "proposal",
            entity_id: proposal.proposal_id,
            workspace_id: input.workspaceId,
            run_id: input.runId,
            caused_by: "garden",
            payload_json: SoulProposalCreatedPayloadSchema.parse({
              object_id: proposal.runtime_id,
              object_kind: proposal.object_kind,
              workspace_id: input.workspaceId,
              run_id: input.runId
            })
          }
        ]
      );
      for (const event of created.events) {
        await runtimeNotifier.notifyEntry(event);
      }
      return {
        object_kind: "proposal",
        object_id: created.proposal.proposal_id
      };
    }
  };
  // invariant: write-path/enrich-path decouple (S3c). The router no longer runs
  // edge auto-production / conflict detection inline; the enrich_pending marker
  // per new memory drives the Garden BULK_ENRICH worker off-path. The marker is
  // committed atomically with the memory row inside MemoryService.create (the
  // create input carries the enqueueEnrichment intent); this port is the
  // router's loud no-drop fallback for the case the create did not enqueue
  // atomically. The conflictDetectionPort is still wired for the
  // potential_conflict `evaluate` route (a raw signal with no memory yet).
  // see also: garden-runtime.ts runBulkEnrichTask.
  const enrichPendingPort = { enqueue: enqueueEnrichPending };
  // invariant: the router needs to know whether MemoryService.create committed
  // the enrich_pending marker atomically (so it skips its loud fallback). Core
  // throws if an enqueueEnrichment intent is requested but the atomic seam is
  // unwired, so a successful return WITH the intent means the marker landed
  // atomically. see also: packages/soul/src/garden/materialization-router.ts
  // MemoryMaterializationCreatedObject.enrichmentEnqueued
  const materializationMemoryService = {
    create: async (input: Parameters<typeof memoryService.create>[0]) => {
      const created = await memoryService.create(input);
      return {
        object_kind: created.object_kind,
        object_id: created.object_id,
        enrichmentEnqueued: input.enqueueEnrichment !== undefined
      };
    }
  };
  const materializationRouter = new MaterializationRouter({
    evidenceService,
    memoryService: materializationMemoryService,
    synthesisService,
    claimService,
    pathRelationProposalPort,
    // invariant: the soul router's PathCandidateSinkPort mirrors core's
    // PathMintOutcome as a literal union (PathCandidateMintOutcome) so the
    // rejected/failed distinction survives this seam (@do-soul/alaya-soul cannot
    // import @do-soul/alaya-core, invariants §6 — the four-state crosses
    // structurally). core's submitCandidate already returns exactly that union,
    // so we forward it untouched: applied / already_present mean the owed path
    // exists; rejected is a decided B3 refusal (router drops it cleanly); failed
    // is transient (router either records a durable proposal or defers the owed
    // signal-ref path to BULK_ENRICH retry through enrich_pending).
    // see also: packages/soul/src/garden/materialization-router.ts PathCandidateMintOutcome.
    pathCandidateSinkPort: {
      submitCandidate: async (input) => await pathRelationProposalService.submitCandidate(input)
    },
    enrichPendingPort,
    ...(conflictDetectionService === null
      ? {}
      : { conflictDetectionPort: conflictDetectionService }),
    ...(reconciliationService === null
      ? {}
      : { reconciliationPort: reconciliationService }),
    handoffGapHandler: sqliteHandoffGapAdapter
  });
  const signalService = new SignalService({
    eventLogRepo,
    signalRepo,
    runtimeNotifier,
    postTriageMaterializer: {
      materialize: async (signal) => await materializationRouter.materializeSignal(signal)
    }
  });
  const localHeuristicsProvider = new LocalHeuristics();
  const gardenComputeProviderResolver = new GardenComputeProviderResolver({
    configReader: rawConfigService,
    fallbackProvider: localHeuristicsProvider,
    secretReader: resolveGardenSecretRefValue,
    makeProvider: ({ apiKey, model, endpoint }) =>
      new OfficialApiGardenProvider({
        apiKey,
        model,
        ...(endpoint === null ? {} : { endpoint })
      })
  });
  const configService = {
    ...rawConfigService,
    patchRuntimeGardenComputeConfig: async (patch: unknown) => {
      const config = await rawConfigService.patchRuntimeGardenComputeConfig(patch);
      gardenComputeProviderResolver.invalidate();
      computeRoutingService.setProviders(
        buildGardenComputeRoutingProviders({
          config,
          officialGardenProvider,
          localHeuristicsProvider
        })
      );
      return config;
    }
  } satisfies typeof rawConfigService;
  const officialGardenProvider = gardenComputeProviderResolver;
  const initialGardenComputeConfig = await rawConfigService.getRuntimeGardenComputeConfig();
  const computeRoutingService = new ComputeRoutingService({
    providers: buildGardenComputeRoutingProviders({
      config: initialGardenComputeConfig,
      officialGardenProvider,
      localHeuristicsProvider
    })
  });
  const gardenComputeProvider = computeRoutingService.getDefaultProvider();
  const conversationServiceDependencies = {
    runRepo,
    workspaceRepo,
    eventLogRepo,
    gardenComputeProvider,
    resolveGardenComputeProvider: {
      resolve: (modelRef) => computeRoutingService.resolveProvider(modelRef)
    },
    signalReceiver: signalService,
    contextLensAssembler: conversationContextLensAssembler,
    governanceLeaseService,
    budgetBankruptcyService,
    healthJournalRecorder: healthJournalService,
    warn: warnLogger.warn
  } satisfies ConversationServiceDependencies;
  const conversationService = new ConversationService(conversationServiceDependencies);
  const runService = new RunService({
    workspaceRepo,
    runRepo,
    bindingRepo,
    eventPublisher,
    isPrincipalCodingEngineAvailable: () => principalCodingAvailability.available
  });
  const engineBindingService = new EngineBindingService({
    workspaceRepo,
    bindingRepo,
    eventPublisher,
    engineTester: createEngineBindingTester()
  });
  const soulApprovalService = createSoulApprovalService({
    eventLogRepo,
    runLookup: async (runId) => await runService.getById(runId),
    runtimeNotifier
  });
  const topologyAuditService = new SoulTopologyAuditService({
    eventLogRepo
  });
  recordStartupStep(startupSteps, "core-services");

  const gardenBacklogThresholds = createGardenBacklogThresholds();
  const pathPlasticityService = createPathPlasticityService({
    eventLogRepo,
    trustStateRepo,
    pathRelationRepo,
    eventPublisher
  });
  const healthIssueGroupRepo = new SqliteHealthIssueGroupRepo(database);
  // invariant: D-EDGEAUDIT. Implements the core PathFailureHealthInboxPort once
  // against SqliteHealthIssueGroupRepo. A path-relation creation/mint failure
  // (mint-side anchor reject OR accept-owed mint failure) upserts a
  // `path_relation_failure` group keyed on (workspace_id, target_object_id,
  // cause_kind), incrementing count on repeat like the Auditor's orphan/evidence
  // upserts. Best-effort projection: any throw is swallowed by the caller so the
  // underlying mint/accept flow is never broken. The EdgeProposalService and
  // PathRelationProposalService both forward-reference this via closures.
  // see also: packages/core/src/path-failure-health-inbox.ts;
  //   packages/soul/src/garden/auditor.ts upsertHealthIssueGroup.
  const pathFailureHealthInboxPort: PathFailureHealthInboxPort = {
    recordPathRelationFailure: (entry) => {
      const existing = healthIssueGroupRepo.findByCompositeKey(
        entry.workspaceId,
        entry.targetObjectId,
        HealthIssueCauseKind.PATH_RELATION_FAILURE
      );
      const next: HealthIssueGroup = {
        group_id: existing?.group_id ?? randomUUID(),
        workspace_id: entry.workspaceId,
        target_object_id: entry.targetObjectId,
        target_object_kind: "memory_entry",
        cause_kind: HealthIssueCauseKind.PATH_RELATION_FAILURE,
        severity: HealthIssueSeverity.WARN,
        confidence: 1,
        first_seen_at: existing?.first_seen_at ?? entry.observedAt,
        last_seen_at: entry.observedAt,
        count: (existing?.count ?? 0) + 1,
        suggested_actions: [HealthIssueSuggestedAction.INSPECT_PATH_FAILURE],
        resolution_state: HealthIssueResolutionState.PENDING,
        resolved_at: null,
        resolved_by: null
      };
      healthIssueGroupRepo.upsert(next);
    }
  };
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
  // packages/core/src/memory-service.ts demoteActiveToDormantIfActive.
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
  // Resolve the forward-referenced EDGE_CLASSIFY enqueue holder now that the
  // garden task repo exists. The defer closure declared above only fires at
  // materialization time, so this assignment always precedes the first use.
  if (gardenTaskRepo !== undefined) {
    edgeClassifyQueueRepoHolder = gardenTaskRepo;
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

  const mcpTooling = await bootstrapDaemonMcpTooling({
    eventLogRepo,
    extensionDescriptorRepo,
    now: () => new Date().toISOString(),
    runtimeNotifier,
    toolSpecService,
    warnLogger,
    builtinConversationToolSpecs: getBuiltinConversationToolSpecs()
  });
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
  const attachSurfaceRegistrar = createAttachSurfaceRegistrar({
    surfaceService,
    warn: warnLogger.warn
  });
  const mcpMemoryToolHandler = createDaemonMcpMemoryToolHandler({
    recallService,
    memoryService,
    dynamicsService: {
      emitKarmaEvent: (input) => dynamicsService.emitKarmaEvent(input)
    },
    memoryEntryRepo,
    evidenceService,
    pathRelationProposalService,
    // invariant: route B3's object-anchor gate into the proposal accept-apply
    // path so the second durable path-insert route is existence/ownership-
    // checked before the storage insert.
    objectAnchorGate: pathRelationProposalService,
    // invariant: workspace-scoped evidence-gist reader for the synthesis-create
    // accept-apply. Reuses EvidenceService.findByIdScoped so the deterministic
    // summary and the evidence-existence gate run on the same scoped read the
    // open_pointer path uses (no cross-workspace gist leakage).
    synthesisEvidenceReader: {
      findGistById: async (evidenceId: string, scopedWorkspaceId: string) => {
        const evidence = await evidenceService.findByIdScoped(evidenceId, scopedWorkspaceId);
        return evidence === null ? null : evidence.gist;
      }
    },
    // invariant: resolves the synthesis cluster's member memories at capsule-build
    // time so source_memory_refs is populated. findByEvidenceRefs returns the
    // active, non-tombstoned memories whose evidence_refs INTERSECT the capsule's
    // evidence_refs, workspace-scoped and bounded (id-set cap + row LIMIT). The
    // intersection set is then narrowed to the SUBSET members — those whose
    // evidence_refs are FULLY contained in the capsule's evidence set, i.e. the
    // member has NO private evidence living outside the cluster. Only a fully
    // consolidated member is eligible for source_memory_refs: the capsule
    // preserves the cluster's shared evidence + a deterministic gist summary, so
    // a member with private evidence outside the cluster is NOT preserved by it
    // and must stay un-armed (fail-safe: it falls through to dormant /
    // judged_useless, never compress-deleted on a partial-preservation claim).
    // see also: forget-disposition-ports.ts computeForgetDisposition.
    synthesisMemberResolver: {
      findMemberObjectIdsByEvidenceRefs: async (
        scopedWorkspaceId: string,
        evidenceRefs: readonly string[]
      ) => {
        const capsuleEvidence = new Set(evidenceRefs);
        const members = await memoryEntryRepo.findByEvidenceRefs(scopedWorkspaceId, evidenceRefs);
        return members
          .filter((member) =>
            member.evidence_refs.every((ref) => capsuleEvidence.has(ref))
          )
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
    // invariant: applies a host-worker EDGE_CLASSIFY verdict to the existing
    // heuristic path. Wired to the same EdgeAutoProducerService that produced
    // the inline edge so the verdict refinement goes through the identical
    // governed PathCandidateSink. see also: edge-auto-producer-service.ts applyVerdict.
    edgeVerdictApplier: {
      applyVerdict: (verdictInput) => edgeAutoProducerService.applyVerdict(verdictInput)
    },
    eventLogRepo,
    proposalRepo,
    runtimeNotifier,
    attachSurfaceRegistrar,
    resolutionService,
    claimSourceReader: {
      findSourceObjectRefs: async (targetObjectId: string) => {
        const claim = await claimFormRepo.findById(targetObjectId);
        return claim === null ? null : claim.source_object_refs;
      }
    }
  });
  recordStartupStep(startupSteps, "mcp-tooling");

  const lifecycleState = createCoreDaemonLifecycleState();

  const app = createCoreDaemonApp({
    requestProtection,
    remoteDaemonOptInEnabled,
    lifecycleState,
    startupSteps,
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
    // invariant: Inspector loopback HTTP routes use the same MCP
    // handler that attached agents call.
    mcpMemoryToolHandler,
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
    mcp: mcpTooling.daemonMcpCatalog,
    warn: warnLogger.warn
  });
  recordStartupStep(startupSteps, "http-app");

  const lifecycleControls = createDaemonLifecycleControls({
    app,
    lifecycleState,
    warnLogger,
    gardenBacklogTelemetryService,
    gardenRuntime,
    securityStatusService,
    daemonMcpRuntimeRegistry: mcpTooling.daemonMcpRuntimeRegistry,
    globalMemoryRecallInvalidationSubscription,
    database,
    intervalsToClear: [pathRelationEvictionTimer]
  });

  return Object.freeze({
    app,
    requestProtection,
    runtimeNotifier,
    startupSteps,
    services: Object.freeze({
      conversationToolCatalog: mcpTooling.conversationToolCatalog,
      daemonMcpCatalog: mcpTooling.daemonMcpCatalog,
      environmentStatusService,
      embeddingStatusService,
      ...(embeddingRecallService === undefined ? {} : { embeddingRecallService }),
      graphHealthService,
      configService,
      mcpMemoryToolHandler,
      recallService,
      signalService,
      synthesisService,
      pathRelationProposalService,
      recallUtilizationService,
      runService,
      trustStateRecorder,
      workspaceService: securedWorkspaceService,
      gardenStatus: {
        getStatus: () => {
          const current = gardenRuntime.getStatus();
          return {
            last_pass_at: current.last_pass_at ?? initialGardenLastPassAt
          };
        },
        // doctor/status advisory under the host_worker product default: a
        // recall-driven extract task that no attached CLI agent has claimed
        // within HOST_WORKER_EXTRACT_ADVISORY_STALE_MS counts as "stale", i.e.
        // aging toward the in-process zero-cloud heuristic fallback. Aggregated
        // across workspaces. Returns null when no sqlite garden task repo is
        // wired so the advisory is simply omitted rather than fabricated.
        getHostWorkerExtractBacklog: () => {
          if (gardenTaskRepo === undefined) {
            return null;
          }
          const staleBefore = new Date(
            Date.now() - HOST_WORKER_EXTRACT_ADVISORY_STALE_MS
          ).toISOString();
          const extract = gardenTaskRepo.countByKind(
            GardenTaskKind.POST_TURN_EXTRACT,
            staleBefore
          );
          // Also surface the EDGE_CLASSIFY backlog so a no-agent deployment's
          // unrefined heuristic edges (the LLM-quality verdict that no host
          // worker has rendered) are visible from doctor, not just extract work.
          const edgeClassify = gardenTaskRepo.countByKind(
            GardenTaskKind.EDGE_CLASSIFY,
            staleBefore
          );
          return {
            pending: extract.pending,
            stale: extract.stale,
            edgeClassifyPending: edgeClassify.pending,
            edgeClassifyStale: edgeClassify.stale
          };
        }
      },
      principalCodingEngineAvailable: principalCodingAvailability.available
    }),
    startBackgroundServices: lifecycleControls.startBackgroundServices,
    runGardenBackgroundPass: lifecycleControls.runGardenBackgroundPass,
    runGardenEmbeddingBackfillPass: lifecycleControls.runGardenEmbeddingBackfillPass,
    startHttpServer: lifecycleControls.startHttpServer,
    shutdown: lifecycleControls.shutdown
  });
}

async function resolvePersistedGardenLastPassAt(input: {
  readonly healthJournalRepo: SqliteHealthJournalRepo;
  readonly workspaceRepo: SqliteWorkspaceRepo;
  readonly warn: (message: string, meta: Record<string, unknown>) => void;
}): Promise<string | null> {
  try {
    let latest: string | null = null;
    const workspaces = await input.workspaceRepo.list();
    const workspaceIds = new Set<string>([DEFAULT_GARDEN_STATUS_WORKSPACE_ID]);
    for (const workspace of workspaces) {
      workspaceIds.add(workspace.workspace_id);
    }
    for (const workspaceId of workspaceIds) {
      const [entry] = await input.healthJournalRepo.findByWorkspace(workspaceId, {
        kind: HealthEventKind.GARDEN_BACKLOG,
        limit: 1
      });
      if (entry === undefined) {
        continue;
      }
      if (latest === null || entry.created_at > latest) {
        latest = entry.created_at;
      }
    }
    return latest;
  } catch (error) {
    input.warn("garden persisted status lookup failed", {
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
}

function resolveGardenSecretRefValue(secretRef: string): string {
  const resolved = resolveSecretRef(secretRef);
  if (!("kind" in resolved)) {
    return resolved.value;
  }

  throw new Error(formatGardenSecretRefError(resolved));
}

function buildGardenComputeRoutingProviders(input: {
  readonly config: RuntimeGardenComputeConfig;
  readonly officialGardenProvider: GardenComputeProviderResolver;
  readonly localHeuristicsProvider: LocalHeuristics;
}): readonly ComputeRoutingCandidate[] {
  return [
    ...(canResolveOfficialGardenProvider(input.config)
      ? [
          {
            kind: ComputeProviderPriority.OFFICIAL_API,
            provider: input.officialGardenProvider,
            model_id: input.config.model_id ?? OFFICIAL_API_GARDEN_MODEL,
            adapter: "garden.official_api"
          } satisfies ComputeRoutingCandidate
        ]
      : []),
    {
      kind: ComputeProviderPriority.STUB,
      provider: input.localHeuristicsProvider,
      model_id: "local-heuristics",
      adapter: "garden.local_heuristics"
    }
  ];
}

function canResolveOfficialGardenProvider(config: RuntimeGardenComputeConfig): boolean {
  if (
    config.provider_kind !== "official_api" ||
    !config.enabled ||
    config.secret_ref === null
  ) {
    return false;
  }

  try {
    resolveGardenSecretRefValue(config.secret_ref);
    return true;
  } catch {
    return false;
  }
}

function formatGardenSecretRefError(error: ResolveSecretError): string {
  switch (error.kind) {
    case "malformed":
      return `Garden compute secret_ref ${error.ref} is malformed: ${error.reason}`;
    case "empty":
      return `Garden compute secret_ref ${error.ref} resolved to an empty ${error.origin} secret.`;
    case "env_missing":
      return `Garden compute secret_ref ${error.ref} is missing environment variable ${error.var_name}.`;
    case "file_missing":
      return `Garden compute secret_ref ${error.ref} is missing file ${error.path}.`;
    case "file_unreadable":
      return `Garden compute secret_ref ${error.ref} file ${error.path} is unreadable.`;
    case "keychain_tooling_unavailable":
    case "keychain_entry_not_found":
      return `Garden compute secret_ref ${error.ref} keychain lookup failed: ${error.reason}`;
  }
}

// invariant: optional LLM-backed pair classifier for ConflictDetectionService.
// Returns null when env is not configured; the service then falls back to
// rule-based detection only. Env keys mirror the embedding provider style
// so operators can flip both on/off the same way.
//   ALAYA_CONFLICT_LLM_PROVIDER_URL  openai-compatible base URL
//   ALAYA_CONFLICT_LLM_MODEL         model id (default gpt-5.4-mini)
//   ALAYA_CONFLICT_LLM_API_KEY       bearer token
//   ALAYA_CONFLICT_LLM_TIMEOUT_MS    request timeout (default 8000)
function createConflictDetectionLlmPort(): ConflictDetectionLlmPort | null {
  const baseUrl = process.env.ALAYA_CONFLICT_LLM_PROVIDER_URL?.trim();
  const apiKey = process.env.ALAYA_CONFLICT_LLM_API_KEY?.trim();
  if (
    baseUrl === undefined ||
    baseUrl.length === 0 ||
    apiKey === undefined ||
    apiKey.length === 0
  ) {
    return null;
  }
  const model = process.env.ALAYA_CONFLICT_LLM_MODEL?.trim() ?? "gpt-5.4-mini";
  const parsedTimeout = Number.parseInt(
    process.env.ALAYA_CONFLICT_LLM_TIMEOUT_MS ?? "",
    10
  );
  const timeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 8000;

  return {
    classifyPair: async ({ newContent, existingContent, dimension, scopeClass }) => {
      const prompt = [
        `You are a deterministic memory ontology classifier for Alaya.`,
        `Two memory entries share dimension="${dimension}" and scope="${scopeClass}".`,
        `Decide their relationship: "contradicts" | "incompatible_with" | "none".`,
        ``,
        `MEMORY_A (new):`,
        newContent,
        ``,
        `MEMORY_B (existing):`,
        existingContent,
        ``,
        `Reply with one word only: contradicts, incompatible_with, or none.`
      ].join("\n");

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: "Reply with exactly one word." },
              { role: "user", content: prompt }
            ],
            temperature: 0,
            max_tokens: 8
          }),
          signal: controller.signal
        });
        if (!response.ok) {
          return "none";
        }
        const data = (await response.json()) as {
          readonly choices?: ReadonlyArray<{ readonly message?: { readonly content?: string } }>;
        };
        const text = data.choices?.[0]?.message?.content?.trim().toLowerCase() ?? "";
        if (text.startsWith("contradicts")) return "contradicts";
        if (text.startsWith("incompatible_with")) return "incompatible_with";
        return "none";
      } catch {
        return "none";
      } finally {
        clearTimeout(timer);
      }
    }
  };
}

function normalizeRecallTimeConcernWindowDigest(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, "_");
}

export async function startDaemon(options: AlayaDaemonListenOptions = {}): Promise<AlayaDaemonServer> {
  const runtime = await createAlayaDaemonRuntime();
  return await runtime.startHttpServer(options);
}

if (process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], "file://").href) {
  await startDaemon();
}
