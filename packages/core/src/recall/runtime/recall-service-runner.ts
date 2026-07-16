import {
  RecallContextEventType,
  SoulRecallCompletedPayloadSchema,
  type RecallPolicy
} from "@do-soul/alaya-protocol";
import type { FineAssessParams } from "../delivery/fine-assessment.js";
import {
  applyManifestationBiasSidecar,
  appendWeightTransferTelemetry,
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
  CoarseRecallCandidate,
  RecallDegradationReason,
  RecallEmbeddingProviderStatus,
  RecallResult,
  RecallServiceDependencies
} from "./recall-service-types.js";
import { makeTokenEstimator } from "./recall-service-types.js";
import {
  collectCoarseStage,
  type CoarseStageResult,
  type EmbeddingCoarseInjectionResult
} from "./recall-service-runner-coarse.js";
import {
  collectLegacyEmbeddingAssessmentData,
  collectSnapshotEmbeddingAssessmentData,
  startEmbeddingAssessmentPreparation,
  type EmbeddingAssessmentData
} from "./orchestration/recall-embedding-assessment.js";
import { collectAnswerRelevanceScores } from "../rerank/recall-answer-rerank.js";
import { buildRecallResult } from "./recall-result-builder.js";
import {
  collectInitialLegacyAssessment,
  collectTimedSupplementaryData,
  deliverOrReuseAssessment,
  prepareLegacyReassessment,
  prepareRecallFineAssessmentWaist,
  prepareSnapshotAssessment
} from "./orchestration/recall-fine-assessment.js";
import {
  measureAsync,
  measureSync,
  sumLatencyExcluding
} from "./orchestration/recall-phase-latency.js";
import type {
  FineAssessmentResult,
  FineAssessmentPreparation,
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
type AssessmentPhaseSeed = Readonly<{
  readonly embedding: number;
  readonly assessment: number;
  readonly delivery: number;
}>;

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
  if (coarse.embeddingCoarseInjection.requestScoreSnapshot !== undefined) {
    return assessSnapshotCandidateStage(context, params, prepared, coarse);
  }
  return assessLegacyCandidateStage(context, params, prepared, coarse);
}

async function assessLegacyCandidateStage(
  context: RecallExecutionContext,
  params: RecallExecutionParams,
  prepared: PreparedRecallRequest,
  coarse: CoarseStageResult
): Promise<AssessmentStageResult> {
  const waist = prepareRecallFineAssessmentWaist(context, prepared, coarse);
  const embeddingPreparation = startLegacyEmbeddingPreparation(
    context, params, prepared, coarse, waist.survivors
  );
  const initial = await collectInitialLegacyAssessment(
    context, params, prepared, coarse, waist
  );
  const preparedEmbeddingQuery = await embeddingPreparation;
  const embedding = await measureAsync(() => collectLegacyEmbeddingAssessmentData(
    context,
    params,
    prepared,
    coarse,
    initial.assessment,
    initial.waist.survivors,
    preparedEmbeddingQuery.value
  ));
  const reassessment = measureSync(() => prepareLegacyReassessment(
    context, params, prepared, coarse, initial, embedding.value
  ));
  const initialAssessmentLatencyMs = sumLatencyExcluding(
    initial.assessmentSpans, preparedEmbeddingQuery
  );
  const initialDeliveryLatencyMs = sumLatencyExcluding(
    initial.deliverySpans, preparedEmbeddingQuery
  );
  return completeCandidateAssessment(
    context,
    params,
    prepared,
    coarse,
    reassessment.value.preparedCandidates,
    reassessment.value.supplementaryData,
    embedding.value,
    Object.freeze({
      embedding: preparedEmbeddingQuery.latencyMs + embedding.latencyMs,
      assessment: initialAssessmentLatencyMs + reassessment.latencyMs,
      delivery: initialDeliveryLatencyMs
    }),
    reassessment.value.reassessmentRequired ? undefined : initial.assessment
  );
}

function startLegacyEmbeddingPreparation(
  context: RecallExecutionContext,
  params: RecallExecutionParams,
  prepared: PreparedRecallRequest,
  coarse: CoarseStageResult,
  fineCandidates: readonly Readonly<CoarseRecallCandidate>[]
) {
  return measureAsync(() => {
    const pending = startEmbeddingAssessmentPreparation(
      context, params, prepared, coarse, fineCandidates
    );
    if (pending === null) {
      throw new Error("legacy embedding preparation is unavailable");
    }
    return pending;
  });
}

