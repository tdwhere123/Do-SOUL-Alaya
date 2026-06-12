import type { RequestProtectionConfig } from "../app.js";
import type { createCoreDaemonApp } from "./daemon-app-composition.js";
import type { AlayaRuntimeNotifier } from "./runtime-notifier.js";
import type { AppConfigService } from "../services/config-service.js";
import type { EmbeddingStatusService } from "../services/embedding-status-service.js";
import type { EnvironmentStatusService } from "../services/environment-status-service.js";
import type { GraphHealthService } from "../services/graph-health-service.js";
import type { McpMemoryToolHandler } from "../mcp-memory/tool-handler.js";
import type { RecallUtilizationService } from "../services/recall-utilization-service.js";
import type { TrustStateRecorder } from "../trust/state.js";
import type {
  EmbeddingRecallService,
  PathRelationProposalService,
  RecallService,
  RunService,
  SignalService,
  SynthesisService,
  WorkspaceService
} from "@do-soul/alaya-core";

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
  // invariant: targeted embedding-backfill drain for recall readiness; runs
  // ONLY EMBEDDING_BACKFILL, not the full fire-and-forget Garden background
  // pass. The bench embedding warmup uses this to reach embedding readiness
  // without dragging BULK_ENRICH / path-snapshot / consolidation into a
  // pre-recall gate.
  // see also: apps/core-daemon/src/runtime/daemon-runtime-lifecycle.ts:runGardenEmbeddingBackfillPass
  // see also: apps/core-daemon/src/garden/runtime.ts:runEmbeddingBackfillPass
  runGardenEmbeddingBackfillPass(workspaceId: string): Promise<void>;
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
  readonly embeddingRecallService?: Pick<
    EmbeddingRecallService,
    "warmQueryEmbeddings" | "coherentPairKeys"
  >;
  readonly graphHealthService: GraphHealthService;
  readonly configService: Pick<AppConfigService, "getGardenCredentialProvenance" | "getRuntimeGardenComputeConfig">;
  readonly mcpMemoryToolHandler: McpMemoryToolHandler;
  readonly recallService: Pick<RecallService, "recall">;
  // invariant: the bench harness seeds compile()-extracted signals through
  // the SAME in-process receiveSignal seam the production garden host-worker
  // completion uses (garden-runtime.ts processPostTurnExtractTask), so a
  // bench-seeded signal materializes a memory_entry exactly as production.
  readonly signalService: Pick<SignalService, "receiveSignal">;
  // invariant: the bench harness seeds session-level synthesis_capsule rows
  // by calling SynthesisService.create directly, bypassing the
  // potential_synthesis signal route (materializeSynthesis) so no duplicate
  // evidence_capsule rows are minted into the recall store.
  readonly synthesisService: Pick<SynthesisService, "create">;
  // invariant: the bench harness EARNS same-session co-recall PathRelations
  // through the SAME production counter gate B-1 cross-link uses (onCoUsage ->
  // accrueCoOccurrence -> co_usage_threshold -> proposeCoRecalled), so a
  // bench-earned co_recalled edge is the production recalls-tier edge — not a
  // bench-only shape. Production grows these from B-1 cross-link over live
  // report_context_usage; the bench has no attached agent reporting usage, so
  // it replays a bounded gold-blind pair set through the SAME onCoUsage seam at
  // seed time. counterSize is read-only diagnostics over the durable counter
  // (settled-vs-pending), not a write path. submitCandidate remains for
  // signal-ref / entity producers the bench drives elsewhere.
  // see also: packages/core/src/path-graph/path-relation-proposal-service.ts onCoUsage / submitCandidate
  // see also: apps/bench-runner/src/harness/daemon.ts accrueSessionCoRecall
  readonly pathRelationProposalService: Pick<
    PathRelationProposalService,
    "submitCandidate" | "onCoUsage" | "onCoRecall" | "counterSize"
  >;
  readonly recallUtilizationService: RecallUtilizationService;
  readonly runService: Pick<RunService, "getById" | "ensureAttachedMcpSessionRun">;
  readonly trustStateRecorder: TrustStateRecorder;
  readonly workspaceService: Pick<
    WorkspaceService,
    "ensureLocalWorkspace" | "reconcileBootstrapPaths"
  >;
  readonly gardenStatus: Readonly<{
    getStatus(): Readonly<{ readonly last_pass_at: string | null }>;
    // Recall-driven host-worker backlog snapshot used by doctor/status to warn
    // under the host_worker product default when work is aging unclaimed (no
    // attached CLI agent). `pending` counts unclaimed POST_TURN_EXTRACT tasks;
    // `stale` counts POST_TURN_EXTRACT tasks a worker CLAIMED but whose claim is
    // older than the wait window (claimed-and-aged, not pending-and-aged).
    // edgeClassifyPending / edgeClassifyStale carry the same pending/stale split
    // for EDGE_CLASSIFY tasks so a no-agent deployment's unrefined heuristic-edge
    // backlog is visible too. Returns null when no garden task repo is wired
    // (e.g. a non-sqlite harness).
    getHostWorkerExtractBacklog(): Readonly<{
      readonly pending: number;
      readonly stale: number;
      readonly edgeClassifyPending: number;
      readonly edgeClassifyStale: number;
    }> | null;
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
