import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ComputeProviderPriority, HealthEventKind } from "@do-soul/alaya-protocol";
import {
  ArbitrationService,
  BudgetBankruptcyService,
  CanonicalAliasService,
  ClaimService,
  ConversationService,
  ContextLensAssembler,
  CrossCuttingPermissionService,
  DynamicsService,
  EngineBindingService,
  EvidenceService,
  GardenBacklogTelemetryService,
  GovernanceLeaseService,
  GraphExploreService,
  GreenService,
  HealthJournalService,
  MemoryService,
  NarrativeBudgetService,
  ProjectMappingService,
  ProposalService,
  RecallService,
  RunService,
  SessionOverrideService,
  SignalService,
  SlotService,
  StanceResolutionService,
  StrongRefService,
  SurfaceBindingService,
  SurfaceDriftService,
  SurfaceService,
  SynthesisService,
  TaskSurfaceBuilder,
  ToolGovernanceClient,
  ToolSpecService,
  WorkspaceService,
  ZeroDaySecurityLayer,
  rebuildCountersFromEventLog,
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
  SqliteDirtyStateDossierRepo,
  SqliteDriftLeaseRepo,
  SqliteEngineBindingRepo,
  SqliteEventLogRepo,
  SqliteEvidenceCapsuleRepo,
  SqliteExtensionDescriptorRepo,
  SqliteFileRepo,
  SqliteGreenStatusRepo,
  SqliteHealthJournalRepo,
  SqliteHandoffGapRepo,
  SqliteKarmaEventRepo,
  SqliteMemoryEntryRepo,
  SqliteMemoryGraphEdgeRepo,
  SqliteOrphanRadarRepo,
  SqlitePathGraphSnapshotRepo,
  SqlitePathPlasticityWatermarkRepo,
  SqlitePathRelationRepo,
  SqliteProjectMappingAnchorRepo,
  SqliteProposalRepo,
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
  initDatabase
} from "@do-soul/alaya-storage";
import {
  ComputeRoutingService,
  DegradationPipeline,
  BootstrappingService,
  LocalHeuristics,
  MaterializationRouter,
  OFFICIAL_API_GARDEN_MODEL,
  OfficialApiGardenProvider,
  SoulSignalHandler,
  SoulToolGovernanceAdapter,
  SoulWorkerSafetyAdapter,
  SoulWorkerSafetyReader,
  TopologyService
} from "@do-soul/alaya-soul";
import { createCoreDaemonApp } from "./daemon-app-composition.js";
import { createDaemonEmbeddingRuntime } from "./daemon-embedding-runtime.js";
import { createDaemonMcpMemoryToolHandler } from "./daemon-mcp-memory-handler.js";
import { createBudgetProposalPort } from "./budget-wiring.js";
import { createComputeRoutingExecutionStanceResolver } from "./compute-routing-resolver.js";
import { defaultBootstrappingTemplates, defaultCanonicalAliasMap } from "./daemon-defaults.js";
import { bootstrapDaemonMcpTooling } from "./daemon-mcp-tooling.js";
import {
  createStancePolicyProvider,
  createTargetCurrencyCheckPort,
  createWarnLogger
} from "./daemon-runtime-helpers.js";
import { createCoreDaemonLifecycleState, createDaemonLifecycleControls } from "./daemon-runtime-lifecycle.js";
import {
  createAlayaConversationEngine,
  createConversationToolExecutor,
  createEngineBindingTester,
  createGardenBacklogThresholds,
  createGlobalMemoryRecallCachePort,
  createGlobalMemoryRecallPort,
  createGlobalMemoryRouteService,
  createKarmaEventStore,
  createOptionalGlobalMemoryRecallCacheRepo,
  createOptionalGlobalMemoryRepo,
  createRequestProtection,
  createSoulGraphService,
  createUnavailableRuntimeAdapter,
  listServerHardConstraints,
  loadConfigEnv,
  patchArbitrationClaimService,
  readOfficialGardenModelId,
  readOfficialGardenProviderUrl,
  readOfficialGardenSecretRef,
  recordStartupStep,
  resolveDatabasePath
} from "./daemon-runtime-support.js";
import { resolveAlayaConfigDir, resolveAlayaConfigPaths, type AlayaConfigPaths } from "./cli/config-files.js";
import { resolveCoreDaemonFilesDirectory } from "./files-data-dir.js";
import { createGardenRuntime } from "./garden-runtime.js";
import {
  createPathPlasticityService,
  createRecallPathPlasticityPort
} from "./path-plasticity-runtime.js";
import { SqliteHandoffGapAdapter } from "./handoff-gap-adapter.js";
import { createManifestationContextLensAssembler } from "./manifestation-context-lens-assembler.js";
import { createNarrativeBudgetRepo } from "./narrative-budget-repo.js";
import { parseZeroDayPoliciesJson } from "./zero-day-policies.js";
import { createRuntimeNotifier } from "./runtime-notifier.js";
import { createSecurityStatusBootstrapServices } from "./security-status-bootstrap.js";
import { isRemoteDaemonOptInEnabled } from "./server-options.js";
import { createConfigService } from "./services/config-service.js";
import { createEnvironmentStatusService } from "./services/environment-status-service.js";
import {
  CORE_DAEMON_ENVIRONMENT_TOOLS,
  derivePrincipalCodingAvailability
} from "./services/principal-coding-availability.js";
import { createSoulApprovalService } from "./services/soul-approval-service.js";
import { SoulTopologyAuditService } from "./services/soul-topology-audit-service.js";
import { SqliteWorkspaceEngineConfigRepo } from "./services/workspace-engine-config-repo.js";
import { createTrustStateRecorder } from "./trust-state.js";
import { createWorkerRuntimeWiring } from "./worker-runtime-wiring.js";
import { getBuiltinConversationToolSpecs } from "./builtin-conversation-tool-specs.js";
import type {
  AlayaDaemonListenOptions,
  AlayaDaemonRuntime,
  AlayaDaemonServer,
  DaemonStartupStepRecord
} from "./daemon-runtime-types.js";

