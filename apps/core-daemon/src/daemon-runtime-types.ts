import type { RequestProtectionConfig } from "./app.js";
import type { createCoreDaemonApp } from "./daemon-app-composition.js";
import type { AlayaRuntimeNotifier } from "./runtime-notifier.js";
import type { AppConfigService } from "./services/config-service.js";
import type { EmbeddingStatusService } from "./services/embedding-status-service.js";
import type { EnvironmentStatusService } from "./services/environment-status-service.js";
import type { GraphHealthService } from "./services/graph-health-service.js";
import type { McpMemoryToolHandler } from "./mcp-memory-tool-handler.js";
import type { RecallUtilizationService } from "./services/recall-utilization-service.js";
import type { TrustStateRecorder } from "./trust-state.js";
import type { RecallService, RunService, WorkspaceService } from "@do-soul/alaya-core";

export type StartupStep =
  | "database"
  | "repositories"
  | "core-services"
  | "garden-runtime"
  | "mcp-tooling"
  | "http-app";

export interface DaemonStartupStepRecord {
  readonly step: StartupStep;
  readonly completedAt: string;
}

export interface AlayaDaemonRuntime {
  readonly app: ReturnType<typeof createCoreDaemonApp>;
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
  readonly graphHealthService: GraphHealthService;
  readonly configService: Pick<AppConfigService, "getGardenCredentialProvenance" | "getRuntimeGardenComputeConfig">;
  readonly mcpMemoryToolHandler: McpMemoryToolHandler;
  readonly recallService: Pick<RecallService, "recall">;
  readonly recallUtilizationService: RecallUtilizationService;
  readonly runService: Pick<RunService, "getById" | "ensureAttachedMcpSessionRun">;
  readonly trustStateRecorder: TrustStateRecorder;
  readonly workspaceService: Pick<
    WorkspaceService,
    "ensureLocalWorkspace" | "reconcileBootstrapPaths"
  >;
  readonly gardenStatus: Readonly<{
    getStatus(): Readonly<{ readonly last_pass_at: string | null }>;
  }>;
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
