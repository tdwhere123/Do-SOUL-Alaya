import { serve } from "@hono/node-server";
import { randomBytes, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AcceptedBy,
  ComputeProviderPriority,
  DEFAULT_SOUL_CONFIG,
  GLOBAL_MEMORY_ENTRY_OBJECT_KIND,
  PromptAssetSchema,
  ProjectMappingState,
  assertFrozenNodeTemplateContracts,
  type GardenBacklogThresholds,
  type ExecutionStanceModelRef,
  type ExecutionStancePolicy,
  type ExecutionStanceResolution,
  type Proposal,
  type ToolSpec,
  type ZeroDayPolicy
} from "@do-what/protocol";
import {
  ArbitrationService,
  EmbeddingBackfillHandler,
  EmbeddingRecallService,
  BudgetBankruptcyService,
  CanonicalAliasService,
  CircuitBreaker,
  ClaimService,
  ConversationToolExecutor,
  ContextLensAssembler,
  CoreError,
  StanceResolutionService,
  ConversationService,
  createGlobalMemoryRecallPort as createCoreGlobalMemoryRecallPort,
  CrossCuttingPermissionService,
  DeferredObligationService,
  DirtyStatePanicService,
  EngineBindingService,
  DynamicsService,
  EvidenceService,
  GardenBacklogTelemetryService,
  GreenService,
  type GlobalMemoryRecallCachePort,
  type GlobalMemoryRecallPort,
  HealthJournalService,
  GovernanceLeaseService,
  GraphExploreService,
  MemoryService,
  NarrativeBudgetService,
  NodeClaudeSDKClientFactory,
  OutputShapingService,
  SessionOverrideService,
  StrongRefService,
  ProposalService,
  ProjectMappingService,
  RecallService,
  OpenAIEmbeddingClient,
  RunService,
  SlashCommandService,
  SignalService,
  SlotService,
  SqliteKarmaEventStore,
  STRATEGY_RECALL_DEFAULTS,
  SurfaceBindingService,
  SurfaceDriftService,
  SurfaceService,
  SynthesisService,
  TaskSurfaceBuilder,
  ToolFastPath,
  ToolGovernanceClient,
  ToolSpecService,
  ToolSubstrate,
  TargetRevalidateService,
  WorkerTrustAssessor,
  ZeroDaySecurityLayer,
  type ConversationExecutionStanceResolverPort,
  type ConversationServiceDependencies,
  type SlotServiceArbitrationResult
} from "@do-what/core";
import {
  APIConversationEngine,
  buildConversationToolDefs,
  McpBridge,
} from "@do-what/engine-gateway";
import * as StorageModule from "@do-what/storage";
import {
  Auditor,
  BootstrappingService,
  ComputeRoutingService,
  DegradationPipeline,
  LocalHeuristics,
  MaterializationRouter,
  OFFICIAL_API_GARDEN_MODEL,
  OfficialApiGardenProvider,
  SessionOverrideRemediation,
  SoulGraphAggregator,
  SoulWorkerSafetyAdapter,
  SoulWorkerSafetyReader,
  SoulSignalHandler,
  SoulToolGovernanceAdapter,
  TopologyService
} from "@do-what/soul";
import { createComputeRoutingExecutionStanceResolver } from "./compute-routing-resolver.js";
import {
  createGardenBackgroundDataPorts,
  SqliteBootstrappingRecordRepo,
  SqliteClaimFormRepo,
  SqliteConfigRepo,
  SqliteDeferredObligationRepo,
  SqliteDirtyStateDossierRepo,
  SqliteExtensionDescriptorRepo,
  SqliteConflictMatrixRepo,
  SqliteCrossCuttingPermissionRepo,
  SqliteDriftLeaseRepo,
  SqliteEngineBindingRepo,
  SqliteEventLogRepo,
  SqliteEvidenceCapsuleRepo,
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
  SqliteProposalRepo,
  SqliteProjectMappingAnchorRepo,
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
  SqliteWorkerRunRepo,
  SqliteWorkspaceRepo,
  initDatabase,
  type GlobalMemoryRecallCacheRepo,
  type GlobalMemoryRepo,
  type MemoryEmbeddingRepo,
  type StorageDatabase
} from "@do-what/storage";
import { createApp } from "./app.js";
import type {
  GlobalMemoryAdoptInput,
  GlobalMemoryRouteService,
} from "./routes/global-memory.js";
import { parseZeroDayPoliciesJson } from "./zero-day-policies.js";
import { createBudgetProposalPort } from "./budget-wiring.js";
import { defaultBootstrappingTemplates, defaultCanonicalAliasMap } from "./daemon-defaults.js";
import {
  createManifestationBudgetConfigProvider,
  createStancePolicyProvider,
  createTargetCurrencyCheckPort,
  createWarnLogger
} from "./daemon-runtime-helpers.js";
import { resolveCoreDaemonFilesDirectory } from "./files-data-dir.js";
import { createGardenRuntime } from "./garden-runtime.js";
import { createConfigService } from "./services/config-service.js";
import { createEnvironmentStatusService } from "./services/environment-status-service.js";
import { createEmbeddingStatusService } from "./services/embedding-status-service.js";
import {
  CORE_DAEMON_ENVIRONMENT_TOOLS,
  derivePrincipalCodingAvailability
} from "./services/principal-coding-availability.js";
import { createSoulApprovalService } from "./services/soul-approval-service.js";
import { SqliteWorkspaceEngineConfigRepo } from "./services/workspace-engine-config-repo.js";
import { createSecurityStatusBootstrapServices } from "./security-status-bootstrap.js";
import { isRemoteDaemonOptInEnabled, resolveDaemonHostFromEnv } from "./server-options.js";
import { SseManager } from "./sse/sse-manager.js";
import { SqliteHandoffGapAdapter } from "./handoff-gap-adapter.js";
import { createManifestationContextLensAssembler } from "./manifestation-context-lens-assembler.js";
import {
  createDaemonMcpRuntimeRegistry,
} from "./mcp-runtime-registry.js";
import { type DaemonMcpCatalog } from "./mcp-catalog.js";
import { bootstrapDaemonMcpTooling } from "./daemon-mcp-tooling.js";
import { createNarrativeBudgetRepo } from "./narrative-budget-repo.js";
import { handleConversationToolUse } from "./tool-runtime.js";
import { createWorkerRuntimeWiring } from "./worker-runtime-wiring.js";