export type { AlayaDaemonListenOptions, AlayaDaemonRuntime, AlayaDaemonRuntimeServices, AlayaDaemonServer, DaemonStartupStepRecord } from "./daemon-runtime-types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..", "..");
const DEFAULT_GARDEN_STATUS_WORKSPACE_ID = "default";
const EMBEDDING_SECRET_GARDEN_FALLBACK_WARNING =
  "[ALAYA] DEPRECATED: ALAYA_OPENAI_SECRET_REF used as Garden compute key. Set ALAYA_OFFICIAL_GARDEN_SECRET_REF for v0.2 compatibility.";
let embeddingSecretGardenFallbackWarningEmitted = false;

export async function createAlayaDaemonRuntime(): Promise<AlayaDaemonRuntime> {
  const startupSteps: DaemonStartupStepRecord[] = [];
  const warnLogger = createWarnLogger();
  const runtimeNotifier = createRuntimeNotifier();
  const requestProtection = createRequestProtection();
  const remoteDaemonOptInEnabled = isRemoteDaemonOptInEnabled(process.env);
  const configPaths = resolveAlayaConfigPaths(resolveAlayaConfigDir({ env: process.env }));
  const configEnv = await loadConfigEnv(configPaths.envPath);
  // Fallback DB path is the user's config dir, NOT a path inside the
  // package install directory. Writing to package internals corrupts
  // future upgrades and would let an npm-installed daemon mutate state
  // inside node_modules/@do-soul/alaya/.
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
  const signalRepo = new SqliteSignalRepo(database);
  const evidenceCapsuleRepo = new SqliteEvidenceCapsuleRepo(database);
  const memoryEntryRepo = new SqliteMemoryEntryRepo(database);
  const globalMemoryRepo = createOptionalGlobalMemoryRepo(database);
  const globalMemoryRecallCacheRepo = createOptionalGlobalMemoryRecallCacheRepo(database);
  const memoryGraphEdgeRepo = new SqliteMemoryGraphEdgeRepo(database);
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
  const pathPlasticityWatermarkRepo = new SqlitePathPlasticityWatermarkRepo(database);
  const pathGraphSnapshotRepo = new SqlitePathGraphSnapshotRepo(database);
  const deferredObligationRepo = new SqliteDeferredObligationRepo(database);
  const dirtyStateDossierRepo = new SqliteDirtyStateDossierRepo(database);
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
  const configService = createConfigService({
    configRepo,
    eventPublisher,
    configPathsProvider: () => configPaths
  });
  const trustStateRecorder = createTrustStateRecorder({
    eventPublisher,
    repo: trustStateRepo,
    clock: () => new Date().toISOString()
  });
  const toolSpecService = new ToolSpecService({ toolSpecRepo });
  const toolGovernanceClient = new ToolGovernanceClient({
    port: new SoulToolGovernanceAdapter({
      listClaimsForProject: async (projectRef) => await claimFormRepo.findByWorkspaceId(projectRef),
      listSlotsForProject: async (projectRef) => await slotRepo.findByWorkspace(projectRef)
    })
  });
  const strongRefService = new StrongRefService({ repo: strongRefRepo });
  const targetRevalidateService = {
    checkCurrency: createTargetCurrencyCheckPort({
      claimFormRepo,
      slotRepo
    }).checkCurrency
  };
  const canonicalAliasService = new CanonicalAliasService({
    aliasMap: defaultCanonicalAliasMap,
    eventPublisher
  });
  const conversationToolExecutor = createConversationToolExecutor({
    eventLogRepo,
    runtimeNotifier,
    toolExecutionRecordRepo,
    toolGovernanceClient,
    targetRevalidateService,
    strongRefService,
    canonicalAliasService
  });
  const evidenceService = new EvidenceService({
    evidenceCapsuleRepo,
    eventLogRepo,
    runtimeNotifier
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
  const memoryService = new MemoryService({
    memoryEntryRepo,
    evidenceService,
    eventLogRepo,
    runtimeNotifier,
    dynamicsService,
    greenService
  });
  const graphExploreService = new GraphExploreService({
    memoryRepo: memoryEntryRepo,
    edgeRepo: memoryGraphEdgeRepo,
    eventLogRepo,
    runtimeNotifier
  });
  const topologyService = new TopologyService({
    pathRelationRepo,
    snapshotHistory: {
      getHistory: async (workspaceId, limit) => await pathGraphSnapshotRepo.findHistory(workspaceId, limit)
    }
  });
  const soulGraphService = createSoulGraphService({
    memoryEntryRepo,
    memoryGraphEdgeRepo
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
    claimService,
    synthesisService,
    eventLogRepo,
    karmaEventStore: createKarmaEventStore(karmaEventRepo, warnLogger),
    dynamicsService,
    warn: warnLogger,
    runtimeNotifier
  });
  const crossCuttingPermissionService = new CrossCuttingPermissionService({
    crossCuttingRepo: crossCuttingPermissionRepo,
    runtimeNotifier
  });
  const surfaceDriftService = new SurfaceDriftService({
    leaseRepo: new SqliteDriftLeaseRepo(database),
    eventPublisher
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
    embeddingApiKey,
    embeddingStatusService,
    embeddingRecallService,
    embeddingBackfillHandler
  } = createDaemonEmbeddingRuntime({
    database,
    configEnv,
    eventLogRepo,
    healthJournalService,
    memoryEntryRepo,
    warn: warnLogger.warn
  });
  const recallPathPlasticityPort = createRecallPathPlasticityPort({
    pathRelationRepo
  });
  const recallService = new RecallService({
    memoryRepo: memoryEntryRepo,
    slotRepo,
    eventLogRepo,
    graphSupportPort: graphExploreService,
    projectMappingPort: projectMappingService,
    pathPlasticityPort: recallPathPlasticityPort,
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
  const materializationRouter = new MaterializationRouter({
    evidenceService,
    memoryService,
    synthesisService,
    claimService,
    graphEdgePort: {
      createEdge: async (params) => {
        await graphExploreService.addEdge(params);
      }
    },
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
  const soulHandler = new SoulSignalHandler({
    receiveSignal: async (signal) => {
      await signalService.receiveSignal(signal);
    },
    graphExplorePort: graphExploreService,
    applyOverride: async (params) =>
      await sessionOverrideService.apply({
        runId: params.runId,
        workspaceId: params.workspaceId,
        targetObject: params.targetObject,
        correction: params.correction,
        priority: params.priority,
        derivedFrom: params.derivedFrom
      })
  });
  const stancePolicyProvider = createStancePolicyProvider(configRepo);
  const localHeuristicsProvider = new LocalHeuristics();
  const officialGardenSecret = readOfficialGardenSecretRef(configEnv);
  const officialGardenApiKey =
    officialGardenSecret ?? maybeUseDeprecatedEmbeddingSecretForGarden(embeddingApiKey);
  const officialGardenModelId = readOfficialGardenModelId(configEnv) ?? OFFICIAL_API_GARDEN_MODEL;
  const officialGardenProviderUrl = readOfficialGardenProviderUrl(configEnv);
  const officialGardenProvider =
    officialGardenApiKey === null
      ? null
      : new OfficialApiGardenProvider({
          apiKey: officialGardenApiKey,
          model: officialGardenModelId,
          endpoint: officialGardenProviderUrl ?? undefined
        });
  const computeRoutingService = new ComputeRoutingService({
    providers: [
      ...(officialGardenProvider === null
        ? []
        : [
            {
              kind: ComputeProviderPriority.OFFICIAL_API,
              provider: officialGardenProvider,
              model_id: officialGardenModelId,
              adapter: "garden.official_api"
            } as const
          ]),
      {
        kind: ComputeProviderPriority.STUB,
        provider: localHeuristicsProvider,
        model_id: "local-heuristics",
        adapter: "garden.local_heuristics"
      }
    ]
  });
  const gardenComputeProvider = computeRoutingService.getDefaultProvider();
  const stanceResolutionService = new StanceResolutionService({
    stancePolicyProvider,
    eventLogWriter: eventLogRepo
  });
  const resolveExecutionStance = createComputeRoutingExecutionStanceResolver({
    computeRoutingService,
    eventLogWriter: eventLogRepo,
    stanceResolutionService
  });
  const conversationEngine = createAlayaConversationEngine();
  const conversationServiceDependencies = {
    engine: conversationEngine,
    eventPublisher,
    runHotStateService,
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
    resolveExecutionStance,
    budgetBankruptcyService,
    healthJournalRecorder: healthJournalService,
    warn: warnLogger.warn
  } satisfies ConversationServiceDependencies & Record<string, unknown>;
  const conversationService = new ConversationService(
    conversationServiceDependencies as ConversationServiceDependencies
  );
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
  const workerSafetyReader = new SoulWorkerSafetyReader({
    claimRegistryReader: {
      listClaimsForWorkspace: async (workspaceId) => await claimFormRepo.findByWorkspaceId(workspaceId)
    },
    hazardProjectionReader: {
      listActiveHazardObjectRefs: async () => []
    },
    policyProjectionReader: {
      listGlobalDeniedToolCategories: async () => [],
      listWorkspaceHardStopRefs: async () => []
    }
  });
  const workerRuntimeWiring = createWorkerRuntimeWiring({
    deferredObligationRepo,
    dirtyStateDossierRepo,
    eventLogRepo,
    eventPublisher,
    runtimeAdapterFactory: createUnavailableRuntimeAdapter,
    runtimeNotifier,
    strongRefService,
    workerSafetyPort: new SoulWorkerSafetyAdapter({ reader: workerSafetyReader }),
    workerRunRepo,
    zeroDaySecurityLayer
  });
  recordStartupStep(startupSteps, "core-services");

  const gardenBacklogThresholds = createGardenBacklogThresholds();
  const pathPlasticityService = createPathPlasticityService({
    eventLogRepo,
    trustStateRepo,
    pathRelationRepo,
    eventPublisher
  });
  const gardenRuntime = createGardenRuntime({
    databaseConnection: database.connection,
    backlogThresholds: gardenBacklogThresholds,
    eventLogRepo,
    eventPublisher,
    gardenDataPorts: createGardenBackgroundDataPorts(database),
    healthJournalRepo,
    handoffGapRepo: sqliteHandoffGapRepo,
    orphanDetectionEnabled,
    orphanRadarRepo,
    pathGraphSnapshotRepo,
    pathRelationRepo,
    pathPlasticityWatermarkRepo,
    pathPlasticityService,
    embeddingBackfillHandler,
    strongRefService,
    workspaceRepo
  });
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
  await rebuildCountersFromEventLog(eventLogRepo, trustStateRecorder);
  trustStateRecorder.markReady();
  const mcpMemoryToolHandler = createDaemonMcpMemoryToolHandler({
    recallService,
    memoryService,
    signalService,
    graphExploreService,
    sessionOverrideService,
    trustStateRecorder,
    eventLogRepo,
    proposalRepo,
    runtimeNotifier
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
    taskSurfaceBuilder,
    synthesisService,
    claimService,
    proposalService,
    // A1 (HITL daemon backbone) — Inspector loopback HTTP routes need
    // the same MCP handler that attached agents call.
    mcpMemoryToolHandler,
    fileRepo,
    runtimeNotifier,
    topologyAuditService,
    graphExploreService,
    topologyService,
    soulApprovalService,
    soulGraphService,
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
    database
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
      mcpMemoryToolHandler,
      runService,
      trustStateRecorder,
      workspaceService: securedWorkspaceService,
      gardenStatus: {
        getStatus: () => {
          const current = gardenRuntime.getStatus();
          return {
            last_pass_at: current.last_pass_at ?? initialGardenLastPassAt
          };
        }
      },
      principalCodingEngineAvailable: principalCodingAvailability.available
    }),
    startBackgroundServices: lifecycleControls.startBackgroundServices,
    runGardenBackgroundPass: lifecycleControls.runGardenBackgroundPass,
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

function maybeUseDeprecatedEmbeddingSecretForGarden(embeddingApiKey: string | null): string | null {
  if (embeddingApiKey === null) {
    return null;
  }

  if (!embeddingSecretGardenFallbackWarningEmitted) {
    process.stderr.write(`${EMBEDDING_SECRET_GARDEN_FALLBACK_WARNING}\n`);
    embeddingSecretGardenFallbackWarningEmitted = true;
  }

  return embeddingApiKey;
}

export async function startDaemon(options: AlayaDaemonListenOptions = {}): Promise<AlayaDaemonServer> {
  const runtime = await createAlayaDaemonRuntime();
  return await runtime.startHttpServer(options);
}

if (process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], "file://").href) {
  await startDaemon();
}
