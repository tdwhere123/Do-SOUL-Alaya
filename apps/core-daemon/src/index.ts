import { serve, type ServerType } from "@hono/node-server";
import { randomBytes, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AcceptedBy,
  ComputeProviderPriority,
  DEFAULT_SOUL_CONFIG,
  ProjectMappingState,
  type AgentRuntimePort,
  type EngineBinding,
  type EngineBindingSummary,
  type EventLogEntry,
  type GlobalMemoryEntry,
  type GardenBacklogThresholds,
  type SoulGraph
} from "@do-soul/alaya-protocol";
import {
  ArbitrationService,
  BudgetBankruptcyService,
  CanonicalAliasService,
  ClaimService,
  ConversationService,
  ContextLensAssembler,
  CoreError,
  CrossCuttingPermissionService,
  DynamicsService,
  EmbeddingBackfillHandler,
  EmbeddingRecallService,
  EngineBindingService,
  EvidenceService,
  GardenBacklogTelemetryService,
  GovernanceLeaseService,
  GraphExploreService,
  GreenService,
  HealthJournalService,
  MemoryService,
  NarrativeBudgetService,
  OpenAIEmbeddingClient,
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
  SqliteKarmaEventStore,
  createGlobalMemoryRecallPort as createCoreGlobalMemoryRecallPort,
  type ConversationServiceDependencies,
  type GlobalMemoryRecallCachePort,
  type GlobalMemoryRecallServicePort,
  type GlobalMemoryRecallSubscription
} from "@do-soul/alaya-core";
import * as StorageModule from "@do-soul/alaya-storage";
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
  SqliteGlobalMemoryRecallCacheRepo,
  SqliteGlobalMemoryRepo,
  SqliteGreenStatusRepo,
  SqliteHealthJournalRepo,
  SqliteHandoffGapRepo,
  SqliteKarmaEventRepo,
  SqliteMemoryEntryRepo,
  SqliteMemoryGraphEdgeRepo,
  SqliteOrphanRadarRepo,
  SqlitePathGraphSnapshotRepo,
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
  initDatabase,
  type GlobalMemoryRecallCacheRepo,
  type GlobalMemoryRepo,
  type MemoryEmbeddingRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import {
  ComputeRoutingService,
  DegradationPipeline,
  BootstrappingService,
  LocalHeuristics,
  MaterializationRouter,
  OFFICIAL_API_GARDEN_MODEL,
  OfficialApiGardenProvider,
  SessionOverrideRemediation,
  SoulSignalHandler,
  SoulToolGovernanceAdapter,
  SoulWorkerSafetyAdapter,
  SoulWorkerSafetyReader,
  TopologyService
} from "@do-soul/alaya-soul";
import { createApp, type CoreDaemonServices, type RequestProtectionConfig } from "./app.js";
import { createBudgetProposalPort } from "./budget-wiring.js";
import { createComputeRoutingExecutionStanceResolver } from "./compute-routing-resolver.js";
import { defaultBootstrappingTemplates, defaultCanonicalAliasMap } from "./daemon-defaults.js";
import { bootstrapDaemonMcpTooling } from "./daemon-mcp-tooling.js";
import {
  createManifestationBudgetConfigProvider,
  createStancePolicyProvider,
  createTargetCurrencyCheckPort,
  createWarnLogger
} from "./daemon-runtime-helpers.js";
import { resolveAlayaConfigDir, resolveAlayaConfigPaths } from "./cli/config-files.js";
import { resolveCoreDaemonFilesDirectory } from "./files-data-dir.js";
import { createGardenRuntime } from "./garden-runtime.js";
import { SqliteHandoffGapAdapter } from "./handoff-gap-adapter.js";
import { createManifestationContextLensAssembler } from "./manifestation-context-lens-assembler.js";
import { createMcpMemoryProposalWorkflow } from "./mcp-memory-proposal-workflow.js";
import { createMcpMemoryToolHandler, type McpMemoryToolHandler } from "./mcp-memory-tool-handler.js";
import { createNarrativeBudgetRepo } from "./narrative-budget-repo.js";
import { parseZeroDayPoliciesJson } from "./zero-day-policies.js";
import { createRuntimeNotifier, type AlayaRuntimeNotifier } from "./runtime-notifier.js";
import { createSecurityStatusBootstrapServices } from "./security-status-bootstrap.js";
import { resolveSecretRef, type ResolveSecretError } from "./secrets.js";
import { isRemoteDaemonOptInEnabled, resolveDaemonHostFromEnv } from "./server-options.js";
import { createConfigService } from "./services/config-service.js";
import { createEmbeddingStatusService, type EmbeddingStatusService } from "./services/embedding-status-service.js";
import { createEnvironmentStatusService, type EnvironmentStatusService } from "./services/environment-status-service.js";
import {
  CORE_DAEMON_ENVIRONMENT_TOOLS,
  derivePrincipalCodingAvailability
} from "./services/principal-coding-availability.js";
import { createSoulApprovalService } from "./services/soul-approval-service.js";
import { SoulTopologyAuditService } from "./services/soul-topology-audit-service.js";
import { SqliteWorkspaceEngineConfigRepo } from "./services/workspace-engine-config-repo.js";
import { executeConversationToolOrThrow, handleConversationToolUse } from "./tool-runtime.js";
import { createTrustStateRecorder, type TrustStateRecorder } from "./trust-state.js";
import { createWorkerRuntimeWiring } from "./worker-runtime-wiring.js";
import { getBuiltinConversationToolSpecs } from "./builtin-conversation-tool-specs.js";

