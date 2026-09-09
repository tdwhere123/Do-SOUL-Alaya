import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { AlayaDaemonRuntime } from "@do-soul/alaya";
import {
  ControlPlaneObjectKind,
  RetentionPolicy,
  TaskObjectSurfaceSchema,
  type MemorySearchResult,
  type RecallPolicy,
  type SoulReportContextUsageResponse
} from "@do-soul/alaya-protocol";
import {
  accrueAnswersWithCoRelevance,
  proposeMemoriesFromCompileSignals,
  proposeMemory,
  proposeMemoryFromSignal,
  proposeSynthesis
} from "../seed/daemon-seed-operations.js";
import { createBenchSeedProposalReviewer } from "../seed/daemon-seed-review.js";
import {
  buildBenchDiagnosticRecallPolicy,
  callMcpTool,
  closeBenchDaemonResources,
  emitBenchContextLensAssembledEvent,
  readMaterializedObjects,
  readEmbeddingWarmupSummary,
  restoreEnv,
  type BenchReviewerCredentials
} from "../daemon-support.js";
import type {
  BenchDaemonHandle,
  BenchEmbeddingMode,
  BenchEmbeddingProviderKind,
  BenchEmbeddingWarmupOptions,
  BenchEmbeddingWarmupSummary,
  BenchQueryEmbeddingWarmupSummary,
  BenchRecallOptions,
  BenchReportContextUsageInput
} from "../daemon-types.js";
import {
  awaitBenchEmbeddingProviderReady,
  drainEmbeddingWarmupPasses
} from "../../embedding/embedding-warmup.js";
import { resolveTreatmentEmbeddingInputIdentity } from "../../strict-treatment-config.js";
import {
  applyBenchRecallWeightOverrides,
  type BenchRecallWeightOverrides
} from "../../recall/recall-weight-overrides.js";
import {
  assertWarmEmbeddingReady,
  buildReportContextUsageArgs,
  dedupeDeliveredObjects,
  notRequestedEmbeddingWarmupSummary,
  notRequestedQueryEmbeddingWarmupSummary,
  resolveBenchEmbeddingModelId,
  resolveBenchEmbeddingSchemaVersion,
  shouldRunBenchEdgePlane
} from "./daemon-handle-ops-support.js";
import { buildBenchRecallResponse, encodeBenchRecallResults } from "./bench-recall-response.js";
import { invokeBoundRecall } from "@do-soul/alaya/recall/bound-execution";
import { createFieldProjectionCheckpointOperation } from "../runtime/daemon-field-projection.js";
import { createRelationProjectionCheckpointOperation } from "../runtime/daemon-relation-projection.js";
import { benchRequestFilters, resolveBenchRequestBudget } from "../../recall/conditional-request-budget.js";

const DEFAULT_EMBEDDING_WARMUP_PASSES = 12;
const EMBEDDING_WARMUP_MAX_STALL_PASSES = 6;

type ActiveBenchContext = { workspaceId: string; runId: string };
type BenchRecallServiceResult = Awaited<
  ReturnType<AlayaDaemonRuntime["services"]["recallService"]["recall"]>
>;

interface BenchDaemonOpsInput {
  readonly dataDir: string;
  readonly activeContext: ActiveBenchContext;
  readonly activeRuntime: AlayaDaemonRuntime;
  readonly activeServer: { close(): Promise<unknown> };
  readonly activeMcpClient: Client;
  readonly dispatchCli: BenchDaemonHandle["dispatchCli"];
  readonly recallWeightOverrides?: BenchRecallWeightOverrides;
  readonly embeddingMode: BenchEmbeddingMode;
  readonly embeddingProviderKind: BenchEmbeddingProviderKind;
  readonly effectiveEnv: Readonly<Record<string, string | undefined>>;
  readonly savedEnv: Partial<Record<string, string | undefined>>;
  readonly managedEnvKeys: readonly string[];
  readonly reviewerCredentials: BenchReviewerCredentials;
  readonly cleanupConfigDirectory: () => Promise<void>;
  readonly releaseActive: () => void;
  readonly cleanupManagedWorkspaceRoots: () => Promise<void>;
}

interface BenchDeliveryRecord {
  readonly deliveryId: string;
  readonly deliveredObjects: readonly {
    readonly object_id: string;
    readonly object_kind: string;
  }[];
}