async function assessSnapshotCandidateStage(
  context: RecallExecutionContext,
  params: RecallExecutionParams,
  prepared: PreparedRecallRequest,
  coarse: CoarseStageResult
): Promise<AssessmentStageResult> {
  const base = await collectTimedSupplementaryData(context, params, prepared, coarse);
  const embedding = await measureAsync(() => collectSnapshotEmbeddingAssessmentData(
    context, prepared, coarse, base.value.waist.survivors
  ));
  const assessment = measureSync(() => prepareSnapshotAssessment(
    context, params, prepared, coarse, base.value, embedding.value
  ));
  return completeCandidateAssessment(
    context,
    params,
    prepared,
    coarse,
    assessment.value.preparedCandidates,
    assessment.value.supplementaryData,
    embedding.value,
    Object.freeze({
      embedding: embedding.latencyMs,
      assessment: base.latencyMs + assessment.latencyMs,
      delivery: 0
    })
  );
}

async function completeCandidateAssessment(
  context: RecallExecutionContext,
  params: RecallExecutionParams,
  prepared: PreparedRecallRequest,
  coarse: CoarseStageResult,
  preparedCandidates: FineAssessmentPreparation,
  supplementaryData: FineAssessParams["supplementaryData"],
  embeddingData: EmbeddingAssessmentData,
  phaseLatency: AssessmentPhaseSeed,
  reusableAssessment?: FineAssessmentResult
): Promise<AssessmentStageResult> {
  const { preparedEmbeddingQuery } = embeddingData;
  const rerank = await measureAsync(() => collectAnswerRerankStage(
    context, prepared, preparedCandidates, supplementaryData
  ));
  const delivery = deliverOrReuseAssessment(
    context, params, prepared, preparedCandidates, rerank.value, reusableAssessment
  );
  const provider = resolveEmbeddingProvider(prepared.policy, preparedEmbeddingQuery, coarse.embeddingCoarseInjection);
  return Object.freeze({
    finalAssessment: delivery.value,
    supplementaryData: rerank.value.supplementaryData,
    preparedEmbeddingQuery,
    embeddingCoarseInjection: coarse.embeddingCoarseInjection,
    embeddingProviderStatus: provider.status,
    providerDegradationReason: provider.degradationReason,
    answerRerankDiagnostics: rerank.value.diagnostics,
    phaseLatencyMs: Object.freeze({
      embedding: phaseLatency.embedding,
      assessment: phaseLatency.assessment,
      cross_rerank: rerank.latencyMs,
      delivery: phaseLatency.delivery + delivery.latencyMs
    })
  });
}

async function collectAnswerRerankStage(
  context: RecallExecutionContext,
  prepared: PreparedRecallRequest,
  preparedCandidates: FineAssessmentPreparation,
  supplementaryData: FineAssessParams["supplementaryData"]
): Promise<Readonly<{
  readonly supplementaryData: FineAssessParams["supplementaryData"];
  readonly diagnostics: AssessmentStageResult["answerRerankDiagnostics"];
  readonly applied: boolean;
}>> {
  const rerank = await collectAnswerRelevanceScores({
    service: context.dependencies.answerRerankService,
    queryText: prepared.queryText,
    candidates: preparedCandidates.candidates,
    maxEntries: prepared.policy.fine_assessment.budgets.max_entries,
    warn: context.warn
  });
  if (rerank.scores.size === 0) {
    return Object.freeze({ supplementaryData, diagnostics: rerank.diagnostics, applied: false });
  }
  const rerankedData = Object.freeze({
    ...supplementaryData,
    answerRelevanceScoresByCandidateKey: rerank.scores
  });
  return Object.freeze({
    supplementaryData: rerankedData,
    diagnostics: rerank.diagnostics,
    applied: true
  });
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
  const manifested = await measureAsync(async () => {
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
      candidateDiagnostics: finalizeRecallCandidateDiagnostics(
        finalAssessment.diagnostics, candidates
      )
    });
  });
  return Object.freeze({
    ...manifested.value,
    manifestationLatencyMs: manifested.latencyMs
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
