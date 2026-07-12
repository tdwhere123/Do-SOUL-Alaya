import { performance } from "node:perf_hooks";
import {
  RecallContextEventType,
  SoulRecallCompletedPayloadSchema,
  type RecallPolicy
} from "@do-soul/alaya-protocol";
import { withEmbeddingSimilarityScores } from "../coarse-filter/coarse-candidates.js";
import { fineAssess } from "../delivery/fine-assessment.js";
import {
  applyManifestationBiasSidecar,
  appendWeightTransferTelemetry,
  assessCoarseFilter,
  loadActiveConstraints,
  recordGlobalRecallClassificationsSafely,
  resolvePolicy
} from "./orchestration.js";
import { compileRecallQueryProbes } from "../query/recall-query-probes.js";
import {
  finalizeRecallCandidateDiagnostics,
  resolveEmbeddingProviderDegradationReason,
  resolveEmbeddingProviderStatus
} from "./diagnostics.js";
import { normalizeQueryText } from "./recall-service-helpers.js";
import type {
  RecallDegradationReason,
  RecallEmbeddingProviderStatus,
  RecallResult,
  RecallServiceDependencies
} from "./recall-service-types.js";
import { makeTokenEstimator } from "./recall-service-types.js";
import {
  collectEmbeddingSupplement,
  prepareEmbeddingSupplementQuery
} from "../supplements/supplements.js";
import {
  collectCoarseStage,
  type CoarseStageResult,
  type EmbeddingCoarseInjectionResult
} from "./recall-service-runner-coarse.js";
import { collectPoolEmbeddingRescore } from "../rerank/recall-pool-embedding-rescore.js";
import { buildRecallResult } from "./recall-result-builder.js";
import type {
  FineAssessmentResult,
  PreparedEmbeddingQuery,
  PreparedRecallRequest,
  RecallAssessmentStageResult,
  RecallExecutionContext,
  RecallExecutionParams,
  RecallManifestedResult
} from "./recall-service-runner-types.js";

export type { RecallExecutionContext, RecallExecutionParams, PreparedRecallRequest } from "./recall-service-runner-types.js";

type AssessmentStageResult = RecallAssessmentStageResult;
type ManifestedRecallResult = RecallManifestedResult;

const RECALLS_EDGE_COLD_THRESHOLD = 50;

export async function executeRecall(
  context: RecallExecutionContext,
  params: RecallExecutionParams
): Promise<RecallResult> {
  const degradationReasons = new Set<RecallDegradationReason>();
  const executionContext = Object.freeze({ ...context, degradationReasons });
  const prepared = await prepareRecallRequest(executionContext, params);
  const coarse = await collectCoarseStage(executionContext, params, prepared);
  const assessment = await assessCandidateStage(executionContext, params, prepared, coarse);
  const manifested = await manifestCandidateStage(executionContext, params, assessment.finalAssessment);
  await recordRecallSideEffects(executionContext, params, prepared, coarse, assessment, manifested);
  return buildRecallResult(prepared, coarse, assessment, manifested, degradationReasons);
}

async function prepareRecallRequest(
  context: RecallExecutionContext,
  params: RecallExecutionParams
): Promise<PreparedRecallRequest> {
  const policy = resolvePolicy({
    strategy: params.strategy,
    taskSurfaceRef: params.taskSurface.runtime_id,
    policyOverride: params.policyOverride,
    buildDefaultPolicy: context.buildDefaultPolicy,
    defaultPolicyDecorator: context.dependencies.defaultPolicyDecorator
  });
  const tokenEstimator = makeTokenEstimator({ hint: params.hostContext?.tokenizer_hint });
  const queryText = normalizeQueryText(params.taskSurface.display_name);
  const queryProbes = compileRecallQueryProbes(queryText);
  const referenceTime = resolveRecallReferenceTime(params.referenceTime, context.now);
  const [slots, activeConstraints] = await Promise.all([
    context.dependencies.slotRepo.findByWorkspace(params.workspaceId),
    loadActiveConstraints({
      activeConstraintsPort: context.dependencies.activeConstraintsPort,
      workspaceId: params.workspaceId,
      cap: params.activeConstraintsCap ?? null
    })
  ]);
  return Object.freeze({
    policy,
    tokenEstimator,
    queryText,
    queryProbes,
    referenceTime,
    activeConstraints,
    winnerMemoryIds: await resolveWinnerMemoryIds(context, params.workspaceId, slots)
  });
}

