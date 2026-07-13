import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { AlayaDaemonRuntime } from "@do-soul/alaya";
import {
  ControlPlaneObjectKind,
  RetentionPolicy,
  SoulMemorySearchResponseSchema,
  TaskObjectSurfaceSchema,
  type MemorySearchResult,
  type RecallCandidate,
  type RecallPolicy,
  type SoulMemorySearchResponse,
  type SoulReportContextUsageResponse
} from "@do-soul/alaya-protocol";
import {
  accrueAnswersWithCoRelevance,
  accrueCoherenceCoRecall,
  accrueSessionCoRecall,
  proposeMemoriesFromCompileSignals,
  proposeMemory,
  proposeMemoryFromSignal,
  proposeSynthesis
} from "./daemon-seed-operations.js";
import {
  buildBenchDiagnosticRecallPolicy,
  buildBenchMemorySearchResult,
  buildBenchRecallStrategyMix,
  callMcpTool,
  closeBenchDaemonResources,
  emitBenchContextLensAssembledEvent,
  readMaterializedObjects,
  readEmbeddingWarmupSummary,
  restoreEnv,
  type BenchReviewerCredentials
} from "./daemon-support.js";
import type {
  BenchDaemonHandle,
  BenchEmbeddingMode,
  BenchEmbeddingProviderKind,
  BenchEmbeddingWarmupOptions,
  BenchEmbeddingWarmupSummary,
  BenchQueryEmbeddingWarmupSummary,
  BenchRecallOptions,
  BenchReportContextUsageInput
} from "./daemon-types.js";
import { drainEmbeddingWarmupPasses } from "./embedding-warmup.js";
import { resolveTreatmentEmbeddingInputIdentity } from "./strict-treatment-config.js";
import {
  applyBenchRecallWeightOverrides,
  type BenchRecallWeightOverrides
} from "./recall-weight-overrides.js";
import {
  assertWarmEmbeddingReady,
  buildReportContextUsageArgs,
  dedupeDeliveredObjects,
  notRequestedEmbeddingWarmupSummary,
  notRequestedQueryEmbeddingWarmupSummary,
  resolveBenchEmbeddingModelId,
  resolveBenchEmbeddingSchemaVersion,
  resolveBenchRecallDegradationReason,
  shouldRunBenchEdgePlane
} from "./daemon-handle-ops-support.js";
import { invokeBoundRecall } from "@do-soul/alaya/recall/bound-execution";
import {
  parseBenchRecallDiagnosticsForRun
} from "./recall-diagnostics-schema.js";
import { assertEmbeddingTreatmentDiagnosticsPresent } from "./embedding-treatment-activation.js";

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
  | "reportContextUsage"
  | "proposeMemory"
  | "proposeMemoryFromSignal"
  | "proposeMemoriesFromCompileSignals"
  | "proposeSynthesis"
  | "accrueSessionCoRecall"
  | "accrueCoherenceCoRecall"
  | "accrueAnswersWithCoRelevance"
  | "shutdown"
> {
  const seedOps = createBenchSeedOperations(input);
  return {
    recall: createBenchRecallOperation(input),
    warmEmbeddingCache: createWarmEmbeddingCacheOperation(input),
    warmQueryEmbeddingCache: createWarmQueryEmbeddingCacheOperation(input),
    runEdgePlanePassIfConfigured: createRunEdgePlaneOperation(input),
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
  ): Promise<SoulMemorySearchResponse & { readonly diagnostics?: unknown }> => {
    const taskSurface = createBenchTaskSurface(query);
    const policy = buildBenchRecallPolicy(
      taskSurface.runtime_id,
      opts,
      input.recallWeightOverrides
    );
    const rawRecallResult = await invokeBoundRecall({
      sideEffectMode: "benchmark",
      recallService: input.activeRuntime.services.recallService,
      taskSurface,
      workspaceId: input.activeContext.workspaceId,
      runId: input.activeContext.runId,
      strategy: "chat",
      policyOverride: policy,
      diagnosticCapture: "answer_features",
      ...(opts.referenceTime === undefined ? {} : { referenceTime: opts.referenceTime }),
      activeConstraintsCap: null
    });
    const recallResult = validateBenchRecallDiagnostics(rawRecallResult, input.effectiveEnv);
    const results = collectBenchRecallResults(recallResult, policy, opts.maxResults);
    const delivery = await recordBenchRecallDelivery(input, results, recallResult);
    emitBenchContextLensAssembledEvent(input.dataDir, {
      taskSurfaceRef: taskSurface.runtime_id,
      lensEntryCount: results.length,
      totalTokenEstimate: results.reduce(
        (sum, result) => sum + result.budget_state.token_estimate,
        0
      ),
      runId: input.activeContext.runId,
      workspaceId: input.activeContext.workspaceId
    });
    return buildBenchRecallResponse(delivery.deliveryId, results, recallResult, policy);
  };
}

