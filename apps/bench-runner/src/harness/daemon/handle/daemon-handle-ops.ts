import { joinFusedScoresOntoResults, enrichAbstentionConfidence } from "../../../datasets/longmemeval/runner/runner-scoring.js";
import { exposureSlots, FirstExposureSession } from "../../../runs/measurement/first-exposure-session.js";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { AlayaDaemonRuntime } from "@do-soul/alaya";
import {
  AlayaError,
  type MemorySearchResult,
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
import type { BenchRecallWeightOverrides } from "../../recall/recall-weight-overrides.js";
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
import {
  prepareBenchRecallRequest,
  type BenchRecallInvokeRequest
} from "./bench-recall-request.js";
import { invokeBoundRecall } from "@do-soul/alaya/recall/bound-execution";
import { createFieldProjectionCheckpointOperation } from "../runtime/daemon-field-projection.js";
import { createRelationProjectionCheckpointOperation } from "../runtime/daemon-relation-projection.js";
import { benchRequestFilters } from "../../recall/conditional-request-budget.js";

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

export interface BenchRecallOperationInput {
  readonly dataDir: string;
  readonly activeContext: ActiveBenchContext;
  readonly activeRuntime: {
    readonly services: {
      readonly recallService: AlayaDaemonRuntime["services"]["recallService"];
      readonly trustStateRecorder: Pick<
        AlayaDaemonRuntime["services"]["trustStateRecorder"],
        "recordDelivery"
      >;
    };
  };
  readonly recallWeightOverrides?: BenchRecallWeightOverrides;
  readonly embeddingMode: BenchEmbeddingMode;
  readonly effectiveEnv: Readonly<Record<string, string | undefined>>;
}

export function createBenchDaemonOps(
  input: BenchDaemonOpsInput
): Pick<
  BenchDaemonHandle,
  | "recall"
  | "importSourceRecord"
  | "captureHostSession"
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
    importSourceRecord: (request, hostCapture) => input.activeRuntime.services.sourceRecordAdmission.admit({
      ...request, workspace_id: input.activeContext.workspaceId, evidence_object_id: null
    }, { workspaceId: input.activeContext.workspaceId, ...(hostCapture === undefined ? {} : { hostCapture }) }),
    captureHostSession: async (request, issuer) => {
      const capture = input.activeRuntime.services.hostSessionCapture;
      if (capture === undefined) throw new AlayaError("UNAVAILABLE", "bench daemon has no host session capture");
      return await capture.capture({ workspaceId: input.activeContext.workspaceId, runId: input.activeContext.runId,
        request, issuer });
    },
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

export function createBenchRecallOperation(
  input: BenchRecallOperationInput
): BenchDaemonHandle["recall"] {
  const exposureSession = new FirstExposureSession();
  return async (
    query: string,
    opts: BenchRecallOptions = {}
  ): ReturnType<BenchDaemonHandle["recall"]> => {
    const invoke = prepareBenchRecallRequest(input, query, opts);
    const recallResult = await invokeBoundRecall({
      ...invoke,
      recallService: input.activeRuntime.services.recallService
    });
    return await deliverBenchRecallResponse(input, invoke, recallResult, exposureSession, opts);
  };
}

async function deliverBenchRecallResponse(
  input: BenchRecallOperationInput,
  invoke: BenchRecallInvokeRequest,
  recallResult: BenchRecallServiceResult,
  exposureSession: FirstExposureSession,
  opts: BenchRecallOptions
): ReturnType<BenchDaemonHandle["recall"]> {
  const results = encodeBenchRecallResults(
    recallResult,
    invoke.policyOverride,
    invoke.budget,
    {
      queryText: invoke.queryText,
      workspaceId: input.activeContext.workspaceId,
      referenceTime: invoke.interpretationClock,
      requestBudget: invoke.budget,
      requestFilters: benchRequestFilters(opts, invoke.policyOverride),
      expectedIndexSnapshotId: opts.continuation?.snapshot_id
    }
  );
  const deliveryId = await recordBenchRecallDelivery(input, results, recallResult);
  await emitBenchContextLensAssembledEvent(input.dataDir, {
    taskSurfaceRef: invoke.taskSurface.runtime_id,
    lensEntryCount: results.length,
    totalTokenEstimate: results.reduce(
      (sum, result) => sum + result.budget_state.token_estimate,
      0
    ),
    runId: input.activeContext.runId,
    workspaceId: input.activeContext.workspaceId
  });
  const response = buildBenchRecallResponse(
    deliveryId,
    results,
    recallResult,
    invoke.budget
  );
  return {
    ...response,
    first_exposure_page: exposureSession.record(
      response,
      opts.continuation,
      enrichAbstentionConfidence(
        joinFusedScoresOntoResults(exposureSlots(response), response, input.embeddingMode)
      )
    )
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

async function recordBenchRecallDelivery(
  input: BenchRecallOperationInput,
  results: readonly MemorySearchResult[],
  recallResult: BenchRecallServiceResult
): Promise<string> {
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
  return deliveryId;
}