function resolveRecallReferenceTime(
  explicit: string | undefined,
  now: () => string
): string {
  if (explicit === undefined) return now();
  if (!/(?:z|[+-]\d{2}:\d{2})$/iu.test(explicit)) {
    throw new Error("recall reference time must include a timezone offset");
  }
  const parsed = Date.parse(explicit);
  if (!Number.isFinite(parsed)) {
    throw new Error("recall reference time must be a valid date-time");
  }
  return explicit;
}

async function resolveWinnerMemoryIds(
  context: RecallExecutionContext,
  workspaceId: string,
  slots: Awaited<ReturnType<RecallServiceDependencies["slotRepo"]["findByWorkspace"]>>
): Promise<ReadonlySet<string>> {
  const winnerClaimIds = new Set(slots.flatMap((slot) => (slot.winner_claim_id === null ? [] : [slot.winner_claim_id])));
  if (winnerClaimIds.size === 0 || context.dependencies.claimResolverPort === undefined) {
    return new Set();
  }
  const claims = await context.dependencies.claimResolverPort.findByIds(workspaceId, [...winnerClaimIds]);
  return new Set(claims.flatMap((claim) => claim.source_object_refs).filter((ref): ref is string => ref !== undefined));
}

async function assessCandidateStage(
  context: RecallExecutionContext,
  params: RecallExecutionParams,
  prepared: PreparedRecallRequest,
  coarse: CoarseStageResult
): Promise<AssessmentStageResult> {
  const preparedEmbeddingQueryPromise = startEmbeddingSupplementPreparation(context, params, prepared, coarse);
  const initialAssessment = await runInitialFineAssessment(context, params, prepared, coarse);
  const preparedEmbeddingQuery = await unwrapPreparedEmbeddingQuery(preparedEmbeddingQueryPromise);
  const [embeddingSupplementResult, poolRescoreResult] = await Promise.all([
    settle(collectEmbeddingSupplementStage(context, params, prepared, coarse, initialAssessment, preparedEmbeddingQuery)),
    settle(collectPoolEmbeddingRescore(context, params, prepared, coarse))
  ]);
  throwFirstRejected([embeddingSupplementResult, poolRescoreResult]);
  const embeddingSupplement = unwrapSettled(embeddingSupplementResult);
  const poolRescoreScores = unwrapSettled(poolRescoreResult);
  const supplementaryData = withEmbeddingSimilarityScores(
    initialAssessment.supplementaryData,
    embeddingSupplement.similarityHintsByObjectId,
    coarse.embeddingCoarseInjection.similarityScores,
    poolRescoreScores
  );
  const finalAssessment = needsEmbeddingReassessment(embeddingSupplement, coarse.embeddingCoarseInjection) ||
    Object.keys(poolRescoreScores).length > 0
    ? fineAssess({
        candidates: coarse.combinedCoarseCandidates,
        policy: prepared.policy,
        winnerMemoryIds: prepared.winnerMemoryIds,
        supplementaryData,
        tokenEstimator: prepared.tokenEstimator,
        now: () => prepared.referenceTime,
        warn: context.warn,
        captureAnswerFeatures: params.diagnosticCapture === "answer_features"
      })
    : initialAssessment;
  const provider = resolveEmbeddingProvider(prepared.policy, preparedEmbeddingQuery, coarse.embeddingCoarseInjection);
  return Object.freeze({
    finalAssessment,
    supplementaryData,
    preparedEmbeddingQuery,
    embeddingCoarseInjection: coarse.embeddingCoarseInjection,
    embeddingProviderStatus: provider.status,
    providerDegradationReason: provider.degradationReason,
    recallAfterFusion: performance.now()
  });
}