function validateBenchRecallDiagnostics(
  recallResult: BenchRecallServiceResult,
  effectiveEnv: Readonly<Record<string, string | undefined>>
): BenchRecallServiceResult {
  assertEmbeddingTreatmentDiagnosticsPresent(recallResult.diagnostics, effectiveEnv);
  if (recallResult.diagnostics === undefined) return recallResult;
  parseBenchRecallDiagnosticsForRun(recallResult.diagnostics, effectiveEnv);
  return recallResult;
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
    if (input.embeddingMode !== "env" || objectIds.length === 0) {
      return notRequestedEmbeddingWarmupSummary(objectIds);
    }
    const embedding = resolveBenchEmbeddingModelId(
      input.embeddingProviderKind,
      input.effectiveEnv
    );
    const warmed = await drainEmbeddingWarmupPasses({
      maxPasses: opts.maxPasses ?? DEFAULT_EMBEDDING_WARMUP_PASSES,
      maxStallPasses: EMBEDDING_WARMUP_MAX_STALL_PASSES,
      runPass: async () =>
        await input.activeRuntime.runGardenEmbeddingBackfillPass(
          input.activeContext.workspaceId
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
          passCount
        })
    });
    assertWarmEmbeddingReady(warmed.summary, warmed.lastPassError);
    return warmed.summary;
  };
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
  | "accrueSessionCoRecall"
  | "accrueCoherenceCoRecall"
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
    reviewerIdentity: input.reviewerCredentials.identity,
    reviewerToken: input.reviewerCredentials.token
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
    accrueSessionCoRecall: async (memberMemoryIds) =>
      await accrueSessionCoRecall(seedInput, memberMemoryIds),
    accrueCoherenceCoRecall: async (members, options) =>
      await accrueCoherenceCoRecall(seedInput, members, options),
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

function collectBenchRecallResults(
  recallResult: BenchRecallServiceResult,
  policy: RecallPolicy,
  maxResultsInput: number | undefined
): readonly MemorySearchResult[] {
  const candidates = selectBenchRecallCandidates(recallResult, maxResultsInput);
  let usedTokens = 0;
  return candidates.map((candidate, index) => {
    const result = buildBenchMemorySearchResult(candidate, policy, index, usedTokens);
    usedTokens += candidate.token_estimate;
    return result;
  });
}

function selectBenchRecallCandidates(
  recallResult: BenchRecallServiceResult,
  maxResultsInput: number | undefined
): readonly Readonly<RecallCandidate>[] {
  const maxResults = Math.max(maxResultsInput ?? 10, 1);
  const activeConstraintIds = new Set(
    recallResult.active_constraints.map(
      (constraint: { readonly object_id: string }) => constraint.object_id
    )
  );
  return recallResult.candidates
    .filter((candidate: RecallCandidate) => !activeConstraintIds.has(candidate.object_id))
    .slice(0, maxResults);
}

async function recordBenchRecallDelivery(
  input: BenchDaemonOpsInput,
  results: readonly MemorySearchResult[],
  recallResult: BenchRecallServiceResult
): Promise<BenchDeliveryRecord> {
  const deliveryId = `delivery_${randomUUID()}`;
  const deliveredObjects = dedupeDeliveredObjects([
    ...results.map((result) => ({
      object_id: result.object_id,
      object_kind: result.object_kind
    })),
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

function buildBenchRecallResponse(
  deliveryId: string,
  results: readonly MemorySearchResult[],
  recallResult: BenchRecallServiceResult,
  policy: RecallPolicy
): SoulMemorySearchResponse & { readonly diagnostics?: unknown } {
  const response = SoulMemorySearchResponseSchema.parse({
    delivery_id: deliveryId,
    protocol_version: 1,
    results,
    active_constraints: recallResult.active_constraints,
    active_constraints_count: recallResult.active_constraints_count,
    total_count: results.length,
    strategy_mix: buildBenchRecallStrategyMix(policy, results),
    degradation_reason: resolveBenchRecallDegradationReason(
      results,
      recallResult.degradation_reason
    )
  });
  return recallResult.diagnostics === undefined
    ? response
    : { ...response, diagnostics: recallResult.diagnostics };
}
