import { GardenTaskKind, HealthEventKind } from "@do-soul/alaya-protocol";
import { GARDEN_COMPILE_ENQUEUE_HEALTH_PHASE } from "@do-soul/alaya-core";
import { createAttachSurfaceRegistrar } from "../../../attach/surface-registrar.js";
import { getBuiltinConversationToolSpecs } from "../../../mcp/server/builtin-conversation-tool-specs.js";
import { createDaemonMcpMemoryToolHandler } from "../../../mcp-memory/tool/daemon-handler.js";
import { bootstrapDaemonMcpTooling } from "../../../mcp/server/daemon-mcp-tooling.js";
import { createCoreDaemonApp } from "../wiring/daemon-app-composition.js";
import {
  createCoreDaemonLifecycleState,
  createDaemonLifecycleControls
} from "./daemon-runtime-lifecycle.js";
import type {
  AlayaDaemonRuntime,
  AlayaDaemonRuntimeServices,
  DaemonStartupStepRecord
} from "./daemon-runtime-types.js";
import { RECENT_GARDEN_COMPILE_TURN_LIMIT } from "./daemon-runtime-types.js";
import type { RequestProtectionConfig } from "../../app.js";
import type { AlayaRuntimeNotifier } from "../support/runtime-notifier.js";

type McpTooling = Awaited<ReturnType<typeof bootstrapDaemonMcpTooling>>;

type GardenCompileSnapshotExports = Readonly<{
  readonly initialGardenLastPassAt: string | null;
  readonly gardenRuntime: Readonly<{
    getStatus(): Readonly<{ readonly last_pass_at: string | null }>;
  }>;
  readonly gardenTaskRepo:
    | Readonly<{
        countByKind(
          taskKind: string,
          staleBefore: string,
          workspaceId?: string,
          recentFailedLimit?: number
        ): Readonly<{ readonly pending: number; readonly stale: number; readonly failed: number }>;
      }>
    | undefined;
  readonly healthJournalService?: Readonly<{
    getRecentEvents(
      workspaceId: string,
      params?: { readonly kind?: string; readonly limit?: number }
    ): Promise<readonly { readonly event_kind: string; readonly detail_json: Record<string, unknown> }[]>;
  }>;
}>;

type DaemonRuntimeServiceExports = Omit<
  AlayaDaemonRuntimeServices,
  "conversationToolCatalog" | "daemonMcpCatalog" | "mcpMemoryToolHandler" | "gardenStatus"
> & GardenCompileSnapshotExports;

export async function finalizeAlayaDaemonRuntime(input: {
  readonly requestProtection: RequestProtectionConfig;
  readonly runtimeNotifier: AlayaRuntimeNotifier;
  readonly startupSteps: DaemonStartupStepRecord[];
  readonly bootstrapMcpToolingInput: Parameters<typeof bootstrapDaemonMcpTooling>[0];
  readonly attachSurfaceRegistrarInput: Parameters<typeof createAttachSurfaceRegistrar>[0];
  readonly mcpMemoryToolHandlerInput: Omit<
    Parameters<typeof createDaemonMcpMemoryToolHandler>[0],
    "attachSurfaceRegistrar"
  >;
  readonly appInput: Omit<
    Parameters<typeof createCoreDaemonApp>[0],
    "lifecycleState" | "startupSteps" | "mcpMemoryToolHandler" | "mcp"
  >;
  readonly lifecycleControlsInput: Omit<
    Parameters<typeof createDaemonLifecycleControls>[0],
    "app" | "lifecycleState" | "daemonMcpRuntimeRegistry"
  >;
  readonly serviceExports: DaemonRuntimeServiceExports;
}): Promise<AlayaDaemonRuntime> {
  const mcpTooling = await bootstrapMcpToolingWithStep(input);
  const httpRuntime = createDaemonHttpRuntime(input, mcpTooling);
  return createFinalizedDaemonRuntime(
    input,
    httpRuntime.app,
    httpRuntime.lifecycleControls,
    createDaemonRuntimeServices(input, mcpTooling, httpRuntime.mcpMemoryToolHandler)
  );
}

async function bootstrapMcpToolingWithStep(input: {
  readonly startupSteps: DaemonStartupStepRecord[];
  readonly bootstrapMcpToolingInput: Parameters<typeof bootstrapDaemonMcpTooling>[0];
}): Promise<McpTooling> {
  const mcpTooling: McpTooling = await bootstrapDaemonMcpTooling({
    ...input.bootstrapMcpToolingInput,
    builtinConversationToolSpecs: getBuiltinConversationToolSpecs()
  });
  recordStartupStep(input.startupSteps, "mcp-tooling");
  return mcpTooling;
}

function recordStartupStep(
  startupSteps: DaemonStartupStepRecord[],
  step: DaemonStartupStepRecord["step"]
): void {
  startupSteps.push({ step, completedAt: new Date().toISOString() });
}