function startEmbeddingSupplementPreparation(
  context: RecallExecutionContext,
  params: RecallExecutionParams,
  prepared: PreparedRecallRequest,
  coarse: CoarseStageResult
): Promise<{ readonly status: "fulfilled"; readonly value: PreparedEmbeddingQuery } | { readonly status: "rejected"; readonly reason: unknown }> {
  return prepareEmbeddingSupplementQuery({
    dependencies: context.dependencies,
    config: prepared.policy,
    workspaceId: params.workspaceId,
    runId: params.runId ?? null,
    queryText: prepared.queryText,
    localEligibleCandidates: coarse.coarseFilter.candidates,
    lexicalFallbackCount: Math.min(coarse.combinedCoarseCandidates.length, prepared.policy.fine_assessment.budgets.max_entries)
  }).then(
    (value) => ({ status: "fulfilled" as const, value }),
    (reason: unknown) => ({ status: "rejected" as const, reason })
  );
}

async function runInitialFineAssessment(
  context: RecallExecutionContext,
  params: RecallExecutionParams,
  prepared: PreparedRecallRequest,
  coarse: CoarseStageResult
): Promise<Awaited<ReturnType<typeof assessCoarseFilter>>> {
  return assessCoarseFilter({
    dependencies: context.dependencies,
    warn: context.warn,
    now: () => prepared.referenceTime,
    coarseFilter: Object.freeze({ ...coarse.coarseFilter, candidates: coarse.combinedCoarseCandidates }),
    workspaceId: params.workspaceId,
    runId: params.runId ?? null,
    queryText: prepared.queryText,
    policy: prepared.policy,
    queryProbes: prepared.queryProbes,
    winnerMemoryIds: prepared.winnerMemoryIds,
    tokenEstimator: prepared.tokenEstimator,
    captureAnswerFeatures: params.diagnosticCapture === "answer_features"
  });
}

async function unwrapPreparedEmbeddingQuery(
  promise: Promise<{ readonly status: "fulfilled"; readonly value: PreparedEmbeddingQuery } | { readonly status: "rejected"; readonly reason: unknown }>
): Promise<PreparedEmbeddingQuery> {
  const result = await promise;
  if (result.status === "rejected") {
    throw result.reason;
  }
  return result.value;
}

async function collectEmbeddingSupplementStage(
  context: RecallExecutionContext,
  params: RecallExecutionParams,
  prepared: PreparedRecallRequest,
  coarse: CoarseStageResult,
  initialAssessment: Awaited<ReturnType<typeof assessCoarseFilter>>,
  preparedEmbeddingQuery: PreparedEmbeddingQuery
): Promise<Awaited<ReturnType<typeof collectEmbeddingSupplement>>> {
  return collectEmbeddingSupplement({
    dependencies: context.dependencies,
    baseCandidateIds: initialAssessment.candidates.map((candidate) => candidate.object_id),
    localEligibleCandidates: coarse.coarseFilter.candidates,
    config: prepared.policy,
    workspaceId: params.workspaceId,
    runId: params.runId ?? null,
    queryText: prepared.queryText,
    preparedEmbeddingQuery: preparedEmbeddingQuery.handle,
    preparedStoredVectors: preparedEmbeddingQuery.storedVectors
  });
}

function needsEmbeddingReassessment(
  supplement: Awaited<ReturnType<typeof collectEmbeddingSupplement>>,
  injection: EmbeddingCoarseInjectionResult
): boolean {
  return Object.keys(supplement.similarityHintsByObjectId).length > 0 || injection.candidates.length > 0;
}

function resolveEmbeddingProvider(
  policy: Readonly<RecallPolicy>,
  preparedEmbeddingQuery: PreparedEmbeddingQuery,
  injection: EmbeddingCoarseInjectionResult
): Readonly<{ readonly status: RecallEmbeddingProviderStatus; readonly degradationReason: string | null }> {
  const preparedStatus = resolveEmbeddingProviderStatus(policy, preparedEmbeddingQuery.handle, preparedEmbeddingQuery.degradedReason);
  const preparedReason = resolveEmbeddingProviderDegradationReason(policy, preparedEmbeddingQuery.handle, preparedEmbeddingQuery.degradedReason);
  return Object.freeze({
    status: preparedStatus === "provider_not_requested" && injection.embeddingProviderStatus !== null
      ? injection.embeddingProviderStatus
      : preparedStatus,
    degradationReason: preparedReason === null && preparedStatus === "provider_not_requested"
      ? injection.providerDegradationReason
      : preparedReason
  });
}