type StartupStep =
  | "database"
  | "repositories"
  | "core-services"
  | "garden-runtime"
  | "mcp-tooling"
  | "http-app";

type GlobalMemoryListFilters = Parameters<GlobalMemoryRepo["list"]>[0];
type MemoryEntryRecord = Awaited<ReturnType<SqliteMemoryEntryRepo["findByWorkspaceId"]>>[number];

export interface DaemonStartupStepRecord {
  readonly step: StartupStep;
  readonly completedAt: string;
}

export interface AlayaDaemonRuntime {
  readonly app: ReturnType<typeof createApp>;
  readonly requestProtection: RequestProtectionConfig;
  readonly runtimeNotifier: AlayaRuntimeNotifier;
  readonly startupSteps: readonly DaemonStartupStepRecord[];
  readonly services: AlayaDaemonRuntimeServices;
  startBackgroundServices(): void;
  runGardenBackgroundPass(): Promise<void>;
  startHttpServer(options?: AlayaDaemonListenOptions): Promise<AlayaDaemonServer>;
  shutdown(): Promise<void>;
}

export interface AlayaDaemonRuntimeServices {
  readonly conversationToolCatalog: Readonly<{
    getSpecs(): readonly Readonly<{ readonly tool_id: string; readonly description: string }>[];
    hasToolName(toolName: string): boolean;
  }>;
  readonly daemonMcpCatalog: Readonly<{
    listAllowedServerNames(): readonly string[];
    listEnrolledToolIds(): readonly string[];
    refresh(): Promise<void>;
  }>;
  readonly environmentStatusService: EnvironmentStatusService;
  readonly embeddingStatusService: EmbeddingStatusService;
  readonly mcpMemoryToolHandler: McpMemoryToolHandler;
  readonly trustStateRecorder: TrustStateRecorder;
  readonly principalCodingEngineAvailable: boolean;
}

export interface AlayaDaemonListenOptions {
  readonly hostname?: string;
  readonly port?: number;
}

export interface AlayaDaemonServer {
  readonly hostname: string;
  readonly port: number;
  close(): Promise<void>;
}

const DEFAULT_OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
const GARDEN_BACKLOG_REARM_RATIO = 0.7;
const GARDEN_BACKLOG_SNAPSHOT_INTERVAL_MS = 60_000;

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..", "..");