const allowedOrigin = process.env.ALLOWED_ORIGIN ?? "http://localhost:5173";
const remoteDaemonOptInEnabled = isRemoteDaemonOptInEnabled(process.env);
const embeddingSupplementOptInEnabled = process.env.DO_WHAT_ENABLE_EMBEDDING_SUPPLEMENT === "true";
const recallPolicyEmbeddingEnabled = Object.values(STRATEGY_RECALL_DEFAULTS).some(
  (strategy) => strategy.coarse.semantic_supplement.embedding_enabled === true
);
const DEFAULT_OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
const requestToken = randomBytes(32).toString("hex");
const warnLogger = createWarnLogger();
const GARDEN_BACKLOG_REARM_RATIO = 0.7;
const GARDEN_BACKLOG_SNAPSHOT_INTERVAL_MS = 60_000;
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..", "..");
const dbPath = process.env.DATA_DIR
  ? join(process.env.DATA_DIR, "do-what.db")
  : join(__dirname, "data", "do-what.db");
const orphanDetectionEnabled = process.env.ORPHAN_DETECTION_ENABLED !== "false";
assertFrozenNodeTemplateContracts();
const database = initDatabase({ filename: dbPath });
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
const strongRefRepo = new SqliteStrongRefRepo(database);
const pathRelationRepo = new SqlitePathRelationRepo(database);
const bootstrappingPlanner = new BootstrappingService({
  templates: defaultBootstrappingTemplates,
  now: () => new Date().toISOString()
});
const pathGraphSnapshotRepo = new SqlitePathGraphSnapshotRepo(database);
const workerRunRepo = new SqliteWorkerRunRepo(database);
const deferredObligationRepo = new SqliteDeferredObligationRepo(database);
const dirtyStateDossierRepo = new SqliteDirtyStateDossierRepo(database);
const workspaceEngineConfigRepo = new SqliteWorkspaceEngineConfigRepo(database);
const filesDirectory = resolveCoreDaemonFilesDirectory();
const configService = createConfigService({
  configRepo
});
const environmentStatusService = createEnvironmentStatusService({
  toolNames: CORE_DAEMON_ENVIRONMENT_TOOLS,
  getDatabasePath: () => database.filename,
  getFilesDirectory: () => filesDirectory
});
const stancePolicyProvider = createStancePolicyProvider(configRepo);
const manifestationBudgetConfigProvider = createManifestationBudgetConfigProvider(configRepo);
const sseManager = new SseManager(eventLogRepo);
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
  sseBroadcaster: sseManager,
  zeroDayLayer: zeroDaySecurityLayer,
  engineConfigRepo: workspaceEngineConfigRepo,
  bootstrappingPlanner,
  pathRelationRepo,
  bootstrappingRecordRepo
});
const toolSpecService = new ToolSpecService({ toolSpecRepo });
const toolSubstrate = new ToolSubstrate({
  generateExecutionId: () => randomUUID(),
  now: () => new Date().toISOString()
});
const toolFastPath = new ToolFastPath({
  substrate: toolSubstrate,
  executionRecordRepo: toolExecutionRecordRepo,
  eventLogRepo,
  sseBroadcaster: sseManager
});
const toolGovernanceClient = new ToolGovernanceClient({
  port: new SoulToolGovernanceAdapter({
    listClaimsForProject: async (projectRef) => await claimFormRepo.findByWorkspaceId(projectRef),
    listSlotsForProject: async (projectRef) => await slotRepo.findByWorkspace(projectRef)
  })
});
const strongRefService = new StrongRefService({
  repo: strongRefRepo
});
const targetRevalidateService = new TargetRevalidateService({
  strongRefRepo,
  currencyCheckPort: createTargetCurrencyCheckPort({
    claimFormRepo,
    slotRepo
  })
});
const circuitBreaker = new CircuitBreaker({
  config: {
    spamThreshold: 3,
    windowMs: 60_000
  },
  eventLogRepo,
  sseBroadcaster: sseManager
});
const {
  daemonMcpRuntimeRegistry,
  daemonMcpCatalog,
  extensionRegistryService,
  conversationToolCatalog,
  externalConversationToolExecutor
} = await bootstrapDaemonMcpTooling({
  eventLogRepo,
  extensionDescriptorRepo,
  now: () => new Date().toISOString(),
  sseBroadcaster: sseManager,
  toolSpecService,
  warnLogger
});
const canonicalAliasService = new CanonicalAliasService({
  aliasMap: defaultCanonicalAliasMap,
  eventPublisher
});
const conversationToolExecutor = new ConversationToolExecutor({
  toolSpecService,
  substrate: toolSubstrate,
  governanceClient: toolGovernanceClient,
  fastPath: toolFastPath,
  targetRevalidateService,
  strongRefService,
  executionRecordRepo: toolExecutionRecordRepo,
  eventLogRepo,
  sseBroadcaster: sseManager,
  circuitBreaker,
  canonicalAliasService,
  extensionRegistry: extensionRegistryService,
  now: () => new Date().toISOString(),
  generateExecutionId: () => randomUUID()
});
const outputShapingService = new OutputShapingService({
  rules: Object.freeze([
    {
      command_class: "file_read",
      min_consecutive: 3,
      compression_mode: "count_summary"
    },
    {
      command_class: "file_write",
      min_consecutive: 2,
      compression_mode: "last_only"
    },
    {
      command_class: "search",
      min_consecutive: 2,
      compression_mode: "last_only"
    },
    {
      command_class: "navigation",
      min_consecutive: 3,
      compression_mode: "first_last"
    },
    {
      command_class: "verification",
      min_consecutive: 2,
      compression_mode: "last_only"
    },
    {
      command_class: "governance_query",
      min_consecutive: 2,
      compression_mode: "last_only"
    }
  ])
});
const narrativeBudgetService = new NarrativeBudgetService({
  repo: createNarrativeBudgetRepo({ eventLogRepo }),
  eventLogReader: eventLogRepo,
  eventPublisher
});
const workerTrustAssessor = new WorkerTrustAssessor({
  eventPublisher
});
const {
  constraintProxy,
  deferredObligationService,
  dirtyStatePanicService,
  listServerHardConstraints,
  principalCodingEngineAvailable,
  principalRuntimeAdapterFactory,
  runtimeEventNormalizer,
  serialDelegationService,
  workerDispatchPromptAssembler,
  workerRunLifecycleService
} = await createWorkerRuntimeWiring({
  claimFormRepo,
  deferredObligationRepo,
  dirtyStateDossierRepo,
  environmentStatusService,
  eventLogRepo,
  eventPublisher,
  sseBroadcaster: sseManager,
  strongRefService,
  warnLogger,
  workerRunRepo,
  zeroDaySecurityLayer
});
const evidenceService = new EvidenceService({
  evidenceCapsuleRepo,
  eventLogRepo,
  sseBroadcaster: sseManager
});
const governanceLeaseService = new GovernanceLeaseService({
  eventLogRepo
});
const healthJournalService = new HealthJournalService({
  repo: healthJournalRepo,
  eventLogRepo,
  sseBroadcaster: sseManager
});
const memoryEmbeddingRepo = createOptionalMemoryEmbeddingRepo(database);
const embeddingApiKey = readNonEmptyEnv(process.env.OPENAI_API_KEY);
const configuredEmbeddingModel = readNonEmptyEnv(process.env.OPENAI_EMBEDDING_MODEL);
const embeddingModelId = configuredEmbeddingModel ?? (embeddingApiKey === null ? null : DEFAULT_OPENAI_EMBEDDING_MODEL);
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
const greenService = new GreenService({
  greenStatusRepo,
  memoryRepo: memoryEntryRepo,
  eventLogRepo,
  sseBroadcaster: sseManager,
  leaseService: governanceLeaseService,
  warn: warnLogger.warn
});
const sessionOverrideService = new SessionOverrideService({
  eventLogRepo
});
const dynamicsService = new DynamicsService({
  memoryRepo: memoryEntryRepo,
  karmaEventRepo,
  eventLogRepo,
  sseBroadcaster: sseManager,
  greenService
});
const memoryService = new MemoryService({
  memoryEntryRepo,
  evidenceService,
  eventLogRepo,
  sseBroadcaster: sseManager,
  dynamicsService,
  greenService
});
const graphExploreService = new GraphExploreService({
  memoryRepo: memoryEntryRepo,
  edgeRepo: memoryGraphEdgeRepo,
  eventLogRepo,
  sseBroadcaster: sseManager
});
const topologyService = new TopologyService({
  pathRelationRepo,
  snapshotHistory: {
    getHistory: async (workspaceId, limit) => await pathGraphSnapshotRepo.findHistory(workspaceId, limit)
  }
});
const soulGraphService = new SoulGraphAggregator({
  memoryRepo: memoryEntryRepo,
  edgeRepo: memoryGraphEdgeRepo,
  runRepo,
  signalRepo,
  projectMappingRepo: projectMappingAnchorRepo,
  ...(globalMemoryRepo === null ? {} : { globalMemoryRepo })
});
const synthesisService = new SynthesisService({
  synthesisCapsuleRepo,
  evidenceService,
  memoryService,
  eventLogRepo,
  sseBroadcaster: sseManager
});
const arbitrationServiceRef: {
  current: ArbitrationService | null;
} = {
  current: null
};

