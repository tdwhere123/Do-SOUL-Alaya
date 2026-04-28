import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { timingSafeEqual } from "node:crypto";
import type {
  ContextLens,
  EmbeddingStatus,
  EventLogEntry,
  GardenBacklogSnapshot,
  GraphExploreDir,
  GraphNeighbor,
  KarmaEvent,
  NarrativeBudgetConfig,
  MemoryGraphEdgeTypeValue,
  SecurityStatusContract,
  SoulGraph,
  TopologyExplorationResult
} from "@do-what/protocol";
import type { FileRepo, SurfaceAnchorRepo, ToolExecutionRecordRepo } from "@do-what/storage";
import type {
  ArbitrationService,
  BudgetBankruptcyService,
  ClaimService,
  ConversationService,
  CrossCuttingPermissionService,
  EngineBindingService,
  EvidenceService,
  GreenService,
  HealthJournalService,
  GovernanceLeaseService,
  MemoryService,
  SessionOverrideService,
  SerialDelegationService,
  NarrativeBudgetService,
  WorkerTrustAssessor,
  ProposalService,
  ProjectMappingService,
  RecallService,
  RunHotStateService,
  RunService,
  SignalService,
  SlotService,
  SurfaceBindingService,
  SurfaceService,
  SynthesisService,
  TaskSurfaceBuilder,
  WorkspaceService
} from "@do-what/core";
import type { SseManager } from "./sse/sse-manager.js";
import { registerErrorHandler } from "./middleware/error-handler.js";
import { registerClaimRoutes } from "./routes/claims.js";
import { registerConfigRoutes } from "./routes/config.js";
import { registerConflictMatrixRoutes } from "./routes/conflict-matrix.js";
import { registerBudgetRoutes } from "./routes/budget.js";
import { registerEvidenceRoutes } from "./routes/evidence.js";
import { registerEmbeddingStatusRoutes } from "./routes/embedding-status.js";
import { registerE2eEventTriggerRoutes } from "./routes/e2e-event-triggers.js";
import { MAX_FILE_SIZE_BYTES, registerFileRoutes } from "./routes/files.js";
import { registerGardenBacklogRoutes } from "./routes/garden-backlog.js";
import {
  registerGlobalMemoryRoutes,
  type GlobalMemoryRouteService
} from "./routes/global-memory.js";
import { registerGovernanceRoutes } from "./routes/governance.js";
import { registerGreenStatusRoutes } from "./routes/green-status.js";
import { registerHealthJournalRoutes } from "./routes/health-journal.js";
import { registerMemoryRoutes } from "./routes/memories.js";
import { registerOverrideRoutes } from "./routes/overrides.js";
import { registerProjectMappingRoutes } from "./routes/project-mapping.js";
import { registerProposalRoutes } from "./routes/proposals.js";
import { registerRecallRoutes } from "./routes/recall.js";
import { registerRunRoutes } from "./routes/runs.js";
import { registerSecurityStatusRoutes } from "./routes/security-status.js";
import { registerSignalRoutes } from "./routes/signals.js";
import {
  registerSlashCommandRoutes,
  type SlashCommandRouteService
} from "./routes/slash-commands.js";
import { registerSlotRoutes } from "./routes/slots.js";
import { registerSoulRoutes } from "./routes/soul.js";
import { registerSoulGraphRoutes } from "./routes/soul-graph.js";
import { registerSurfaceBindingRoutes } from "./routes/surface-bindings.js";
import { registerSurfaceRoutes } from "./routes/surfaces.js";
import { registerSynthesisRoutes } from "./routes/syntheses.js";
import { registerWorkspaceFileRoutes } from "./routes/workspace-files.js";
import {
  registerWorkerDispatchRoutes,
  type WorkerDispatchPromptAssemblerPort
} from "./routes/worker-dispatch.js";
import {
  registerWorkspaceRoutes,
  type WorkspaceGitBindingRepo
} from "./routes/workspaces.js";
import type { AppConfigService } from "./services/config-service.js";
import type { EnvironmentStatusService } from "./services/environment-status-service.js";
import type { GitBindingValidationOptions } from "./git-binding/validator.js";
import { SoulTopologyAuditService } from "./services/soul-topology-audit-service.js";