async function manifestCandidateStage(
  context: RecallExecutionContext,
  params: RecallExecutionParams,
  finalAssessment: FineAssessmentResult
): Promise<ManifestedRecallResult> {
  const candidates = await applyManifestationBiasSidecar({
    manifestationSidecarPort: context.dependencies.manifestationSidecarPort,
    warn: context.warn,
    workspaceId: params.workspaceId,
    runId: params.runId ?? null,
    taskSurfaceRef: params.taskSurface,
    candidates: finalAssessment.candidates
  });
  return Object.freeze({
    candidates,
    candidateDiagnostics: finalizeRecallCandidateDiagnostics(finalAssessment.diagnostics, candidates),
    recallAfterManifestation: performance.now()
  });
}

async function recordRecallSideEffects(
  context: RecallExecutionContext,
  params: RecallExecutionParams,
  prepared: PreparedRecallRequest,
  coarse: CoarseStageResult,
  assessment: AssessmentStageResult,
  manifested: ManifestedRecallResult
): Promise<void> {
  await appendRecallCompletedEvent(context, params, prepared, coarse, manifested);
  await Promise.all([
    appendWeightTransferTelemetry({
      eventLogRepo: context.dependencies.eventLogRepo,
      warn: context.warn,
      now: context.now,
      recallsEdgeColdThreshold: RECALLS_EDGE_COLD_THRESHOLD,
      workspaceId: params.workspaceId,
      runId: params.runId ?? null,
      graphAndPathColdScore: assessment.supplementaryData.graphAndPathColdScore,
      recallsEdgeCount: assessment.supplementaryData.recallsEdgeCount,
      weightTransferAmount: assessment.supplementaryData.weightTransferAmount
    }),
    recordGlobalRecallClassificationsSafely({
      globalRecallCachePort: context.dependencies.globalRecallCachePort,
      warn: context.warn,
      classifications: coarse.globalRecallClassifications
    })
  ]);
}

type Settled<T> =
  | { readonly status: "fulfilled"; readonly value: T }
  | { readonly status: "rejected"; readonly reason: unknown };

function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  return promise.then(
    (value) => ({ status: "fulfilled" as const, value }),
    (reason: unknown) => ({ status: "rejected" as const, reason })
  );
}

function throwFirstRejected(results: readonly Settled<unknown>[]): void {
  for (const result of results) {
    if (result.status === "rejected") {
      throw result.reason;
    }
  }
}

function unwrapSettled<T>(result: Settled<T>): T {
  if (result.status === "rejected") {
    throw result.reason;
  }
  return result.value;
}

async function appendRecallCompletedEvent(
  context: RecallExecutionContext,
  params: RecallExecutionParams,
  _prepared: PreparedRecallRequest,
  coarse: CoarseStageResult,
  manifested: ManifestedRecallResult
): Promise<void> {
  await context.dependencies.eventLogRepo.append({
    event_type: RecallContextEventType.SOUL_RECALL_COMPLETED,
    entity_type: "task_object_surface",
    entity_id: params.taskSurface.runtime_id,
    workspace_id: params.workspaceId,
    run_id: params.runId ?? null,
    caused_by: "system",
    payload_json: SoulRecallCompletedPayloadSchema.parse({
      task_surface_ref: params.taskSurface.runtime_id,
      node_strategy: params.strategy,
      total_scanned: coarse.coarseFilter.total_scanned + coarse.globalCoarseFilter.total_scanned,
      coarse_filter_count: coarse.combinedCoarseCandidates.length,
      fine_assessment_count: manifested.candidates.length,
      workspace_id: params.workspaceId,
      occurred_at: context.now()
    })
  });
}