export function createBenchDaemonOps(
  input: BenchDaemonOpsInput
): Pick<
  BenchDaemonHandle,
  | "recall"
  | "warmEmbeddingCache"
  | "warmQueryEmbeddingCache"
  | "runEdgePlanePassIfConfigured"
  | "checkpointRelationProjection"
  | "checkpointFieldProjection"
  | "reportContextUsage"
  | "proposeMemory"
  | "proposeMemoryFromSignal"
  | "proposeMemoriesFromCompileSignals"
  | "proposeSynthesis"
  | "accrueAnswersWithCoRelevance"
  | "shutdown"
> {
  const seedOps = createBenchSeedOperations(input);
  return {
    recall: createBenchRecallOperation(input),
    warmEmbeddingCache: createWarmEmbeddingCacheOperation(input),
    warmQueryEmbeddingCache: createWarmQueryEmbeddingCacheOperation(input),
    runEdgePlanePassIfConfigured: createRunEdgePlaneOperation(input),
    checkpointRelationProjection: createRelationProjectionCheckpointOperation({
      dataDir: input.dataDir,
      runtime: input.activeRuntime
    }),
    checkpointFieldProjection: createFieldProjectionCheckpointOperation({
      dataDir: input.dataDir,
      runtime: input.activeRuntime
    }),
    reportContextUsage: createBenchReportContextUsageOperation(input),
    ...seedOps,
    shutdown: createBenchShutdownOperation(input)
  };
}

function createBenchRecallOperation(
  input: BenchDaemonOpsInput
): BenchDaemonHandle["recall"] {
  return async (
    query: string,
    opts: BenchRecallOptions = {}
  ): ReturnType<BenchDaemonHandle["recall"]> => {
    const taskSurface = createBenchTaskSurface(query);
    const policy = buildBenchRecallPolicy(
      taskSurface.runtime_id,
      opts,
      input.recallWeightOverrides
    );
    const requestBudget = resolveBenchRequestBudget(opts);
    const interpretationClock = new Date(opts.interpretationClock ?? opts.referenceTime
      ?? opts.continuation?.interpretation_clock ?? new Date().toISOString()).toISOString();
    const rawRecallResult = await invokeBoundRecall({
      sideEffectMode: "benchmark",
      recallService: input.activeRuntime.services.recallService,
      taskSurface,
      workspaceId: input.activeContext.workspaceId,
      runId: input.activeContext.runId,
      strategy: "chat",
      policyOverride: policy,
      diagnosticCapture:
        input.effectiveEnv.ALAYA_BENCH_RECALL_PACKET_TRACE === "1"
          ? "packet_trace"
          : "answer_features",
      ...(opts.referenceTime === undefined ? {} : { referenceTime: opts.referenceTime }),
      ...(opts.querySemanticFactorFormationCapture === undefined
        ? {}
        : { querySemanticFactorFormationCapture: opts.querySemanticFactorFormationCapture }),
      ...(opts.querySemanticFactorCompletenessReceipt === undefined
        ? {}
        : { querySemanticFactorCompletenessReceipt:
            opts.querySemanticFactorCompletenessReceipt }),
      ...(opts.snapshotDigest === undefined ? {} : { snapshotDigest: opts.snapshotDigest }),
      queryText: query,
      budget: requestBudget,
      ...(opts.continuation === undefined ? {} : { continuation: opts.continuation }),
      ...(opts.cancelled === undefined ? {} : { cancelled: opts.cancelled }),
      interpretationClock,
      ...(opts.since === undefined ? {} : { since: opts.since }),
      ...(opts.until === undefined ? {} : { until: opts.until }),
      ...(opts.timeFilter === undefined ? {} : { timeFilter: opts.timeFilter }),
      activeConstraintsCap: null
    });
    const recallResult = rawRecallResult;
    const results = encodeBenchRecallResults(recallResult, policy, requestBudget, {
      queryText: query, workspaceId: input.activeContext.workspaceId, referenceTime: interpretationClock,
      requestBudget, requestFilters: benchRequestFilters(opts, policy),
      expectedIndexSnapshotId: opts.continuation?.snapshot_id
    });
    const delivery = await recordBenchRecallDelivery(input, results, recallResult);
    await emitBenchContextLensAssembledEvent(input.dataDir, {
      taskSurfaceRef: taskSurface.runtime_id,
      lensEntryCount: results.length,
      totalTokenEstimate: results.reduce(
        (sum, result) => sum + result.budget_state.token_estimate,
        0
      ),
      runId: input.activeContext.runId,
      workspaceId: input.activeContext.workspaceId
    });
    return buildBenchRecallResponse(delivery.deliveryId, results, recallResult, requestBudget);
  };
}

