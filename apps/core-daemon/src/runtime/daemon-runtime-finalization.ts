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
  const mcpTooling: McpTooling = await bootstrapDaemonMcpTooling({
    ...input.bootstrapMcpToolingInput,
    builtinConversationToolSpecs: getBuiltinConversationToolSpecs()
  });
  input.startupSteps.push({
    step: "mcp-tooling",
    completedAt: new Date().toISOString()
  });
  const attachSurfaceRegistrar = createAttachSurfaceRegistrar(input.attachSurfaceRegistrarInput);
  const mcpMemoryToolHandler = createDaemonMcpMemoryToolHandler({
    ...input.mcpMemoryToolHandlerInput,
    attachSurfaceRegistrar
  });
  const lifecycleState = createCoreDaemonLifecycleState();
  const app = createCoreDaemonApp({
    ...input.appInput,
    lifecycleState,
    startupSteps: input.startupSteps,
    mcpMemoryToolHandler,
    mcp: mcpTooling.daemonMcpCatalog
  });
  input.startupSteps.push({
    step: "http-app",
    completedAt: new Date().toISOString()
  });
  const lifecycleControls = createDaemonLifecycleControls({
    ...input.lifecycleControlsInput,
    app,
    lifecycleState,
    daemonMcpRuntimeRegistry: mcpTooling.daemonMcpRuntimeRegistry
  });

  return Object.freeze({
    app,
    requestProtection: input.requestProtection,
    runtimeNotifier: input.runtimeNotifier,
    startupSteps: input.startupSteps,
    services: Object.freeze({
      conversationToolCatalog: mcpTooling.conversationToolCatalog,
      daemonMcpCatalog: mcpTooling.daemonMcpCatalog,
      ...input.serviceExports,
      mcpMemoryToolHandler,
      gardenStatus: {
        getStatus: () => {
          const current = input.serviceExports.gardenRuntime.getStatus();
          return {
            last_pass_at: current.last_pass_at ?? input.serviceExports.initialGardenLastPassAt
          };
        },
        getHostWorkerExtractBacklog: () => {
          if (input.serviceExports.gardenTaskRepo === undefined) {
            return null;
          }
          const staleBefore = new Date(Date.now() - 10 * 60 * 1000).toISOString();
          const extract = input.serviceExports.gardenTaskRepo.countByKind(
            GardenTaskKind.POST_TURN_EXTRACT,
            staleBefore
          );
          const edgeClassify = input.serviceExports.gardenTaskRepo.countByKind(
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
      }
    }),
    startBackgroundServices: lifecycleControls.startBackgroundServices,
    runGardenBackgroundPass: lifecycleControls.runGardenBackgroundPass,
    runGardenBulkEnrichPass: lifecycleControls.runGardenBulkEnrichPass,
    runGardenEmbeddingBackfillPass: lifecycleControls.runGardenEmbeddingBackfillPass,
    startHttpServer: lifecycleControls.startHttpServer,
    shutdown: lifecycleControls.shutdown
  });
}