function createDaemonHttpRuntime(
  input: {
    readonly startupSteps: DaemonStartupStepRecord[];
    readonly attachSurfaceRegistrarInput: Parameters<typeof createAttachSurfaceRegistrar>[0];
    readonly mcpMemoryToolHandlerInput: Omit<
      Parameters<typeof createDaemonMcpMemoryToolHandler>[0],
      "attachSurfaceRegistrar"
    >;
    readonly appInput: Omit<
      Parameters<typeof createCoreDaemonApp>[0],
      "lifecycleState" | "startupSteps" | "mcpMemoryToolHandler" | "mcp"
    >;
    readonly lifecycleControlsInput: Omit<
      Parameters<typeof createDaemonLifecycleControls>[0],
      "app" | "lifecycleState" | "daemonMcpRuntimeRegistry"
    >;
  },
  mcpTooling: McpTooling
) {
  const mcpMemoryToolHandler = createDaemonMcpMemoryToolHandler({
    ...input.mcpMemoryToolHandlerInput,
    attachSurfaceRegistrar: createAttachSurfaceRegistrar(input.attachSurfaceRegistrarInput)
  });
  const lifecycleState = createCoreDaemonLifecycleState();
  const app = createCoreDaemonApp({
    ...input.appInput,
    lifecycleState,
    startupSteps: input.startupSteps,
    mcpMemoryToolHandler,
    mcp: mcpTooling.daemonMcpCatalog
  });
  recordStartupStep(input.startupSteps, "http-app");
  return {
    mcpMemoryToolHandler,
    app,
    lifecycleControls: createDaemonLifecycleControls({
      ...input.lifecycleControlsInput,
      app,
      lifecycleState,
      daemonMcpRuntimeRegistry: mcpTooling.daemonMcpRuntimeRegistry
    })
  };
}

function createDaemonRuntimeServices(
  input: {
    readonly serviceExports: DaemonRuntimeServiceExports;
  },
  mcpTooling: McpTooling,
  mcpMemoryToolHandler: ReturnType<typeof createDaemonMcpMemoryToolHandler>
) {
  return Object.freeze({
    conversationToolCatalog: mcpTooling.conversationToolCatalog,
    daemonMcpCatalog: mcpTooling.daemonMcpCatalog,
    ...input.serviceExports,
    mcpMemoryToolHandler,
    gardenStatus: createGardenStatusService(input.serviceExports)
  });
}

function createGardenStatusService(serviceExports: GardenCompileSnapshotExports) {
  return {
    getStatus: () => {
      const current = serviceExports.gardenRuntime.getStatus();
      return {
        last_pass_at: current.last_pass_at ?? serviceExports.initialGardenLastPassAt
      };
    },
    getHostWorkerExtractBacklog: (workspaceId?: string) => {
      if (serviceExports.gardenTaskRepo === undefined) {
        return null;
      }
      const staleBefore = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const extract = serviceExports.gardenTaskRepo.countByKind(
        GardenTaskKind.POST_TURN_EXTRACT,
        staleBefore,
        workspaceId,
        RECENT_GARDEN_COMPILE_TURN_LIMIT
      );
      const edgeClassify = serviceExports.gardenTaskRepo.countByKind(
        GardenTaskKind.EDGE_CLASSIFY,
        staleBefore,
        workspaceId
      );
      return {
        pending: extract.pending,
        stale: extract.stale,
        failed: extract.failed,
        edgeClassifyPending: edgeClassify.pending,
        edgeClassifyStale: edgeClassify.stale
      };
    },
    getRecentCompileEnqueueFailures: async (workspaceId: string) => {
      if (serviceExports.healthJournalService === undefined) {
        return 0;
      }
      const entries = await serviceExports.healthJournalService.getRecentEvents(workspaceId, {
        kind: HealthEventKind.GARDEN_BACKLOG,
        limit: RECENT_GARDEN_COMPILE_TURN_LIMIT
      });
      return entries.filter(isCompileEnqueueFailure).length;
    }
  };
}

function isCompileEnqueueFailure(entry: {
  readonly event_kind: string;
  readonly detail_json: Record<string, unknown>;
}): boolean {
  return (
    entry.event_kind === HealthEventKind.GARDEN_BACKLOG &&
    entry.detail_json.phase === GARDEN_COMPILE_ENQUEUE_HEALTH_PHASE &&
    (entry.detail_json.status === "unavailable" || entry.detail_json.status === "failed")
  );
}

function createFinalizedDaemonRuntime(
  input: {
    readonly requestProtection: RequestProtectionConfig;
    readonly runtimeNotifier: AlayaRuntimeNotifier;
    readonly startupSteps: DaemonStartupStepRecord[];
  },
  app: ReturnType<typeof createCoreDaemonApp>,
  lifecycleControls: ReturnType<typeof createDaemonLifecycleControls>,
  services: ReturnType<typeof createDaemonRuntimeServices>
): AlayaDaemonRuntime {
  return Object.freeze({
    app,
    requestProtection: input.requestProtection,
    runtimeNotifier: input.runtimeNotifier,
    startupSteps: input.startupSteps,
    services,
    startBackgroundServices: lifecycleControls.startBackgroundServices,
    runGardenBackgroundPass: lifecycleControls.runGardenBackgroundPass,
    runGardenBulkEnrichPass: lifecycleControls.runGardenBulkEnrichPass,
    runGardenEmbeddingBackfillPass: lifecycleControls.runGardenEmbeddingBackfillPass,
    startHttpServer: lifecycleControls.startHttpServer,
    shutdown: lifecycleControls.shutdown
  });
}
