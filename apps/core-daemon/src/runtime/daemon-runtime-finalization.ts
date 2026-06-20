import { GardenTaskKind } from "@do-soul/alaya-protocol";
import { createAttachSurfaceRegistrar } from "../attach/surface-registrar.js";
import { getBuiltinConversationToolSpecs } from "../mcp/builtin-conversation-tool-specs.js";
import { createDaemonMcpMemoryToolHandler } from "../mcp-memory/daemon-handler.js";
import { bootstrapDaemonMcpTooling } from "../mcp/daemon-mcp-tooling.js";
import { createCoreDaemonApp } from "./daemon-app-composition.js";
import {
  createCoreDaemonLifecycleState,
  createDaemonLifecycleControls
} from "./daemon-runtime-lifecycle.js";
import type {
  AlayaDaemonRuntime,
  AlayaDaemonRuntimeServices,
  DaemonStartupStepRecord
} from "./daemon-runtime-types.js";
import type { RequestProtectionConfig } from "./app.js";
import type { AlayaRuntimeNotifier } from "./runtime-notifier.js";

type McpTooling = Awaited<ReturnType<typeof bootstrapDaemonMcpTooling>>;

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
  readonly serviceExports: Omit<
    AlayaDaemonRuntimeServices,
    "conversationToolCatalog" | "daemonMcpCatalog" | "mcpMemoryToolHandler" | "gardenStatus"
  > & Readonly<{
    readonly initialGardenLastPassAt: string | null;
    readonly gardenRuntime: Readonly<{
      getStatus(): Readonly<{ readonly last_pass_at: string | null }>;
    }>;
    readonly gardenTaskRepo:
      | Readonly<{
          countByKind(
            taskKind: string,
            staleBefore: string
          ): Readonly<{ readonly pending: number; readonly stale: number }>;
        }>
      | undefined;
  }>;
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
    readonly serviceExports: Omit<
      AlayaDaemonRuntimeServices,
      "conversationToolCatalog" | "daemonMcpCatalog" | "mcpMemoryToolHandler" | "gardenStatus"
    > & Readonly<{
      readonly initialGardenLastPassAt: string | null;
      readonly gardenRuntime: Readonly<{
        getStatus(): Readonly<{ readonly last_pass_at: string | null }>;
      }>;
      readonly gardenTaskRepo:
        | Readonly<{
            countByKind(
              taskKind: string,
              staleBefore: string
            ): Readonly<{ readonly pending: number; readonly stale: number }>;
          }>
        | undefined;
    }>;
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

function createGardenStatusService(serviceExports: {
  readonly initialGardenLastPassAt: string | null;
  readonly gardenRuntime: Readonly<{
    getStatus(): Readonly<{ readonly last_pass_at: string | null }>;
  }>;
  readonly gardenTaskRepo:
    | Readonly<{
        countByKind(
          taskKind: string,
          staleBefore: string
        ): Readonly<{ readonly pending: number; readonly stale: number }>;
      }>
    | undefined;
}) {
  return {
    getStatus: () => {
      const current = serviceExports.gardenRuntime.getStatus();
      return {
        last_pass_at: current.last_pass_at ?? serviceExports.initialGardenLastPassAt
      };
    },
    getHostWorkerExtractBacklog: () => {
      if (serviceExports.gardenTaskRepo === undefined) {
        return null;
      }
      const staleBefore = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const extract = serviceExports.gardenTaskRepo.countByKind(
        GardenTaskKind.POST_TURN_EXTRACT,
        staleBefore
      );
      const edgeClassify = serviceExports.gardenTaskRepo.countByKind(
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
  };
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
