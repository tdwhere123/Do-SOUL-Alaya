import { createApp, type CoreDaemonLifecycleState, type CoreDaemonServices, type RequestProtectionConfig } from "./app.js";

type StartupStepLike = Readonly<{ readonly step: string }>;

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
  workspaceService: unknown;
  engineBindingService: unknown;
  workspaceGitBindingRepo: unknown;
  runService: unknown;
  workerRunRepo: unknown;
  toolExecutionRecordRepo: unknown;
  securityStatusService: unknown;
  embeddingStatusService: unknown;
  conversationService: unknown;
  runHotStateService: unknown;
  eventLogRepo: unknown;
  governanceLeaseService: unknown;
  sessionOverrideService: unknown;
  budgetBankruptcyService: unknown;
  contextLensAssembler: unknown;
  signalService: unknown;
  evidenceService: unknown;
  gardenBacklogTelemetryService: unknown;
  memoryService: unknown;
  greenService: unknown;
  healthJournalService: unknown;
  configService: unknown;
  environmentStatusService: unknown;
  slotService: unknown;
  arbitrationService: unknown;
  recallService: unknown;
  recallUtilizationService: unknown;
  taskSurfaceBuilder: unknown;
  synthesisService: unknown;
  claimService: unknown;
  proposalService: unknown;
  // A1 (HITL daemon backbone) — Inspector loopback HTTP routes call
  // the same MCP handler that attached agents use.
  mcpMemoryToolHandler: unknown;
  fileRepo: unknown;
  runtimeNotifier: unknown;
  topologyAuditService: unknown;
  graphExploreService: unknown;
  topologyService: unknown;
  soulApprovalService: unknown;
  soulGraphService: unknown;
  projectMappingService: unknown;
  globalMemoryService: unknown;
  mcp: unknown;
  warn: unknown;
}>;

export function createCoreDaemonApp(input: CreateCoreDaemonAppInput): ReturnType<typeof createApp> {
  return createApp({
    requestProtection: {
      allowedOrigin: input.requestProtection.allowedOrigin,
      requestToken: input.requestProtection.requestToken,
      allowDesktopOriginlessRequests: !input.remoteDaemonOptInEnabled
    },
    routes: {
      workspaces: {
        workspaceService: input.workspaceService,
        engineBindingService: input.engineBindingService,
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
        mcpMemoryToolHandler: input.mcpMemoryToolHandler
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
        topologyAuditService: input.topologyAuditService,
        graphExploreService: input.graphExploreService,
        topologyService: input.topologyService,
        approvalService: input.soulApprovalService
      },
      soulGraph: {
        workspaceService: input.workspaceService,
        soulGraphService: input.soulGraphService
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
      ...(input.env.ALAYA_ENABLE_E2E_EVENT_TRIGGERS === "1"
        ? {
            e2eEventTriggers: {
              runService: input.runService,
              eventLogRepo: input.eventLogRepo,
              runtimeNotifier: input.runtimeNotifier
            }
          }
        : {})
    },
    principalCodingEngineAvailable: input.principalCodingEngineAvailable,
    listServerHardConstraints: input.listServerHardConstraints
  } as unknown as CoreDaemonServices & {
    readonly principalCodingEngineAvailable: boolean;
    readonly listServerHardConstraints: typeof input.listServerHardConstraints;
  }, input.lifecycleState);
}