const arbitrationServicePort = {
  arbitrateSlot: async (
    slotId: string,
    options?: {
      readonly dryRun?: boolean;
    }
  ): Promise<SlotServiceArbitrationResult> => {
    if (arbitrationServiceRef.current === null) {
      throw new Error("Arbitration service has not been initialized.");
    }

    return await arbitrationServiceRef.current.arbitrateSlot(slotId, options);
  }
};

const slotService = new SlotService({
  slotRepo,
  eventLogRepo,
  sseBroadcaster: sseManager,
  arbitrationService: arbitrationServicePort
});

const taskSurfaceBuilder = new TaskSurfaceBuilder({
  surfaceRepo: surfaceIdentityRepo,
  eventLogRepo
});

const budgetNow = () => new Date().toISOString();
const projectMappingService = new ProjectMappingService({
  projectMappingRepo: projectMappingAnchorRepo,
  memoryRepo: memoryEntryRepo,
  eventLogRepo,
  sseBroadcaster: sseManager
});
const globalMemoryService =
  globalMemoryRepo === null
    ? undefined
    : createGlobalMemoryRouteService({
        globalMemoryRepo,
        projectMappingService
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
        globalRecallPort: createGlobalMemoryRecallPort({ globalMemoryRepo }),
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

const budgetBankruptcyService = new BudgetBankruptcyService({
  eventLogRepo,
  proposalService: createBudgetProposalPort({
    proposalRepo,
    now: budgetNow
  }),
  sseBroadcaster: sseManager,
  now: budgetNow
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
  sseBroadcaster: sseManager,
  warn: warnLogger.warn
});
const conversationContextLensAssembler = createManifestationContextLensAssembler({
  delegate: contextLensAssembler
});

const crossCuttingPermissionService = new CrossCuttingPermissionService({
  crossCuttingRepo: crossCuttingPermissionRepo,
  sseBroadcaster: sseManager
});

const driftLeaseRepo = new SqliteDriftLeaseRepo(database);
const surfaceDriftService = new SurfaceDriftService({
  leaseRepo: driftLeaseRepo,
  eventPublisher
});

const surfaceBindingService = new SurfaceBindingService({
  surfaceBindingRepo,
  crossCuttingPermissionLookup: crossCuttingPermissionRepo,
  eventPublisher,
  sseBroadcaster: sseManager,
  surfaceDriftService
});

const surfaceService = new SurfaceService({
  surfaceIdentityRepo,
  surfaceAnchorRepo,
  sseBroadcaster: sseManager,
  surfaceDriftService,
  surfaceBindingCascader: surfaceBindingService
});

const claimService = new ClaimService({
  claimFormRepo,
  eventLogRepo,
  slotService,
  sseBroadcaster: sseManager,
  eventPublisher,
  canonicalAliasService
});
const sessionOverrideRemediation = new SessionOverrideRemediation({
  memoryService,
  claimService,
  eventLogRepo,
  targetObjectResolver: {
    resolveDimension: async (targetObject) => {
      const memory = await memoryService.findById(targetObject);
      return memory?.dimension ?? null;
    }
  },
  warn: warnLogger.warn
});

const arbitrationService = new ArbitrationService({
  slotRepo,
  claimRepo: claimFormRepo,
  conflictMatrixRepo,
  claimService,
  eventLogRepo,
  sseBroadcaster: sseManager
});

arbitrationServiceRef.current = arbitrationService;

const proposalService = new ProposalService({
  proposalRepo,
  claimService,
  synthesisService,
  eventLogRepo,
  karmaEventStore: new SqliteKarmaEventStore(karmaEventRepo, warnLogger),
  dynamicsService,
  warn: warnLogger,
  sseBroadcaster: sseManager
});
const sqliteHandoffGapRepo = new SqliteHandoffGapRepo(database);
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
  sseBroadcaster: sseManager,
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
const mcpBridge = new McpBridge({
  hasConversationToolName: (toolName) => conversationToolCatalog.hasToolName(toolName),
  soulHandler: async (toolUse, runtimeContext) => await soulHandler.handleToolUse(toolUse, runtimeContext),
  toolsHandler: async (toolUse, runtimeContext) =>
    await handleConversationToolUse(
      toolUse,
      runtimeContext,
      workspaceRepo,
      conversationToolExecutor,
      {
        externalToolExecutor: externalConversationToolExecutor,
        gitBindingValidation: {
          currentWorkingDirectory: repoRoot
        },
        warn: warnLogger.warn
      }
    )
});

const runService = new RunService({
  workspaceRepo,
  runRepo,
  bindingRepo,
  eventPublisher,
  isPrincipalCodingEngineAvailable: () => principalCodingEngineAvailable
});
const apiConversationEngine = new APIConversationEngine({
  getConversationToolDefs: () => buildConversationToolDefs(conversationToolCatalog.getSpecs()),
  mcpBridge
});
const conversationEngine = apiConversationEngine;
const engineBindingService = new EngineBindingService({
  workspaceRepo,
  bindingRepo,
  eventPublisher,
  engineTester: apiConversationEngine
});
const localHeuristicsProvider = new LocalHeuristics();
const officialGardenApiKey = readNonEmptyEnv(process.env.OPENAI_API_KEY);
const officialGardenModel = OFFICIAL_API_GARDEN_MODEL;
const officialGardenProvider =
  officialGardenApiKey === null
    ? null
    : new OfficialApiGardenProvider({
        apiKey: officialGardenApiKey,
        model: officialGardenModel
      });
const computeRoutingService = new ComputeRoutingService({
  providers: [
    ...(officialGardenProvider === null
      ? []
      : [
          {
            kind: ComputeProviderPriority.OFFICIAL_API,
            provider: officialGardenProvider,
            model_id: officialGardenModel,
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
const resolveExecutionStance: ConversationExecutionStanceResolverPort =
  createComputeRoutingExecutionStanceResolver({
    computeRoutingService,
    eventLogWriter: eventLogRepo,
    stanceResolutionService
  });

const conversationServiceDependencies = {
  engine: conversationEngine,
  eventPublisher,
  runHotStateService,
  runRepo,
  workspaceRepo,
  eventLogRepo,
  resolveBinding: async (run, workspace) => await engineBindingService.resolveConversationBinding(run, workspace),
  gardenComputeProvider,
  resolveGardenComputeProvider: {
    resolve: (modelRef) => computeRoutingService.resolveProvider(modelRef)
  },
  signalReceiver: signalService,
  runtimeAdapterFactory: principalRuntimeAdapterFactory,
  resolveAllowedMcpServers: async () => daemonMcpCatalog.listAllowedServerNames(),
  outputShapingService,
  sessionOverridePromotion: {
    evaluateActiveForRun: async ({ runId, workspaceId }) => {
      await sessionOverrideRemediation.evaluatePending({
        runId,
        workspaceId,
        overrides: await sessionOverrideService.getActiveFor(runId)
      });
    }
  },
  contextLensAssembler: conversationContextLensAssembler,
  governanceLeaseService,
  fileRepo,
  filesDirectory,
  resolveExecutionStance,
  healthJournalRecorder: healthJournalService,
  sseBroadcaster: sseManager,
  warn: warnLogger.warn
} satisfies ConversationServiceDependencies;
const conversationService = new ConversationService(conversationServiceDependencies);
const slashCommandService = new SlashCommandService({
  clientFactory: new NodeClaudeSDKClientFactory(),
  runRepo,
  workspaceRepo,
  resolveAllowedMcpServers: async () => daemonMcpCatalog.listAllowedServerNames(),
  isPrincipalCodingEngineAvailable: () => principalCodingEngineAvailable,
  warn: warnLogger.warn
});
const soulApprovalService = createSoulApprovalService({
  eventLogRepo,
  runLookup: async (runId) => await runService.getById(runId),
  sseBroadcaster: sseManager
});
const gardenBacklogThresholds = createGardenBacklogThresholds();
const gardenDataPorts = createGardenBackgroundDataPorts(database);
const {
  backgroundManager,
  backlogTelemetrySource,
  setBacklogTelemetryObserver
} = createGardenRuntime({
  databaseConnection: database.connection,
  backlogThresholds: gardenBacklogThresholds,
  eventLogRepo,
  eventPublisher,
  gardenDataPorts,
  healthJournalRepo,
  handoffGapRepo: sqliteHandoffGapRepo,
  orphanDetectionEnabled,
  orphanRadarRepo,
  pathGraphSnapshotRepo,
  pathRelationRepo,
  embeddingBackfillHandler,
  sseBroadcaster: sseManager,
  strongRefService,
  workspaceRepo
});
const gardenBacklogTelemetryService = new GardenBacklogTelemetryService({
  scheduler: backlogTelemetrySource,
  eventLogRepo,
  sseBroadcaster: sseManager,
  healthJournal: healthJournalService,
  thresholds: gardenBacklogThresholds,
  warn: warnLogger.warn
});
setBacklogTelemetryObserver(gardenBacklogTelemetryService);
const app = createApp({
  workspaceService: securedWorkspaceService,
  workspaceGitBindingRepo: workspaceRepo,
  toolExecutionRecordRepo,
  workerRunRepo,
  gitBindingValidation: {
    currentWorkingDirectory: repoRoot
  },
  securityStatusService,
  embeddingStatusService,
  runService,
  conversationService,
  principalCodingEngineAvailable,
  engineBindingService,
  runHotStateService,
  eventLogRepo,
  serialDelegationService,
  slashCommandService,
  workerDispatchPromptAssembler,
  workerTrustAssessor,
  narrativeBudgetService,
  listServerHardConstraints,
  warn: warnLogger.warn,
  sseManager,
  signalService,
  evidenceService,
  memoryService,
  gardenBacklogTelemetryService,
  healthJournalService,
  greenService,
  budgetNow,
  budgetBankruptcyService,
  governanceLeaseService,
  sessionOverrideService,
  slotService,
  surfaceService,
  surfaceAnchorRepo,
  surfaceBindingService,
  crossCuttingPermissionService,
  synthesisService,
  claimService,
  proposalService,
  configService,
  environmentStatusService,
  fileRepo,
  filesDirectory,
  arbitrationService,
  graphExploreService,
  topologyService,
  soulGraphService,
  soulApprovalService,
  recallService,
  projectMappingService,
  globalMemoryService,
  taskSurfaceBuilder,
  contextLensAssembler,
  karmaEventPreview: karmaEventRepo,
  enableE2eEventTriggers: process.env.DO_WHAT_ENABLE_E2E_EVENT_TRIGGERS === "1",
  requestProtection: {
    allowedOrigin,
    requestToken,
    allowDesktopOriginlessRequests: !remoteDaemonOptInEnabled
  }
});

function createOptionalGlobalMemoryRepo(database: unknown): GlobalMemoryRepo | null {
  if (!hasSqlitePrepare(database)) {
    return null;
  }

  return new SqliteGlobalMemoryRepo(database as StorageDatabase);
}

function createOptionalGlobalMemoryRecallCacheRepo(database: unknown): GlobalMemoryRecallCacheRepo | null {
  if (!hasSqlitePrepare(database)) {
    return null;
  }

  return new SqliteGlobalMemoryRecallCacheRepo(database as StorageDatabase);
}

function hasSqlitePrepare(database: unknown): database is StorageDatabase & {
  connection: {
    prepare: (...args: readonly unknown[]) => unknown;
  };
} {
  const candidate = database as {
    connection?: {
      prepare?: unknown;
    };
  };

  return typeof candidate.connection?.prepare === "function";
}

function createGlobalMemoryRouteService(params: {
  readonly globalMemoryRepo: GlobalMemoryRepo;
  readonly projectMappingService: ProjectMappingService;
}): GlobalMemoryRouteService {
  return {
    list: async (input) => {
      const entries = await params.globalMemoryRepo.list({
        ...(input.dimension === undefined ? {} : { dimension: input.dimension }),
        ...(input.scope_class === undefined ? {} : { scope_class: input.scope_class })
      });

      return input.limit >= entries.length ? entries : entries.slice(0, input.limit);
    },
    adopt: async (globalObjectId, input) =>
      await adoptGlobalMemoryEntry(
        params.globalMemoryRepo,
        params.projectMappingService,
        globalObjectId,
        input
      )
  };
}

function createGlobalMemoryRecallPort(params: {
  readonly globalMemoryRepo: GlobalMemoryRepo;
}): GlobalMemoryRecallPort {
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
  input: GlobalMemoryAdoptInput
) {
  const entry = await globalMemoryRepo.findByGlobalObjectId(globalObjectId);

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

function createGardenBacklogThresholds(): GardenBacklogThresholds {
  const warningQueueDepth = DEFAULT_SOUL_CONFIG.garden_backlog_soft_limit;

  return {
    warning_queue_depth: warningQueueDepth,
    warning_rearm_depth: Math.max(0, Math.floor(warningQueueDepth * GARDEN_BACKLOG_REARM_RATIO)),
    snapshot_interval_ms: GARDEN_BACKLOG_SNAPSHOT_INTERVAL_MS
  };
}

warnLogger.warn("daemon orphan detection configured", {
  enabled: orphanDetectionEnabled
});
gardenBacklogTelemetryService.start();
backgroundManager.start();

const port = 3000;
const host = resolveDaemonHostFromEnv(process.env);

const server = serve({
  fetch: app.fetch,
  port,
  hostname: host
});
const shutdown = async (): Promise<void> => {
  await backgroundManager.stop({ timeoutMs: null });
  setBacklogTelemetryObserver(null);
  const telemetryStopResult = await gardenBacklogTelemetryService.stop();
  if (telemetryStopResult === "timed_out") {
    warnLogger.warn("garden backlog telemetry shutdown timed out", {});
  }
  securityStatusService.close();
  await daemonMcpRuntimeRegistry.close();
  server.close();
};

process.on("SIGTERM", () => {
  void shutdown();
});
process.on("SIGINT", () => {
  void shutdown();
});

warnLogger.warn("core daemon listening", {
  host,
  port,
  url: `http://${host}:${port}`
});

function readNonEmptyEnv(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function createOptionalMemoryEmbeddingRepo(database: StorageDatabase): MemoryEmbeddingRepo | null {
  const RepoCtor = StorageModule.SqliteMemoryEmbeddingRepo;
  if (typeof RepoCtor !== "function") {
    return null;
  }

  if (!supportsPreparedSqliteConnection(database)) {
    return null;
  }

  return new RepoCtor(database);
}

function supportsPreparedSqliteConnection(database: StorageDatabase): boolean {
  const connection = database.connection as { prepare?: unknown } | undefined;
  return typeof connection?.prepare === "function";
}