function createBenchReportContextUsageOperation(
  input: BenchDaemonOpsInput
): BenchDaemonHandle["reportContextUsage"] {
  return async (reportInput: BenchReportContextUsageInput): Promise<void> => {
    await callMcpTool<SoulReportContextUsageResponse>(
      input.activeMcpClient,
      "soul.report_context_usage",
      buildReportContextUsageArgs(reportInput)
    );
  };
}

function createWarmEmbeddingCacheOperation(
  input: BenchDaemonOpsInput
): BenchDaemonHandle["warmEmbeddingCache"] {
  return async (
    objectIds: readonly string[],
    opts: BenchEmbeddingWarmupOptions = {}
  ): Promise<BenchEmbeddingWarmupSummary> => {
    if (input.embeddingMode !== "env") {
      return notRequestedEmbeddingWarmupSummary(objectIds);
    }
    await awaitBenchEmbeddingProviderReady({
      embeddingMode: input.embeddingMode,
      providerWarmup: input.activeRuntime.services.embeddingProviderWarmup
    });
    const embedding = resolveBenchEmbeddingModelId(
      input.embeddingProviderKind,
      input.effectiveEnv
    );
    const warmed = await drainEmbeddingWarmupPasses({
      maxPasses: opts.maxPasses ?? DEFAULT_EMBEDDING_WARMUP_PASSES,
      maxStallPasses: EMBEDDING_WARMUP_MAX_STALL_PASSES,
      runPass: async () =>
        await input.activeRuntime.runGardenEmbeddingBackfillPass(
          input.activeContext.workspaceId,
          opts.backfillMode
        ),
      readSummary: async (passCount) =>
        await readEmbeddingWarmupSummary({
          dataDir: input.dataDir,
          workspaceId: input.activeContext.workspaceId,
          objectIds,
          providerKind: embedding.providerKind,
          modelId: embedding.modelId,
          schemaVersion: resolveBenchEmbeddingSchemaVersion(
            input.embeddingProviderKind, input.effectiveEnv
          ),
          expectedDimensions: requireEmbeddingProviderDimensions(input.activeRuntime),
          passCount
        })
    });
    assertWarmEmbeddingReady(warmed.summary, warmed.lastPassError);
    return warmed.summary;
  };
}

function requireEmbeddingProviderDimensions(runtime: AlayaDaemonRuntime): number {
  const dimensions = runtime.services.getEmbeddingProviderDimensions();
  if (dimensions === null) {
    throw new Error("embedding provider ready without observed dimensions");
  }
  return dimensions;
}

function createWarmQueryEmbeddingCacheOperation(
  input: BenchDaemonOpsInput
): BenchDaemonHandle["warmQueryEmbeddingCache"] {
  return async (
    queryTexts: readonly string[]
  ): Promise<BenchQueryEmbeddingWarmupSummary> => {
    if (input.embeddingMode !== "env" || queryTexts.length === 0) {
      return notRequestedQueryEmbeddingWarmupSummary(queryTexts.length);
    }
    const service = input.activeRuntime.services.embeddingRecallService;
    if (service === undefined) {
      throw new Error("query embedding warmup requested but embeddingRecallService is unavailable");
    }
    const summary = await service.warmQueryEmbeddings({
      workspaceId: input.activeContext.workspaceId,
      runId: input.activeContext.runId,
      queryTexts
    });
    return {
      ...summary,
      ...resolveTreatmentEmbeddingInputIdentity(input.embeddingProviderKind, input.effectiveEnv)
    };
  };
}

function createRunEdgePlaneOperation(
  input: BenchDaemonOpsInput
): BenchDaemonHandle["runEdgePlanePassIfConfigured"] {
  return async (): Promise<void> => {
    if (!shouldRunBenchEdgePlane()) {
      return;
    }
    await input.activeRuntime.runGardenBulkEnrichPass(input.activeContext.workspaceId);
  };
}