interface ContextLensPreviewPort {
  getLastLens(runId: string): Readonly<ContextLens> | null;
  clearLens(runId: string): void;
}

interface KarmaEventPreviewPort {
  findByWorkspaceId(workspaceId: string): Promise<readonly Readonly<KarmaEvent>[]>;
}

interface GardenBacklogRouteService {
  getSnapshot(): GardenBacklogSnapshot;
}

export interface RequestProtectionConfig {
  readonly allowedOrigin: string;
  readonly requestToken: string;
  readonly allowDesktopOriginlessRequests?: boolean;
}

export interface CoreDaemonServices {
  readonly workspaceService: WorkspaceService;
  readonly workspaceGitBindingRepo?: WorkspaceGitBindingRepo;
  readonly toolExecutionRecordRepo?: Pick<ToolExecutionRecordRepo, "listByRunId">;
  readonly workerRunRepo?: {
    getById(id: string): Promise<{
      readonly worker_run_id: string;
      readonly workspace_id: string;
    } | null>;
  };
  readonly gitBindingValidation?: GitBindingValidationOptions;
  readonly securityStatusService?: {
    getStatus(workspaceId: string): Promise<SecurityStatusContract>;
  };
  readonly embeddingStatusService?: {
    getStatus(workspaceId: string): Promise<EmbeddingStatus>;
  };
  readonly runService: RunService;
  readonly conversationService: ConversationService;
  readonly principalCodingEngineAvailable?: boolean;
  readonly engineBindingService: EngineBindingService;
  readonly runHotStateService: RunHotStateService;
  readonly eventLogRepo?: {
    append?(
      event: Omit<EventLogEntry, "event_id" | "created_at" | "revision"> & {
        readonly revision?: number;
      }
    ): Promise<EventLogEntry>;
    queryByRun(runId: string): Promise<readonly EventLogEntry[]>;
    queryByRunAfterEventId?(runId: string, lastEventId: string): Promise<readonly EventLogEntry[]>;
  };
  readonly sseManager: SseManager;
  readonly signalService: SignalService;
  readonly evidenceService: EvidenceService;
  readonly memoryService: MemoryService;
  readonly gardenBacklogTelemetryService?: GardenBacklogRouteService;
  readonly healthJournalService?: HealthJournalService;
  readonly greenService?: GreenService;
  readonly budgetNow?: () => string;
  readonly budgetBankruptcyService?: BudgetBankruptcyService;
  readonly governanceNow?: () => string;
  readonly governanceLeaseService?: GovernanceLeaseService;
  readonly sessionOverrideService?: SessionOverrideService;
  readonly serialDelegationService?: Pick<SerialDelegationService, "dispatch">;
  readonly slashCommandService?: SlashCommandRouteService;
  readonly workerDispatchPromptAssembler?: WorkerDispatchPromptAssemblerPort;
  readonly workerTrustAssessor?: {
    assess: Pick<WorkerTrustAssessor, "assess">["assess"];
  };
  readonly narrativeBudgetService?: Pick<NarrativeBudgetService, "checkBudget" | "triggerConsolidation">;
  readonly narrativeBudgetConfig?: NarrativeBudgetConfig;
  readonly listServerHardConstraints?: (
    workspaceId: string
  ) => Promise<
    readonly {
      readonly ref: string;
      readonly resolved_ref?: string;
      readonly content: string;
    }[]
  >;
  readonly warn?: (message: string, meta: Record<string, unknown>) => void;
  readonly slotService: SlotService;
  readonly surfaceService?: SurfaceService;
  readonly surfaceBindingService?: SurfaceBindingService;
  readonly crossCuttingPermissionService?: CrossCuttingPermissionService;
  readonly synthesisService: SynthesisService;
  readonly claimService: ClaimService;
  readonly proposalService: ProposalService;
  readonly configService?: AppConfigService;
  readonly environmentStatusService?: EnvironmentStatusService;
  readonly fileRepo?: FileRepo;
  readonly surfaceAnchorRepo?: SurfaceAnchorRepo;
  readonly filesDirectory?: string;
  readonly arbitrationService?: ArbitrationService;
  readonly graphExploreService?: {
    exploreOneHop(
      memoryId: string,
      workspaceId: string,
      options?: {
        edgeTypes?: readonly MemoryGraphEdgeTypeValue[];
        direction?: GraphExploreDir;
      }
    ): Promise<readonly GraphNeighbor[]>;
  };
  readonly topologyService?: {
    explore(workspaceId: string): Promise<Readonly<TopologyExplorationResult>>;
  };
  readonly soulGraphService?: {
    buildSoulGraph(input: {
      readonly workspaceId: string;
      readonly depth: number;
      readonly limit: number;
    }): Promise<Readonly<SoulGraph>>;
  };
  readonly soulApprovalService?: {
    approve(input: {
      readonly approvalId: string;
      readonly runId: string;
      readonly causedBy: string;
    }): Promise<{
      readonly approval_id: string;
      readonly result: "approved" | "rejected";
      readonly resolved_at: string;
    }>;
    reject(input: {
      readonly approvalId: string;
      readonly runId: string;
      readonly causedBy: string;
    }): Promise<{
      readonly approval_id: string;
      readonly result: "approved" | "rejected";
      readonly resolved_at: string;
    }>;
  };
  readonly recallService?: RecallService;
  readonly projectMappingService?: ProjectMappingService;
  readonly globalMemoryService?: GlobalMemoryRouteService;
  readonly taskSurfaceBuilder?: TaskSurfaceBuilder;
  readonly contextLensAssembler?: ContextLensPreviewPort;
  readonly karmaEventPreview?: KarmaEventPreviewPort;
  readonly requestProtection?: RequestProtectionConfig;
  readonly enableE2eEventTriggers?: boolean;
}

