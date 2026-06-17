import {
  createApp,
  type CoreDaemonLifecycleState,
  type CoreDaemonRouteServices,
  type CoreDaemonServices,
  type RequestProtectionConfig
} from "./app.js";

type StartupStepLike = Readonly<{ readonly step: string }>;
type RouteService<K extends keyof CoreDaemonRouteServices> = NonNullable<CoreDaemonRouteServices[K]>;
type RouteField<
  K extends keyof CoreDaemonRouteServices,
  F extends keyof RouteService<K>
> = RouteService<K>[F];
type CoreDaemonAppServices = CoreDaemonServices & {
  readonly principalCodingEngineAvailable: boolean;
  readonly listServerHardConstraints: (workspaceId: string) => Promise<readonly unknown[]>;
};
type E2eEventLogRepo = RouteField<"e2eEventTriggers", "eventLogRepo">;
type E2eEventLogAppendInput = Parameters<E2eEventLogRepo["append"]>[0];
type E2eEventLogAppendResult = Awaited<ReturnType<E2eEventLogRepo["append"]>>;
type E2eEventLogInputPort = {
  append(event: E2eEventLogAppendInput): E2eEventLogAppendResult | Promise<E2eEventLogAppendResult>;
};
type TopologyAuditInputPort = {
  appendPathTopologyExploreCompleted(
    topology: Parameters<NonNullable<RouteField<"soul", "topologyAuditService">>["appendPathTopologyExploreCompleted"]>[0]
  ): unknown | Promise<unknown>;
};

type CreateCoreDaemonAppInput = Readonly<{
  requestProtection: RequestProtectionConfig;
  remoteDaemonOptInEnabled: boolean;
  lifecycleState: CoreDaemonLifecycleState;
  startupSteps: readonly StartupStepLike[];
  principalCodingEngineAvailable: boolean;
  repoRoot: string;
  filesDirectory: string;
  env: NodeJS.ProcessEnv;
  listServerHardConstraints: (workspaceId: string) => Promise<readonly unknown[]>;
  workspaceService: RouteField<"workspaces", "workspaceService"> &
    RouteField<"workspaceFiles", "workspaceService"> &
    RouteField<"securityStatus", "workspaceService"> &
    RouteField<"embeddingStatus", "workspaceService"> &
    RouteField<"memories", "workspaceService"> &
    RouteField<"greenStatus", "workspaceService"> &
    RouteField<"healthJournal", "workspaceService"> &
    RouteField<"config", "workspaceService"> &
    RouteField<"slots", "workspaceService"> &
    RouteField<"recall", "workspaceService"> &
    RouteField<"recallStats", "workspaceService"> &
    RouteField<"syntheses", "workspaceService"> &
    RouteField<"claims", "workspaceService"> &
    RouteField<"proposals", "workspaceService"> &
    RouteField<"healthInbox", "workspaceService"> &
    RouteField<"files", "workspaceService"> &
    RouteField<"soul", "workspaceService"> &
    RouteField<"soulGraph", "workspaceService"> &
    RouteField<"pathGraph", "workspaceService"> &
    RouteField<"soulSearch", "workspaceService"> &
    RouteField<"projectMapping", "workspaceService"> &
    RouteField<"globalMemory", "workspaceService"> &
    RouteField<"conflictMatrix", "workspaceService">;
  engineBindingService: RouteField<"workspaces", "engineBindingService">;
  workspaceGitBindingRepo: RouteField<"workspaces", "workspaceGitBindingRepo">;
  runService: RouteField<"workspaceFiles", "runService"> &
    RouteField<"runs", "runService"> &
    RouteField<"evidence", "runService"> &
    RouteField<"overrides", "runService"> &
    RouteField<"governance", "runService"> &
    RouteField<"budget", "runService"> &
    RouteField<"recall", "runService"> &
    RouteField<"files", "runService"> &
    RouteField<"e2eEventTriggers", "runService">;
  workerRunRepo: RouteField<"workspaceFiles", "workerRunRepo">;
  toolExecutionRecordRepo: RouteField<"workspaceFiles", "toolExecutionRecordRepo">;
  securityStatusService: RouteField<"securityStatus", "securityStatusService">;
  embeddingStatusService: RouteField<"embeddingStatus", "embeddingStatusService">;
  conversationService: RouteField<"runs", "conversationService">;
  runHotStateService: RouteField<"runs", "runHotStateService">;
  eventLogRepo: RouteField<"runs", "eventLogRepo"> &
    RouteField<"recallUtilization", "eventLogRepo"> &
    E2eEventLogInputPort;
  governanceLeaseService: RouteField<"runs", "governanceLeaseService"> &
    RouteField<"governance", "governanceLeaseService">;
  sessionOverrideService: RouteField<"runs", "sessionOverrideService"> &
    RouteField<"overrides", "sessionOverrideService"> &
    RouteField<"governance", "sessionOverrideService">;
  budgetBankruptcyService: RouteField<"runs", "budgetBankruptcyService"> &
    RouteField<"budget", "budgetBankruptcyService">;
  contextLensAssembler: RouteField<"runs", "contextLensAssembler">;
  signalService: RouteField<"signals", "signalService">;
  evidenceService: RouteField<"evidence", "evidenceService">;
  gardenBacklogTelemetryService: RouteService<"gardenBacklog">["gardenBacklogTelemetryService"];
  memoryService: RouteField<"memories", "memoryService"> &
    RouteField<"proposals", "memoryService">;
  greenService: RouteField<"greenStatus", "greenService"> &
    RouteField<"governance", "greenService">;
  healthJournalService: RouteField<"healthJournal", "healthJournalService">;
  configService: RouteField<"config", "configService">;
  environmentStatusService: RouteField<"config", "environmentStatusService">;
  slotService: RouteField<"slots", "slotService">;
  arbitrationService: RouteField<"slots", "arbitrationService"> &
    RouteField<"conflictMatrix", "arbitrationService">;
  recallService: RouteField<"recall", "recallService">;
  recallUtilizationService: RouteField<"recallStats", "recallUtilizationService">;
  singleUsedAnchorEmitter?: RouteField<"recallUtilization", "singleUsedAnchorEmitter">;
  deliveryAnchorReader?: RouteField<"recallUtilization", "deliveryAnchorReader">;
  taskSurfaceBuilder: RouteField<"recall", "taskSurfaceBuilder">;
  synthesisService: RouteField<"syntheses", "synthesisService">;
  claimService: RouteField<"claims", "claimService">;
  proposalService: RouteField<"proposals", "proposalService">;
  proposalRepo: RouteField<"proposals", "proposalRepo">;
  healthIssueGroupRepo: RouteField<"healthInbox", "healthIssueGroupRepo">;
  // A1 (HITL daemon backbone) — Inspector loopback HTTP routes call
  // the same MCP handler that attached agents use.
  mcpMemoryToolHandler: RouteField<"proposals", "mcpMemoryToolHandler"> &
    RouteField<"soulSearch", "mcpMemoryToolHandler">;
  fileRepo: RouteField<"files", "fileRepo">;
  runtimeNotifier: RouteField<"proposals", "runtimeNotifier"> &
    RouteField<"files", "runtimeNotifier"> &
    RouteField<"e2eEventTriggers", "runtimeNotifier">;
  topologyAuditService?: TopologyAuditInputPort;
  graphExploreService: RouteField<"soul", "graphExploreService">;
  topologyService: RouteField<"soul", "topologyService">;
  soulApprovalService: RouteField<"soul", "approvalService">;
  soulGraphService: RouteField<"soulGraph", "soulGraphService">;
  graphContractService: RouteField<"pathGraph", "graphContractService">;
  projectMappingService: RouteField<"projectMapping", "projectMappingService">;
  globalMemoryService?: RouteField<"globalMemory", "globalMemoryService">;
  mcp: RouteField<"status", "mcp">;
  warn: RouteField<"runs", "warn">;
}>;