function createBenchShutdownOperation(
  input: BenchDaemonOpsInput
): BenchDaemonHandle["shutdown"] {
  let closed = false;
  return async (): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;
    try {
      await closeBenchDaemonResources({
        mcpClient: input.activeMcpClient,
        server: input.activeServer,
        runtime: input.activeRuntime
      });
      await input.cleanupManagedWorkspaceRoots();
    } finally {
      try {
        await input.cleanupConfigDirectory();
      } finally {
        restoreEnv(input.managedEnvKeys, input.savedEnv);
        input.releaseActive();
      }
    }
  };
}

function createBenchSeedOperations(
  input: BenchDaemonOpsInput
): Pick<
  BenchDaemonHandle,
  | "proposeMemory"
  | "proposeMemoryFromSignal"
  | "proposeMemoriesFromCompileSignals"
  | "proposeSynthesis"
  | "accrueAnswersWithCoRelevance"
> {
  const seedInput = {
    activeRuntime: input.activeRuntime,
    activeContext: input.activeContext,
    dataDir: input.dataDir,
    callMcpTool: async <TOutput>(
      name: string,
      args: Record<string, unknown>
    ): Promise<TOutput> => await callMcpTool<TOutput>(input.activeMcpClient, name, args),
    readMaterializedObjects: async (signalId: string) =>
      await readMaterializedObjects(input.dataDir, signalId),
    reviewMemoryProposal: createBenchSeedProposalReviewer({
      activeContext: input.activeContext,
      dispatchCli: input.dispatchCli,
      reviewerIdentity: input.reviewerCredentials.identity
    })
  };
  return {
    proposeMemory: async (content, evidenceRef, options) =>
      await proposeMemory(seedInput, content, evidenceRef, options),
    proposeMemoryFromSignal: async (signalInput) =>
      await proposeMemoryFromSignal(seedInput, signalInput),
    proposeMemoriesFromCompileSignals: async (signalInputs) =>
      await proposeMemoriesFromCompileSignals(seedInput, signalInputs),
    proposeSynthesis: async (synthesisInput) =>
      await proposeSynthesis(seedInput, synthesisInput),
    accrueAnswersWithCoRelevance: async (members, options) =>
      await accrueAnswersWithCoRelevance(seedInput, members, options)
  };
}

function createBenchTaskSurface(query: string) {
  return TaskObjectSurfaceSchema.parse({
    runtime_id: randomUUID(),
    object_kind: ControlPlaneObjectKind.TASK_OBJECT_SURFACE,
    task_surface_ref: null,
    expires_at: null,
    derived_from: null,
    retention_policy: RetentionPolicy.SESSION_ONLY,
    surface_kind: "mcp_memory_tool",
    display_name: query,
    context_refs: []
  });
}

function buildBenchRecallPolicy(
  taskSurfaceId: string,
  opts: BenchRecallOptions,
  recallWeightOverrides: BenchRecallWeightOverrides | undefined
): RecallPolicy {
  const basePolicy = buildBenchDiagnosticRecallPolicy(
    taskSurfaceId,
    opts.maxResults ?? 10,
    opts.conflictAwareness ?? true
  );
  return applyBenchRecallWeightOverrides(basePolicy, recallWeightOverrides);
}

async function recordBenchRecallDelivery(
  input: BenchDaemonOpsInput,
  results: readonly MemorySearchResult[],
  recallResult: BenchRecallServiceResult
): Promise<BenchDeliveryRecord> {
  const deliveryId = `delivery_${randomUUID()}`;
  const deliveredObjects = dedupeDeliveredObjects([
    ...results.flatMap((result) => result.object_id === undefined
      ? []
      : [{
        object_id: result.object_id,
        object_kind: result.object_kind
      }]),
    ...recallResult.active_constraints.map(
      (constraint: { readonly object_id: string; readonly object_kind: string }) => ({
        object_id: constraint.object_id,
        object_kind: constraint.object_kind
      })
    )
  ]);
  await input.activeRuntime.services.trustStateRecorder.recordDelivery({
    delivery_id: deliveryId,
    agent_target: "bench-runner",
    workspace_id: input.activeContext.workspaceId,
    run_id: input.activeContext.runId,
    delivered_object_ids: deliveredObjects.map((entry) => entry.object_id),
    delivered_objects: deliveredObjects,
    delivered_at: new Date().toISOString()
  });
  return { deliveryId, deliveredObjects };
}