export function createApp(services: CoreDaemonServices): Hono {
  const app = new Hono();
  const allowedOrigin = services.requestProtection?.allowedOrigin ?? process.env.ALLOWED_ORIGIN ?? "http://localhost:5173";
  const allowDesktopOriginlessRequests = services.requestProtection?.allowDesktopOriginlessRequests ?? true;
  const fileUploadBodyLimit = bodyLimit({
    maxSize: MAX_FILE_SIZE_BYTES,
    onError: (context) =>
      context.json(
        {
          success: false,
          error: "File exceeds the 20 MB limit"
        },
        413
      )
  });

  app.use(
    "*",
    cors({
      origin: (origin, context) => {
        const normalizedOrigin = normalizeOrigin(origin);

        if (normalizedOrigin === allowedOrigin) {
          return allowedOrigin;
        }

        return "";
      },
      allowHeaders: ["Content-Type", "X-Request-Token", "X-Do-What-Desktop"]
    })
  );
  if (services.requestProtection !== undefined) {
    const { requestToken } = services.requestProtection;

    app.use("*", async (context, next) => {
      if (!isProtectedRequest(context.req.method, context.req.path, context.req.query("run_id"))) {
        await next();
        return;
      }

      const origin = normalizeOrigin(context.req.header("origin"));
      const localOperatorRequest = isLocalOperatorRequest(context.req.header("x-do-what-desktop"));

      if (!isAllowedMutatingOrigin(origin, allowedOrigin, localOperatorRequest, allowDesktopOriginlessRequests)) {
        return context.json(
          {
            success: false,
            error: "Origin is not allowed"
          },
          403
        );
      }

      const providedRequestToken = context.req.header("x-request-token")?.trim();

      if (providedRequestToken === undefined || providedRequestToken.length === 0) {
        return context.json(
          {
            success: false,
            error: "X-Request-Token is required"
          },
          403
        );
      }

      if (!matchesRequestToken(providedRequestToken, requestToken)) {
        return context.json(
          {
            success: false,
            error: "Invalid X-Request-Token"
          },
          403
        );
      }

      await next();
    });

    app.get("/session/request-token", (context) => {
      const origin = normalizeOrigin(context.req.header("origin"));
      const localOperatorRequest = isLocalOperatorRequest(context.req.header("x-do-what-desktop"));

      if (!isAllowedRequestTokenOrigin(origin, allowedOrigin, localOperatorRequest, allowDesktopOriginlessRequests)) {
        return context.json(
          {
            success: false,
            error: "Origin is not allowed"
          },
          403
        );
      }

      return context.json(
        {
          success: true,
          data: {
            request_token: requestToken
          }
        },
        200
      );
    });
  }

  app.use("/files", async (context, next) => {
    if (context.req.method !== "POST") {
      await next();
      return;
    }

    await fileUploadBodyLimit(context, next);
  });

  registerErrorHandler(app);
  const codingEngineAvailableForPrincipalRuns =
    services.principalCodingEngineAvailable ?? false;
  registerWorkspaceRoutes(app, {
    workspaceService: services.workspaceService,
    engineBindingService: services.engineBindingService,
    sseManager: services.sseManager,
    codingEngineAvailable: codingEngineAvailableForPrincipalRuns,
    workspaceGitBindingRepo: services.workspaceGitBindingRepo,
    gitBindingValidation: services.gitBindingValidation
  });
  registerWorkspaceFileRoutes(app, {
    workspaceService: services.workspaceService,
    runService: services.runService,
    workerRunRepo: services.workerRunRepo,
    toolExecutionRecordRepo: services.toolExecutionRecordRepo,
    gitBindingValidation: services.gitBindingValidation
  });
  if (services.securityStatusService !== undefined) {
    registerSecurityStatusRoutes(app, {
      workspaceService: services.workspaceService,
      securityStatusService: services.securityStatusService
    });
  }
  if (services.embeddingStatusService !== undefined) {
    registerEmbeddingStatusRoutes(app, {
      workspaceService: services.workspaceService,
      embeddingStatusService: services.embeddingStatusService
    });
  }
  registerRunRoutes(app, {
    runService: services.runService,
    conversationService: services.conversationService,
    runHotStateService: services.runHotStateService,
    eventLogRepo: services.eventLogRepo,
    sseManager: services.sseManager,
    governanceLeaseService: services.governanceLeaseService,
    sessionOverrideService: services.sessionOverrideService,
    contextLensAssembler: services.contextLensAssembler,
    budgetBankruptcyService: services.budgetBankruptcyService,
    warn: services.warn
  });
  registerSlashCommandRoutes(app, services.slashCommandService);
  if (services.serialDelegationService !== undefined) {
    registerWorkerDispatchRoutes(app, {
      runService: services.runService,
      serialDelegationService: services.serialDelegationService,
      governanceLeaseService: services.governanceLeaseService,
      workerDispatchPromptAssembler: services.workerDispatchPromptAssembler,
      workerTrustAssessor: services.workerTrustAssessor,
      narrativeBudgetService: services.narrativeBudgetService,
      narrativeBudgetConfig: services.narrativeBudgetConfig,
      listServerHardConstraints: services.listServerHardConstraints,
      warn: services.warn
    });
  }
  registerSignalRoutes(app, {
    runService: services.runService,
    signalService: services.signalService
  });
  registerEvidenceRoutes(app, {
    workspaceService: services.workspaceService,
    runService: services.runService,
    evidenceService: services.evidenceService
  });
  if (services.gardenBacklogTelemetryService !== undefined) {
    registerGardenBacklogRoutes(app, {
      gardenBacklogTelemetryService: services.gardenBacklogTelemetryService
    });
  }
  registerMemoryRoutes(app, {
    workspaceService: services.workspaceService,
    runService: services.runService,
    memoryService: services.memoryService
  });

  if (services.greenService !== undefined) {
    registerGreenStatusRoutes(app, {
      workspaceService: services.workspaceService,
      greenService: services.greenService
    });
  }

  if (services.healthJournalService !== undefined) {
    registerHealthJournalRoutes(app, {
      workspaceService: services.workspaceService,
      healthJournalService: services.healthJournalService
    });
  }

  if (services.configService !== undefined || services.environmentStatusService !== undefined) {
    registerConfigRoutes(app, {
      workspaceService: services.workspaceService,
      configService: services.configService,
      environmentStatusService: services.environmentStatusService
    });
  }

  if (services.sessionOverrideService !== undefined) {
    registerOverrideRoutes(app, {
      runService: services.runService,
      sessionOverrideService: services.sessionOverrideService
    });
  }

  if (
    services.greenService !== undefined &&
    services.sessionOverrideService !== undefined &&
    services.governanceLeaseService !== undefined
  ) {
    registerGovernanceRoutes(app, {
      runService: services.runService,
      greenService: services.greenService,
      sessionOverrideService: services.sessionOverrideService,
      governanceLeaseService: services.governanceLeaseService,
      now: services.governanceNow
    });
  }

  if (services.budgetBankruptcyService !== undefined) {
    registerBudgetRoutes(app, {
      runService: services.runService,
      budgetBankruptcyService: services.budgetBankruptcyService,
      now: services.budgetNow
    });
  }

  registerSlotRoutes(app, {
    workspaceService: services.workspaceService,
    slotService: services.slotService,
    arbitrationService: services.arbitrationService
  });

  if (services.recallService !== undefined && services.taskSurfaceBuilder !== undefined) {
    registerRecallRoutes(app, {
      recallService: services.recallService,
      taskSurfaceBuilder: services.taskSurfaceBuilder,
      runService: services.runService,
      workspaceService: services.workspaceService
    });
  }

  if (services.surfaceService !== undefined) {
    registerSurfaceRoutes(app, {
      workspaceService: services.workspaceService,
      surfaceService: services.surfaceService
    });
  }

  if (
    services.surfaceService !== undefined &&
    services.surfaceBindingService !== undefined &&
    services.crossCuttingPermissionService !== undefined
  ) {
    if (services.surfaceAnchorRepo === undefined) {
      throw new Error("surfaceAnchorRepo is required when surface binding routes are registered");
    }

    registerSurfaceBindingRoutes(app, {
      workspaceService: services.workspaceService,
      surfaceService: services.surfaceService,
      surfaceAnchorRepo: services.surfaceAnchorRepo,
      surfaceBindingService: services.surfaceBindingService,
      crossCuttingPermissionService: services.crossCuttingPermissionService
    });
  }

  registerSynthesisRoutes(app, {
    workspaceService: services.workspaceService,
    synthesisService: services.synthesisService
  });
  registerClaimRoutes(app, {
    workspaceService: services.workspaceService,
    claimService: services.claimService
  });
  registerProposalRoutes(app, {
    workspaceService: services.workspaceService,
    proposalService: services.proposalService
  });

  if (services.fileRepo !== undefined && services.filesDirectory !== undefined) {
    registerFileRoutes(app, {
      workspaceService: services.workspaceService,
      runService: services.runService,
      fileRepo: services.fileRepo,
      sseManager: services.sseManager,
      filesDirectory: services.filesDirectory
    });
  }

  if (
    services.graphExploreService !== undefined ||
    services.topologyService !== undefined ||
    services.soulApprovalService !== undefined
  ) {
    registerSoulRoutes(app, {
      workspaceService: services.workspaceService,
      topologyAuditService: resolveTopologyAuditService(services),
      graphExploreService: services.graphExploreService,
      topologyService: services.topologyService,
      approvalService: services.soulApprovalService
    });
  }

  if (services.soulGraphService !== undefined) {
    registerSoulGraphRoutes(app, {
      workspaceService: services.workspaceService,
      soulGraphService: services.soulGraphService
    });
  }

  if (services.projectMappingService !== undefined) {
    registerProjectMappingRoutes(app, {
      workspaceService: services.workspaceService,
      projectMappingService: services.projectMappingService
    });
  }

  if (services.globalMemoryService !== undefined) {
    registerGlobalMemoryRoutes(app, {
      workspaceService: services.workspaceService,
      globalMemoryService: services.globalMemoryService
    });
  }

  if (services.arbitrationService !== undefined) {
    registerConflictMatrixRoutes(app, {
      workspaceService: services.workspaceService,
      arbitrationService: services.arbitrationService
    });
  }

  if (services.contextLensAssembler !== undefined) {
    const contextLensAssembler = services.contextLensAssembler;

    app.get("/runs/:runId/context-lens", async (context) => {
      const runId = context.req.param("runId");
      await services.runService.getById(runId);
      const lens = contextLensAssembler.getLastLens(runId);
      return context.json({ success: true, data: lens }, 200);
    });
  }

  if (services.karmaEventPreview !== undefined) {
    const karmaEventPreview = services.karmaEventPreview;

    app.get("/workspaces/:wsId/karma-events", async (context) => {
      const workspaceId = context.req.param("wsId");
      await services.workspaceService.getById(workspaceId);
      const events = await karmaEventPreview.findByWorkspaceId(workspaceId);
      return context.json({ success: true, data: events }, 200);
    });
  }

  if (services.enableE2eEventTriggers === true) {
    if (services.requestProtection === undefined) {
      throw new Error("E2E event trigger routes require request protection.");
    }
    if (services.eventLogRepo?.append === undefined) {
      throw new Error("E2E event trigger routes require eventLogRepo.append.");
    }

    registerE2eEventTriggerRoutes(app, {
      runService: services.runService,
      eventLogRepo: {
        append: services.eventLogRepo.append.bind(services.eventLogRepo)
      },
      sseManager: services.sseManager
    });
  }

  return app;
}