export function createCoreDaemonApp(input: CreateCoreDaemonAppInput): ReturnType<typeof createApp> {
  const services = {
    requestProtection: {
      allowedOrigin: input.requestProtection.allowedOrigin,
      requestToken: input.requestProtection.requestToken,
      allowDesktopOriginlessRequests: !input.remoteDaemonOptInEnabled
    },
    routes: {
      workspaces: {
        workspaceService: input.workspaceService,
        engineBindingService: input.engineBindingService,
        codingEngineAvailable: input.principalCodingEngineAvailable,
        workspaceGitBindingRepo: input.workspaceGitBindingRepo
      },
      workspaceFiles: {
        workspaceService: input.workspaceService,
        runService: input.runService,
        workerRunRepo: input.workerRunRepo,
        toolExecutionRecordRepo: input.toolExecutionRecordRepo,
        gitBindingValidation: {
          currentWorkingDirectory: input.repoRoot
        }
      },
      securityStatus: {
        workspaceService: input.workspaceService,
        securityStatusService: input.securityStatusService
      },
      embeddingStatus: {
        workspaceService: input.workspaceService,
        embeddingStatusService: input.embeddingStatusService
      },
      runs: {
        runService: input.runService,
        conversationService: input.conversationService,
        runHotStateService: input.runHotStateService,
        eventLogRepo: input.eventLogRepo,
        governanceLeaseService: input.governanceLeaseService,
        sessionOverrideService: input.sessionOverrideService,
        budgetBankruptcyService: input.budgetBankruptcyService,
        contextLensAssembler: input.contextLensAssembler,
        warn: input.warn
      },
      signals: {
        runService: input.runService,
        signalService: input.signalService
      },
      evidence: {
        workspaceService: input.workspaceService,
        runService: input.runService,
        evidenceService: input.evidenceService
      },
      gardenBacklog: {
        gardenBacklogTelemetryService: input.gardenBacklogTelemetryService
      },
      memories: {
        workspaceService: input.workspaceService,
        runService: input.runService,
        memoryService: input.memoryService
      },
      greenStatus: {
        workspaceService: input.workspaceService,
        greenService: input.greenService
      },
      healthJournal: {
        workspaceService: input.workspaceService,
        healthJournalService: input.healthJournalService
      },
      config: {
        workspaceService: input.workspaceService,
        configService: input.configService,
        environmentStatusService: input.environmentStatusService
      },
      overrides: {
        sessionOverrideService: input.sessionOverrideService,
        runService: input.runService
      },
      governance: {
        greenService: input.greenService,
        sessionOverrideService: input.sessionOverrideService,
        governanceLeaseService: input.governanceLeaseService,
        runService: input.runService
      },
      budget: {
        budgetBankruptcyService: input.budgetBankruptcyService,
        runService: input.runService
      },
      slots: {
        workspaceService: input.workspaceService,
        slotService: input.slotService,
        arbitrationService: input.arbitrationService
      },
      recall: {
        recallService: input.recallService,
        taskSurfaceBuilder: input.taskSurfaceBuilder,
        runService: input.runService,
        workspaceService: input.workspaceService
      },
      recallStats: {
        workspaceService: input.workspaceService,
        recallUtilizationService: input.recallUtilizationService
      },
      recallUtilization: {
        workspaceService: input.workspaceService,
        eventLogRepo: input.eventLogRepo,
        ...(input.singleUsedAnchorEmitter === undefined
          ? {}
          : { singleUsedAnchorEmitter: input.singleUsedAnchorEmitter }),
        ...(input.deliveryAnchorReader === undefined
          ? {}
          : { deliveryAnchorReader: input.deliveryAnchorReader })
      },
      syntheses: {
        workspaceService: input.workspaceService,
        synthesisService: input.synthesisService
      },
      claims: {
        workspaceService: input.workspaceService,
        claimService: input.claimService
      },
      proposals: {
        workspaceService: input.workspaceService,
        memoryService: input.memoryService,
        proposalService: input.proposalService,
        proposalRepo: input.proposalRepo,
        runtimeNotifier: input.runtimeNotifier,
        mcpMemoryToolHandler: input.mcpMemoryToolHandler
      },
      healthInbox: {
        workspaceService: input.workspaceService,
        healthIssueGroupRepo: input.healthIssueGroupRepo
      },
      files: {
        workspaceService: input.workspaceService,
        runService: input.runService,
        fileRepo: input.fileRepo,
        runtimeNotifier: input.runtimeNotifier,
        filesDirectory: input.filesDirectory
      },
      soul: {
        workspaceService: input.workspaceService,
        ...(input.topologyAuditService === undefined
          ? {}
          : { topologyAuditService: createTopologyAuditPort(input.topologyAuditService) }),
        graphExploreService: input.graphExploreService,
        topologyService: input.topologyService,
        approvalService: input.soulApprovalService
      },
      soulGraph: {
        workspaceService: input.workspaceService,
        soulGraphService: input.soulGraphService
      },
      pathGraph: {
        workspaceService: input.workspaceService,
        graphContractService: input.graphContractService
      },
      soulSearch: {
        workspaceService: input.workspaceService,
        mcpMemoryToolHandler: input.mcpMemoryToolHandler
      },
      status: {
        startupStepsProvider: () => input.startupSteps.map((step) => step.step),
        principalCodingEngineAvailableProvider: () => input.principalCodingEngineAvailable,
        mcp: input.mcp
      },
      projectMapping: {
        workspaceService: input.workspaceService,
        projectMappingService: input.projectMappingService
      },
      ...(input.globalMemoryService === undefined
        ? {}
        : {
            globalMemory: {
              workspaceService: input.workspaceService,
              globalMemoryService: input.globalMemoryService
            }
          }),
      conflictMatrix: {
        workspaceService: input.workspaceService,
        arbitrationService: input.arbitrationService
      },
      ...(shouldEnableE2eEventTriggers(input.env)
        ? {
            e2eEventTriggers: {
              runService: input.runService,
              eventLogRepo: createE2eEventLogRepo(input.eventLogRepo),
              runtimeNotifier: input.runtimeNotifier
            }
          }
        : {})
    },
    principalCodingEngineAvailable: input.principalCodingEngineAvailable,
    listServerHardConstraints: input.listServerHardConstraints
  } satisfies CoreDaemonAppServices;

  return createApp(services, input.lifecycleState);
}

export function shouldEnableE2eEventTriggers(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV !== "production" && env.ALAYA_ENABLE_E2E_EVENT_TRIGGERS === "1";
}

function createE2eEventLogRepo(eventLogRepo: E2eEventLogInputPort): E2eEventLogRepo {
  return {
    append: async (event) => await eventLogRepo.append(event)
  };
}

function createTopologyAuditPort(
  topologyAuditService: TopologyAuditInputPort
): NonNullable<RouteField<"soul", "topologyAuditService">> {
  return {
    appendPathTopologyExploreCompleted: async (topology) => {
      await topologyAuditService.appendPathTopologyExploreCompleted(topology);
    }
  };
}
