import type { RequestProtectionConfig } from "../../app.js";
import type { createCoreDaemonApp } from "../wiring/daemon-app-composition.js";
import type { AlayaRuntimeNotifier } from "../support/runtime-notifier.js";
import type { AppConfigService } from "../../../services/config/config-service.js";
import type { EmbeddingStatusService } from "../../../services/status/embedding-status-service.js";
import type { EnvironmentStatusService } from "../../../services/status/environment-status-service.js";
import type { GraphHealthService } from "../../../services/status/graph-health-service.js";
import type { McpMemoryToolHandler } from "../../../mcp-memory/tool/tool-handler.js";
import type { RecallUtilizationService } from "../../../services/status/recall-utilization-service.js";
import type { TrustStateRecorder } from "../../../trust/state.js";
import type {
  AnswerCoRelevancePairSourcePort,
  EmbeddingRecallService,
  PathRelationProposalService,
  RecallService,
  RelationAssertionAdmissionPort,
  RelationAssertionService,
  RunService,
  SignalService,
  SynthesisService,
  WorkspaceService
} from "@do-soul/alaya-core";
import type { MemoryHqRepo } from "@do-soul/alaya-storage";
import type { EmbeddingBackfillMode } from "../../../garden/scheduler/scheduler-runtime-types.js";
import type { RelationProjectionCheckpointPort } from
  "../../recall-materialization/relation-projection/checkpoint.js";

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
  // invariant: targeted BULK_ENRICH drain for bench edge-plane readiness.
  // Runs only the requested workspace's BULK_ENRICH worker loop, leaving the
  // broader Garden cadence and sibling workspaces untouched.
  // see also: apps/core-daemon/src/runtime/daemon-runtime-lifecycle.ts:runGardenBulkEnrichPass
  // see also: apps/core-daemon/src/garden/runtime.ts:runBulkEnrichPass
  runGardenBulkEnrichPass(workspaceId: string): Promise<void>;
  // invariant: targeted embedding-backfill drain for recall readiness; runs
  // ONLY EMBEDDING_BACKFILL, not the full fire-and-forget Garden background
  // pass. The bench embedding warmup uses this to reach embedding readiness
  // without dragging BULK_ENRICH / path-snapshot / consolidation into a
  // pre-recall gate.
  // see also: apps/core-daemon/src/runtime/daemon-runtime-lifecycle.ts:runGardenEmbeddingBackfillPass
  // see also: apps/core-daemon/src/garden/runtime.ts:runEmbeddingBackfillPass
  runGardenEmbeddingBackfillPass(
    workspaceId: string,
    mode?: EmbeddingBackfillMode
  ): Promise<void>;
  startHttpServer(options?: AlayaDaemonListenOptions): Promise<AlayaDaemonServer>;
  shutdown(): Promise<void>;
}


export type EffectiveReconciliationBasis = "rule_only" | "garden_llm";

export type ReconciliationBasisStatus =
  | { readonly enabled: false }
  | { readonly enabled: true; readonly basis: EffectiveReconciliationBasis };

export interface AlayaDaemonRuntimeServices {
  readonly reconciliationBasisStatus: ReconciliationBasisStatus;
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
  readonly embeddingProviderWarmup: Promise<"not_requested" | "ready" | "failed">;
  readonly getEmbeddingProviderDimensions: () => number | null;
  readonly embeddingRecallService?: Pick<
    EmbeddingRecallService,
    "warmQueryEmbeddings" | "coherentPairKeys"
  >;
  // invariant: answers_with crystallizer is always-on when the HQ repo is
  // present; null hqRepo → no mint.
  readonly answersWithPairSource?: AnswerCoRelevancePairSourcePort;
  readonly memoryHqWriter?: Pick<MemoryHqRepo, "upsertFromEvidence">;
  readonly graphHealthService: GraphHealthService;
  readonly configService: Pick<AppConfigService, "getGardenCredentialProvenance" | "getRuntimeGardenComputeConfig">;
  readonly mcpMemoryToolHandler: McpMemoryToolHandler;
  readonly recallService: Pick<RecallService, "recall">;
  // invariant: the bench harness seeds compile()-extracted signals through
  // the SAME in-process receiveSignal seam the production garden host-worker
  // completion uses (garden-runtime.ts processPostTurnExtractTask), so a
  // bench-seeded signal materializes a memory_entry exactly as production.
  readonly signalService: Pick<
    SignalService,
    | "receiveSignal"
    | "getSourceGroundingDeferStats"
    | "redriveSourceGroundingDefer"
    | "reconcileStaleSourceGroundingRedrive"
    | "listSourceGroundingDefers"
  >;
  // invariant: the bench harness seeds session-level synthesis_capsule rows
  // by calling SynthesisService.create directly, bypassing the
  // potential_synthesis signal route (materializeSynthesis) so no duplicate
  // evidence_capsule rows are minted into the recall store.
  readonly synthesisService: Pick<SynthesisService, "create">;
  readonly pathRelationProposalService: Pick<
    PathRelationProposalService,
    "submitCandidate" | "validateProposedObjectAnchors"
  >;
  readonly relationAssertionService: Pick<RelationAssertionService, "admit">;
  readonly relationAssertionAdmissionPort: RelationAssertionAdmissionPort;
  readonly relationProjectionCheckpoint: RelationProjectionCheckpointPort;
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
  readonly allowEphemeralRequestToken?: boolean;
}

export interface AlayaDaemonServer {
  readonly hostname: string;
  readonly port: number;
  close(): Promise<void>;
}