function resolveTopologyAuditService(
  services: CoreDaemonServices
):
  | {
      appendPathTopologyExploreCompleted(
        topology: Readonly<TopologyExplorationResult>
      ): Promise<EventLogEntry>;
    }
  | undefined {
  if (services.topologyService === undefined) {
    return undefined;
  }

  if (services.eventLogRepo?.append === undefined) {
    throw new Error("TopologyService requires topology audit logging.");
  }

  return new SoulTopologyAuditService({
    eventLogRepo: {
      append: services.eventLogRepo.append.bind(services.eventLogRepo)
    }
  });
}

function isProtectedRequest(method: string, path: string, runIdQuery: string | undefined): boolean {
  return isMutatingMethod(method) || isAuditProtectedGet(method, path) || isSlashDiscoveryProtectedGet(method, path, runIdQuery);
}

function isMutatingMethod(method: string): boolean {
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}

function isAuditProtectedGet(method: string, path: string): boolean {
  if (method !== "GET") {
    return false;
  }

  return (
    /^\/soul\/workspaces\/[^/]+\/topology$/.test(path) ||
    /^\/runs\/[^/]+\/recall-candidates$/.test(path)
  );
}

function isSlashDiscoveryProtectedGet(method: string, path: string, runIdQuery: string | undefined): boolean {
  return method === "GET" && path === "/slash-commands" && runIdQuery !== undefined && runIdQuery.trim().length > 0;
}