export async function createAlayaDaemonRuntime(): Promise<AlayaDaemonRuntime> {
  const startupSteps: DaemonStartupStepRecord[] = [];
  const warnLogger = createWarnLogger();
  const runtimeNotifier = createRuntimeNotifier();
  const requestProtection = createRequestProtection();
  const remoteDaemonOptInEnabled = isRemoteDaemonOptInEnabled(process.env);
  const dbPath = resolveDatabasePath();
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
    configPathsProvider: () => resolveAlayaConfigPaths(resolveAlayaConfigDir({ env: process.env }))
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
    claimService: claimService as never,
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
  const memoryEmbeddingRepo = createOptionalMemoryEmbeddingRepo(database);
  const rawEmbeddingSecretRef =
    process.env.ALAYA_OPENAI_SECRET_REF ?? process.env.OPENAI_API_KEY;
  const embeddingApiKey = readOptionalSecretEnv(
    rawEmbeddingSecretRef,
    "ALAYA_OPENAI_SECRET_REF"
  );
  if (embeddingApiKey !== null) {
    process.env.OPENAI_API_KEY = embeddingApiKey;
  }
  const configuredEmbeddingModel = readNonEmptyEnv(process.env.OPENAI_EMBEDDING_MODEL);
  const embeddingModelId = configuredEmbeddingModel ?? (embeddingApiKey === null ? null : DEFAULT_OPENAI_EMBEDDING_MODEL);
  const embeddingSupplementOptInEnabled = process.env.ALAYA_ENABLE_EMBEDDING_SUPPLEMENT === "true";
  const recallPolicyEmbeddingEnabled = false;
  const embeddingStatusService = createEmbeddingStatusService({
    embeddingEnabled: embeddingSupplementOptInEnabled,
    recallPolicyEmbeddingEnabled,
    providerConfigured: embeddingApiKey !== null,
    modelId: embeddingModelId,
    storageAvailable: memoryEmbeddingRepo !== null,
    degradationSource: healthJournalService
  });
  const embeddingProvider =
    memoryEmbeddingRepo === null || !embeddingSupplementOptInEnabled || embeddingApiKey === null
      ? null
      : new OpenAIEmbeddingClient({
          apiKey: embeddingApiKey,
          model: configuredEmbeddingModel ?? undefined
        });
  const embeddingRecallService =
    memoryEmbeddingRepo === null || embeddingProvider === null
      ? undefined
      : new EmbeddingRecallService({
          embeddingRepo: memoryEmbeddingRepo,
          provider: embeddingProvider,
          eventLogRepo,
          healthJournalRecorder: healthJournalService,
          warn: warnLogger.warn
        });
  const embeddingBackfillHandler =
    memoryEmbeddingRepo === null || embeddingProvider === null
      ? undefined
      : new EmbeddingBackfillHandler({
          memoryRepo: memoryEntryRepo,
          memoryEmbeddingRepo,
          provider: embeddingProvider,
          warn: warnLogger.warn
        });
  const recallService = new RecallService({
    memoryRepo: memoryEntryRepo,
    slotRepo,
    eventLogRepo,
    graphSupportPort: graphExploreService,
    projectMappingPort: projectMappingService,
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
  const officialGardenApiKey = embeddingApiKey;
  const officialGardenProvider =
    officialGardenApiKey === null
      ? null
      : new OfficialApiGardenProvider({
          apiKey: officialGardenApiKey,
          model: OFFICIAL_API_GARDEN_MODEL
        });
  const computeRoutingService = new ComputeRoutingService({
    providers: [
      ...(officialGardenProvider === null
        ? []
        : [
            {
              kind: ComputeProviderPriority.OFFICIAL_API,
              provider: officialGardenProvider,
              model_id: OFFICIAL_API_GARDEN_MODEL,
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
  const listServerHardConstraints = async (_workspaceId: string) =>
    Object.freeze([
      Object.freeze({
        ref: "constraint://worker-dispatch",
        content: "Never mutate files outside approved workspace roots."
      })
    ]);
  recordStartupStep(startupSteps, "core-services");

  const gardenBacklogThresholds = createGardenBacklogThresholds();
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
  void rebuildCountersFromEventLog(eventLogRepo, trustStateRecorder).catch((error) => {
    warnLogger.warn("trust-state counter rebuild failed", {
      error: error instanceof Error ? error.message : String(error)
    });
  });
  trustStateRecorder.markReady();
  const mcpMemoryToolHandler = createMcpMemoryToolHandler({
    recallService,
    memoryService,
    signalService,
    graphExploreService,
    sessionOverrideService,
    trustStateRecorder,
    proposalWorkflow: createMcpMemoryProposalWorkflow({
      eventLogRepo,
      proposalRepo,
      runtimeNotifier
    })
  });
  recordStartupStep(startupSteps, "mcp-tooling");

  const app = createApp({
    requestProtection: {
      allowedOrigin: requestProtection.allowedOrigin,
      requestToken: requestProtection.requestToken,
      allowDesktopOriginlessRequests: !remoteDaemonOptInEnabled
    },
    routes: {
      workspaces: {
        workspaceService: securedWorkspaceService,
        engineBindingService,
        workspaceGitBindingRepo: workspaceRepo
      },
      workspaceFiles: {
        workspaceService: securedWorkspaceService,
        runService,
        workerRunRepo,
        toolExecutionRecordRepo,
        gitBindingValidation: {
          currentWorkingDirectory: repoRoot
        }
      },
      securityStatus: {
        workspaceService: securedWorkspaceService,
        securityStatusService
      },
      embeddingStatus: {
        workspaceService: securedWorkspaceService,
        embeddingStatusService
      },
      runs: {
        runService,
        conversationService,
        runHotStateService,
        eventLogRepo,
        governanceLeaseService,
        sessionOverrideService,
        budgetBankruptcyService,
        contextLensAssembler,
        warn: warnLogger.warn
      },
      signals: {
        runService,
        signalService
      },
      evidence: {
        workspaceService: securedWorkspaceService,
        runService,
        evidenceService
      },
      gardenBacklog: {
        gardenBacklogTelemetryService
      },
      memories: {
        workspaceService: securedWorkspaceService,
        runService,
        memoryService
      },
      greenStatus: {
        workspaceService: securedWorkspaceService,
        greenService
      },
      healthJournal: {
        workspaceService: securedWorkspaceService,
        healthJournalService
      },
      config: {
        workspaceService: securedWorkspaceService,
        configService,
        environmentStatusService
      },
      overrides: {
        sessionOverrideService,
        runService
      },
      governance: {
        greenService,
        sessionOverrideService,
        governanceLeaseService,
        runService
      },
      budget: {
        budgetBankruptcyService,
        runService
      },
      slots: {
        workspaceService: securedWorkspaceService,
        slotService,
        arbitrationService
      },
      recall: {
        recallService,
        taskSurfaceBuilder,
        runService,
        workspaceService: securedWorkspaceService
      },
      syntheses: {
        workspaceService: securedWorkspaceService,
        synthesisService
      },
      claims: {
        workspaceService: securedWorkspaceService,
        claimService
      },
      proposals: {
        workspaceService: securedWorkspaceService,
        proposalService
      },
      files: {
        workspaceService: securedWorkspaceService,
        runService,
        fileRepo,
        runtimeNotifier,
        filesDirectory
      },
      soul: {
        workspaceService: securedWorkspaceService,
        topologyAuditService,
        graphExploreService,
        topologyService,
        approvalService: soulApprovalService
      },
      soulGraph: {
        workspaceService: securedWorkspaceService,
        soulGraphService
      },
      status: {
        startupStepsProvider: () => startupSteps.map((step) => step.step),
        principalCodingEngineAvailableProvider: () => principalCodingAvailability.available,
        mcp: mcpTooling.daemonMcpCatalog
      },
      projectMapping: {
        workspaceService: securedWorkspaceService,
        projectMappingService
      },
      ...(globalMemoryService === undefined
        ? {}
        : {
            globalMemory: {
              workspaceService: securedWorkspaceService,
              globalMemoryService
            }
          }),
      conflictMatrix: {
        workspaceService: securedWorkspaceService,
        arbitrationService
      },
      ...(process.env.ALAYA_ENABLE_E2E_EVENT_TRIGGERS === "1"
        ? {
            e2eEventTriggers: {
              runService,
              eventLogRepo,
              runtimeNotifier
            }
          }
        : {})
    },
    principalCodingEngineAvailable: principalCodingAvailability.available,
    listServerHardConstraints
  } as unknown as CoreDaemonServices & {
    readonly principalCodingEngineAvailable: boolean;
    readonly listServerHardConstraints: typeof listServerHardConstraints;
  });
  recordStartupStep(startupSteps, "http-app");

  let server: ServerType | null = null;
  let backgroundStarted = false;
  let shuttingDown: Promise<void> | null = null;

  const startBackgroundServices = (): void => {
    if (backgroundStarted) {
      return;
    }

    gardenBacklogTelemetryService.start();
    gardenRuntime.backgroundManager.start();
    backgroundStarted = true;
  };

  const shutdown = async (): Promise<void> => {
    if (shuttingDown !== null) {
      return await shuttingDown;
    }

    shuttingDown = (async () => {
      if (backgroundStarted) {
        await gardenRuntime.backgroundManager.stop({ timeoutMs: null });
        gardenRuntime.setBacklogTelemetryObserver(null);
        const telemetryStopResult = await gardenBacklogTelemetryService.stop();
        if (telemetryStopResult === "timed_out") {
          warnLogger.warn("garden backlog telemetry shutdown timed out", {});
        }
        backgroundStarted = false;
      }

      securityStatusService.close();
      await mcpTooling.daemonMcpRuntimeRegistry.close();
      globalMemoryRecallInvalidationSubscription?.dispose();

      if (server !== null) {
        await closeServer(server);
        server = null;
      }

      database.close();
    })();

    return await shuttingDown;
  };

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
      trustStateRecorder,
      principalCodingEngineAvailable: principalCodingAvailability.available
    }),
    startBackgroundServices,
    runGardenBackgroundPass: async () => {
      await gardenRuntime.runBackgroundPass();
    },
    startHttpServer: async (options: AlayaDaemonListenOptions = {}) => {
      startBackgroundServices();

      if (server !== null) {
        throw new Error("Alaya daemon HTTP server is already running.");
      }

      const hostname = options.hostname ?? resolveDaemonHostFromEnv(process.env);
      const port = options.port ?? parsePort(process.env.PORT, 3000);
      server = serve({
        fetch: app.fetch,
        hostname,
        port
      });

      process.on("SIGTERM", () => {
        void shutdown();
      });
      process.on("SIGINT", () => {
        void shutdown();
      });

      warnLogger.warn("core daemon listening", {
        host: hostname,
        port,
        url: `http://${hostname}:${port}`
      });

      return Object.freeze({
        hostname,
        port,
        close: shutdown
      });
    },
    shutdown
  });
}

export async function startDaemon(options: AlayaDaemonListenOptions = {}): Promise<AlayaDaemonServer> {
  const runtime = await createAlayaDaemonRuntime();
  return await runtime.startHttpServer(options);
}

function createRequestProtection(): RequestProtectionConfig {
  return Object.freeze({
    allowedOrigin: process.env.ALLOWED_ORIGIN ?? "http://localhost:5173",
    requestToken: process.env.ALAYA_REQUEST_TOKEN ?? randomBytes(32).toString("hex"),
    allowDesktopOriginlessRequests: true
  });
}

function recordStartupStep(
  startupSteps: DaemonStartupStepRecord[],
  step: DaemonStartupStepRecord["step"]
): void {
  startupSteps.push({
    step,
    completedAt: new Date().toISOString()
  });
}

function resolveDatabasePath(): string {
  return process.env.DATA_DIR
    ? join(process.env.DATA_DIR, "alaya.db")
    : join(__dirname, "data", "alaya.db");
}

function parsePort(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim().length === 0) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65_535) {
    throw new Error(`Invalid daemon port: ${value}`);
  }

  return parsed;
}

function createGardenBacklogThresholds(): GardenBacklogThresholds {
  const warningQueueDepth = DEFAULT_SOUL_CONFIG.garden_backlog_soft_limit;

  return {
    warning_queue_depth: warningQueueDepth,
    warning_rearm_depth: Math.max(0, Math.floor(warningQueueDepth * GARDEN_BACKLOG_REARM_RATIO)),
    snapshot_interval_ms: GARDEN_BACKLOG_SNAPSHOT_INTERVAL_MS
  };
}

function readNonEmptyEnv(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function readOptionalSecretEnv(value: string | undefined, label: string): string | null {
  const rawValue = readNonEmptyEnv(value);
  if (rawValue === null) {
    return null;
  }

  if (!rawValue.startsWith("env:") && !rawValue.startsWith("file:")) {
    return rawValue;
  }

  const resolved = resolveSecretRef(rawValue);
  if ("kind" in resolved) {
    throw new Error(formatSecretResolutionError(label, resolved));
  }

  return resolved.value;
}

function formatSecretResolutionError(label: string, error: ResolveSecretError): string {
  switch (error.kind) {
    case "malformed":
      return `${label}: ${error.ref} -> ${error.reason}`;
    case "env_missing":
      return `${label}: ${error.ref} -> environment variable ${error.var_name} is not set`;
    case "file_missing":
      return `${label}: ${error.ref} -> file not found at ${error.path}`;
    case "file_unreadable":
      return `${label}: ${error.ref} -> file unreadable at ${error.path} (${error.cause})`;
    case "empty":
      return `${label}: ${error.ref} -> ${error.origin} secret is empty`;
  }
}

function createOptionalMemoryEmbeddingRepo(database: StorageDatabase): MemoryEmbeddingRepo | null {
  const RepoCtor = StorageModule.SqliteMemoryEmbeddingRepo;
  if (typeof RepoCtor !== "function" || !supportsPreparedSqliteConnection(database)) {
    return null;
  }

  return new RepoCtor(database);
}

function createOptionalGlobalMemoryRepo(database: StorageDatabase): GlobalMemoryRepo | null {
  if (!supportsPreparedSqliteConnection(database)) {
    return null;
  }

  return new SqliteGlobalMemoryRepo(database);
}

function createOptionalGlobalMemoryRecallCacheRepo(
  database: StorageDatabase
): GlobalMemoryRecallCacheRepo | null {
  if (!supportsPreparedSqliteConnection(database)) {
    return null;
  }

  return new SqliteGlobalMemoryRecallCacheRepo(database);
}

function supportsPreparedSqliteConnection(database: StorageDatabase): boolean {
  return typeof database.connection.prepare === "function";
}

function createGlobalMemoryRouteService(params: {
  readonly globalMemoryRepo: GlobalMemoryRepo;
  readonly projectMappingService: ProjectMappingService;
}) {
  return {
    list: async (input: { readonly dimension?: string; readonly scope_class?: string; readonly limit: number }) => {
      const entries = await params.globalMemoryRepo.list({
        ...(input.dimension === undefined ? {} : { dimension: input.dimension }),
        ...(input.scope_class === undefined ? {} : { scope_class: input.scope_class })
      } as GlobalMemoryListFilters);

      return input.limit >= entries.length ? entries : entries.slice(0, input.limit);
    },
    adopt: async (
      globalObjectId: string,
      input: { readonly workspace_id: string; readonly accepted_by?: AcceptedBy }
    ) => await adoptGlobalMemoryEntry(params.globalMemoryRepo, params.projectMappingService, globalObjectId, input)
  };
}

function createGlobalMemoryRecallPort(params: {
  readonly globalMemoryRepo: GlobalMemoryRepo;
}): GlobalMemoryRecallServicePort {
  return createCoreGlobalMemoryRecallPort({
    globalMemorySource: {
      list: async () => await params.globalMemoryRepo.list()
    }
  });
}

function createGlobalMemoryRecallCachePort(params: {
  readonly globalMemoryRecallCacheRepo: GlobalMemoryRecallCacheRepo;
  readonly now?: () => string;
}): GlobalMemoryRecallCachePort {
  const now = params.now ?? (() => new Date().toISOString());

  return {
    recordClassifications: async (records) => {
      const updatedAt = now();
      await params.globalMemoryRecallCacheRepo.upsertMany(
        records.map((record) => ({
          workspace_id: record.workspaceId,
          global_object_id: record.globalObjectId,
          classification: record.classification,
          updated_at: updatedAt
        }))
      );
    }
  };
}

async function adoptGlobalMemoryEntry(
  globalMemoryRepo: GlobalMemoryRepo,
  projectMappingService: ProjectMappingService,
  globalObjectId: string,
  input: { readonly workspace_id: string; readonly accepted_by?: AcceptedBy }
) {
  const entry = (await globalMemoryRepo.findByGlobalObjectId(globalObjectId)) as Readonly<GlobalMemoryEntry> | null;

  if (entry === null) {
    throw new CoreError("NOT_FOUND", `Global memory ${globalObjectId} was not found.`);
  }

  const acceptedBy = input.accepted_by ?? AcceptedBy.USER;
  const anchor = await projectMappingService.ensureAdoptableAnchor(
    entry.global_object_id,
    input.workspace_id,
    acceptedBy
  );

  if (anchor.mapping_state === ProjectMappingState.ACCEPTED) {
    return anchor;
  }

  return await projectMappingService.accept(anchor.object_id, acceptedBy);
}

function createSoulGraphService(input: {
  readonly memoryEntryRepo: SqliteMemoryEntryRepo;
  readonly memoryGraphEdgeRepo: SqliteMemoryGraphEdgeRepo;
}) {
  return {
    buildSoulGraph: async ({
      workspaceId,
      limit
    }: {
      readonly workspaceId: string;
      readonly depth: number;
      readonly limit: number;
    }): Promise<SoulGraph> => {
      const memories = await input.memoryEntryRepo.findByWorkspaceId(workspaceId);
      const edges = await input.memoryGraphEdgeRepo.findByWorkspace(workspaceId);
      const limitedMemories = memories.slice(0, limit);
      const memoryIds = new Set(limitedMemories.map((memory: MemoryEntryRecord) => memory.object_id));
      const limitedEdges = edges
        .filter((edge) => memoryIds.has(edge.source_memory_id) && memoryIds.has(edge.target_memory_id))
        .slice(0, limit);

      return {
        workspace_id: workspaceId,
        nodes: limitedMemories.map((memory: MemoryEntryRecord) => ({
          id: memory.object_id,
          kind: "memory",
          label: memory.content.slice(0, 80),
          summary: memory.content,
          workspace_id: memory.workspace_id,
          created_at: memory.created_at,
          origin_plane: "project"
        })),
        edges: limitedEdges.map((edge) => ({
          id: edge.edge_id,
          kind: "references",
          source_id: edge.source_memory_id,
          target_id: edge.target_memory_id,
          created_at: edge.created_at
        })),
        truncated: memories.length > limitedMemories.length || edges.length > limitedEdges.length,
        node_total: memories.length,
        edge_total: edges.length
      };
    }
  };
}

function createConversationToolExecutor(input: {
  readonly eventLogRepo: SqliteEventLogRepo;
  readonly runtimeNotifier: AlayaRuntimeNotifier;
  readonly toolExecutionRecordRepo: SqliteToolExecutionRecordRepo;
  readonly toolGovernanceClient: ToolGovernanceClient;
  readonly targetRevalidateService: unknown;
  readonly strongRefService: StrongRefService;
  readonly canonicalAliasService: CanonicalAliasService;
}) {
  void input.toolGovernanceClient;
  void input.targetRevalidateService;
  void input.strongRefService;
  void input.canonicalAliasService;

  return {
    execute: async (request: {
      readonly toolId: string;
      readonly rawInput: unknown;
      readonly runtimeContext: { readonly run_id: string; readonly workspace_id: string };
      readonly workspaceRoot: string;
      readonly affectedPathRoots?: readonly string[];
      readonly handler: (context: { readonly writableRoots: readonly string[] }, rawInput?: unknown) => Promise< unknown>;
    }) => {
      const startedAt = new Date().toISOString();
      const result = await request.handler(
        { writableRoots: [request.workspaceRoot] },
        request.rawInput
      );
      const endedAt = new Date().toISOString();
      const executionId = randomUUID();
      const affectedPaths = request.affectedPathRoots ?? [];

      await input.toolExecutionRecordRepo.insert({
        execution_id: executionId,
        tool_id: request.toolId,
        requested_by: "principal",
        requesting_run_id: request.runtimeContext.run_id,
        governance_decision_ref: "fast-path://recorded",
        permission_result: "allow",
        executed: true,
        started_at: startedAt,
        ended_at: endedAt,
        result_summary: summarizeToolResult(result),
        rollback_status: "none",
        affected_paths: affectedPaths
      });
      const event = await input.eventLogRepo.append({
        event_type: "tool_call.completed",
        entity_type: "tool_call",
        entity_id: executionId,
        workspace_id: request.runtimeContext.workspace_id,
        run_id: request.runtimeContext.run_id,
        caused_by: "principal",
        revision: 0,
        payload_json: {
          tool_call_id: executionId,
          tool_id: request.toolId,
          permission_result: "allow",
          executed: true,
          affected_paths: affectedPaths,
          result_summary: summarizeToolResult(result)
        }
      });
      await input.runtimeNotifier.notifyEntry(event);

      return { result };
    }
  };
}

function summarizeToolResult(result: unknown): string {
  if (typeof result === "object" && result !== null && "ok" in result) {
    return (result as { readonly ok?: boolean }).ok === false ? "error" : "ok";
  }

  return "ok";
}

function createAlayaConversationEngine() {
  return {
    sendMessage: async () => ({
      message: {
        role: "assistant" as const,
        content: "Alaya does not execute chat turns; use MCP memory tools.",
        message_id: randomUUID()
      },
      finish_reason: "stop" as const
    }),
    streamMessage: async function* () {}
  };
}

function createEngineBindingTester() {
  return {
    testBinding: async (binding: EngineBinding): Promise<EngineBindingSummary & { readonly available_models: readonly string[] }> => ({
      provider_type: binding.provider,
      base_url: binding.base_url ?? null,
      model: binding.model,
      available_models: []
    })
  };
}

function createUnavailableRuntimeAdapter(): AgentRuntimePort {
  return {
    kind: "unavailable",
    getCapabilities: () => ({
      supports_resume: false,
      supports_interrupt: false,
      supports_streaming_updates: false,
      supports_tool_events: false,
      supports_permission_requests: false,
      supports_artifact_events: false,
      supports_terminal_events: false
    }),
    createSession: async () => {
      throw new Error("Principal runtime adapter is not configured.");
    },
    prompt: async () => {
      throw new Error("Principal runtime adapter is not configured.");
    },
    cancel: async (sessionId: string) => ({
      session_id: sessionId,
      status: "not_found",
      message: "Principal runtime adapter is not configured."
    }),
    onEvent: () => () => undefined
  };
}

function createKarmaEventStore(karmaEventRepo: SqliteKarmaEventRepo, warnLogger: ReturnType<typeof createWarnLogger>) {
  return new SqliteKarmaEventStore(karmaEventRepo, warnLogger);
}

function patchArbitrationClaimService(arbitrationService: ArbitrationService, claimService: ClaimService): void {
  const dependencies = (arbitrationService as unknown as { dependencies?: { claimService?: ClaimService } }).dependencies;
  if (dependencies !== undefined) {
    dependencies.claimService = claimService;
  }
}

async function closeServer(server: ServerType): Promise<void> {
  const close = server.close.bind(server) as (callback?: (error?: Error) => void) => void;

  if (close.length === 0) {
    close();
    return;
  }

  await new Promise<void>((resolveClose, rejectClose) => {
    close((error?: Error) => {
      if (error !== undefined) {
        rejectClose(error);
        return;
      }

      resolveClose();
    });
  });
}

if (process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], "file://").href) {
  await startDaemon();
}