function normalizeOrigin(origin: string | undefined): string | undefined {
  const normalized = origin?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

function isLocalOperatorRequest(header: string | undefined): boolean {
  return header?.trim() === "1";
}

function isAllowedProtectedRequest(
  origin: string | undefined,
  allowedOrigin: string,
  localOperatorRequest: boolean,
  allowDesktopOriginlessRequests: boolean
): boolean {
  if (origin === allowedOrigin) {
    return true;
  }

  if (!allowDesktopOriginlessRequests) {
    return false;
  }

  return origin === undefined && localOperatorRequest;
}

function isAllowedMutatingOrigin(
  origin: string | undefined,
  allowedOrigin: string,
  localOperatorRequest: boolean,
  allowDesktopOriginlessRequests: boolean
): boolean {
  return isAllowedProtectedRequest(origin, allowedOrigin, localOperatorRequest, allowDesktopOriginlessRequests);
}

function isAllowedRequestTokenOrigin(
  origin: string | undefined,
  allowedOrigin: string,
  localOperatorRequest: boolean,
  allowDesktopOriginlessRequests: boolean
): boolean {
  // Separate hook so request-token reads can diverge from mutating-route policy
  // without changing the route call sites.
  return isAllowedProtectedRequest(origin, allowedOrigin, localOperatorRequest, allowDesktopOriginlessRequests);
}

function matchesRequestToken(provided: string, expected: string): boolean {
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);

  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(providedBuffer, expectedBuffer);
}
