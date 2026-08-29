import { performance } from "node:perf_hooks";
import {
  RecallContextEventType,
  SoulRecallCompletedPayloadSchema,
  type RecallPolicy
} from "@do-soul/alaya-protocol";
import { fineAssess, type FineAssessParams } from "../delivery/fine-assessment.js";
import { captureSupportSetPacketPlanTrace } from
  "../delivery/packet-plan/packet-plan-trace.js";
import {
  applyManifestationBiasSidecar,
  appendWeightTransferTelemetry,
  recordGlobalRecallClassificationsSafely
} from "./orchestration.js";
import {
  EMPTY_RECALL_CANDIDATE_DIAGNOSTICS,
  finalizeRecallCandidateDiagnostics,
  resolveEmbeddingProviderDegradationReason,
  resolveEmbeddingProviderStatus
} from "./diagnostics.js";
import type {
  CoarseRecallCandidate,
  RecallDegradationReason,
  RecallEmbeddingProviderStatus,
  RecallResult
} from "./recall-service-types.js";
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
import { addRecallExecutionPhaseLatencies, buildRecallResult } from
  "./recall-result-builder.js";
import {
  buildFineAssessParams,
  collectTimedSupplementaryData,
  deliverOrReuseAssessment,
  prepareAssessmentAfterEmbedding
} from "./orchestration/recall-fine-assessment.js";
import {
  instantTimedResult,
  measureAsync,
  measureSync
} from "./orchestration/recall-phase-latency.js";
import { finishProjectionPinCleanup } from "./query/projection-pin-lease.js";
import { withRetrievalFieldReadAuthority } from "../field/retrieval/retrieval-field-source-authority.js";
import { prepareRecallRequest } from "./query/prepare-recall-request.js";
import { captureRecallRequestTime } from "./query/recall-request-time.js";
import { applySelectGammaSynthesis } from
  "../delivery/select-gamma/synthesis-adapter.js";
import {
  capturesRecallAnswerFeatures,
  type FineAssessmentResult,
  type PreparedEmbeddingQuery,
  type PreparedRecallRequest,
  type RecallAssessmentStageResult,
  type RecallExecutionContext,
  type RecallExecutionParams,
  type RecallManifestedResult
} from "./recall-service-runner-types.js";

export type { RecallExecutionContext, RecallExecutionParams, PreparedRecallRequest } from "./recall-service-runner-types.js";
type AssessmentStageResult = RecallAssessmentStageResult;
type ManifestedRecallResult = RecallManifestedResult;
type PreparedRecallOutcome = Readonly<{
  readonly coarse: CoarseStageResult;
  readonly assessment: AssessmentStageResult;
  readonly manifested: ManifestedRecallResult;
  readonly synthesis: Awaited<ReturnType<typeof applySelectGammaSynthesis>>;
  readonly selectGammaSynthesisLatencyMs: number;
}>;
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
  const executionStartedAt = performance.now();
  const preparation = await prepareRecallExecution(context, params);
  const { degradationReasons, executionContext, time, prepared } = preparation.value;
  let outcome: PreparedRecallOutcome;
  let outcomeElapsedMs: number;
  try {
    const collectedOutcome = await withRetrievalFieldReadAuthority(
      executionContext.readSnapshot,
      prepared.retrievalFieldBundle, prepared.snapshotReadLease,
      () => measureAsync(() => collectPreparedRecallOutcome(executionContext, params, prepared))
    );
    outcome = collectedOutcome.value;
    outcomeElapsedMs = collectedOutcome.latencyMs;
  } catch (error) {
    finishProjectionPinAfterFailure(prepared, executionContext.warn, error);
  }
  finishPreparedProjectionPin(prepared, executionContext.warn);
  const resultBuild = measureSync(() => buildRecallResult(
    prepared, outcome.coarse, outcome.assessment, outcome.manifested,
    degradationReasons, outcome.synthesis.synthesis,
    capturesRecallAnswerFeatures(params.diagnosticCapture)
  ));
  const sideEffects = await measureAsync(() => recordRecallSideEffects(
    executionContext, params, outcome.coarse, outcome.assessment,
    outcome.manifested, time.captureOperationalTime()
  ));
  return addRecallExecutionPhaseLatencies(
    resultBuild.value,
    {
      preparation: preparation.latencyMs,
      select_gamma_synthesis: outcome.selectGammaSynthesisLatencyMs,
      result_build: resultBuild.latencyMs,
      side_effects: sideEffects.latencyMs
    },
    Math.max(0, performance.now() - executionStartedAt),
    Math.max(0, outcomeElapsedMs - outcome.selectGammaSynthesisLatencyMs)
  );
}

async function prepareRecallExecution(context: RecallExecutionContext, params: RecallExecutionParams) {
  return measureAsync(async () => {
    const degradationReasons = new Set<RecallDegradationReason>();
    const executionContext = Object.freeze({ ...context, degradationReasons });
    const time = captureRecallRequestTime({
      explicitAsOf: params.referenceTime,
      now: executionContext.now
    });
    const prepared = await prepareRecallRequest(executionContext, params, time);
    return Object.freeze({ degradationReasons, executionContext, time, prepared });
  });
}
async function collectPreparedRecallOutcome(
  context: RecallExecutionContext,
  params: RecallExecutionParams,
  prepared: PreparedRecallRequest
): Promise<PreparedRecallOutcome> {
  const coarse = await collectCoarseStage(context, params, prepared);
  prepared.projectionPinLease.assertHealthy();
  const assessment = await assessCandidateStage(context, params, prepared, coarse);
  prepared.projectionPinLease.assertHealthy();
  const synthesis = await measureAsync(() => applySelectGammaSynthesis({
    workspace_id: params.workspaceId,
    run_id: params.runId ?? null,
    query_text: prepared.queryText,
    selected_evidence: assessment.finalAssessment.candidates,
    port: context.dependencies.selectGammaSynthesisPort
  }));
  prepared.projectionPinLease.assertHealthy();
  const manifested = await manifestCandidateStage(
    context,
    params,
    synthesis.value.selected_evidence,
    assessment.finalAssessment.diagnostics,
    assessment.finalAssessment.capture_receipt
  );
  prepared.projectionPinLease.assertHealthy();
  return Object.freeze({
    coarse,
    assessment,
    manifested,
    synthesis: synthesis.value,
    selectGammaSynthesisLatencyMs: synthesis.latencyMs
  });
}

function finishPreparedProjectionPin(
  prepared: PreparedRecallRequest,
  warn: RecallExecutionContext["warn"]
): void {
  finishProjectionPinCleanup([
    () => prepared.projectionPinLease.stop(),
    prepared.releaseProjectionPin
  ], warn);
}

function finishProjectionPinAfterFailure(
  prepared: PreparedRecallRequest,
  warn: RecallExecutionContext["warn"],
  primaryFailure: unknown
): never {
  try {
    finishPreparedProjectionPin(prepared, warn);
  } catch (cleanupError) {
    const message = primaryFailure instanceof Error
      ? primaryFailure.message
      : String(primaryFailure);
    throw new AggregateError(
      [primaryFailure, cleanupError],
      `recall execution failed: ${message}`,
      { cause: primaryFailure }
    );
  }
  throw primaryFailure;
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
  const embeddingPreparation = startLegacyEmbeddingPreparation(
    context, params, prepared, coarse, coarse.combinedCoarseCandidates
  );
  const base = await collectTimedSupplementaryData(context, params, prepared, coarse);
  const preparedEmbeddingQuery = await embeddingPreparation;
  const embedding = await measureAsync(() => collectLegacyEmbeddingAssessmentData(
    context,
    params,
    prepared,
    coarse,
    base.value.supplementaryData.evidenceSemanticDocumentsByMemoryId ?? {},
    coarse.combinedCoarseCandidates,
    preparedEmbeddingQuery.value
  ));
  return completeCandidateAssessment(
    context,
    params,
    prepared,
    coarse,
    prepareAssessmentAfterEmbedding(
      context, params, prepared, coarse, base.value, embedding.value
    ),
    embedding.value,
    Object.freeze({
      embedding: preparedEmbeddingQuery.latencyMs + embedding.latencyMs,
      assessment: base.latencyMs,
      delivery: 0
    }),
    "legacy"
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
    context,
    prepared,
    coarse,
    coarse.combinedCoarseCandidates,
    base.value.supplementaryData.evidenceSemanticDocumentsByMemoryId ?? {}
  ));
  return completeCandidateAssessment(
    context,
    params,
    prepared,
    coarse,
    prepareAssessmentAfterEmbedding(
      context, params, prepared, coarse, base.value, embedding.value
    ),
    embedding.value,
    Object.freeze({
      embedding: embedding.latencyMs,
      assessment: base.latencyMs,
      delivery: 0
    }),
    "snapshot"
  );
}

async function completeCandidateAssessment(
  context: RecallExecutionContext,
  params: RecallExecutionParams,
  prepared: PreparedRecallRequest,
  coarse: CoarseStageResult,
  assessment: ReturnType<typeof prepareAssessmentAfterEmbedding>,
  embeddingData: EmbeddingAssessmentData,
  phaseLatency: AssessmentPhaseSeed,
  assessmentPath: "legacy" | "snapshot"
): Promise<AssessmentStageResult> {
  const { preparedEmbeddingQuery } = embeddingData;
  const preparedCandidates = assessment.preparedCandidates;
  const rerank = instantTimedResult(collectAnswerRerankStage(assessment.supplementaryData));
  const delivery = preparedCandidates === null
    ? measureSync(() => fineAssess(buildFineAssessParams(
      context,
      params,
      prepared,
      assessment.supplementaryData,
      coarse.combinedCoarseCandidates,
      { e0Keys: coarse.e0CandidateKeys }
    )))
    : deliverOrReuseAssessment(
      context, params, prepared, preparedCandidates, rerank.value
    );
  const provider = resolveEmbeddingProvider(prepared.policy, preparedEmbeddingQuery, coarse.embeddingCoarseInjection);
  if (embeddingData.evidenceScoring.status === "failed") {
    context.degradationReasons?.add("evidence_candidate_embedding_failed");
  }
  const packetPlanTrace = captureAssessmentPacketPlanTrace(
    context, assessmentPath, delivery.value.packetPlanObservation
  );
  return Object.freeze({
    finalAssessment: delivery.value,
    supplementaryData: rerank.value.supplementaryData,
    preparedEmbeddingQuery,
    embeddingCoarseInjection: coarse.embeddingCoarseInjection,
    embeddingProviderStatus: provider.status,
    embeddingSupplementStatus: embeddingData.supplement.collectionStatus,
    evidenceEmbeddingScoring: embeddingData.evidenceScoring,
    retrievalFieldCaptures: embeddingData.retrievalFieldCaptures,
    providerDegradationReason: provider.degradationReason,
    answerRerankDiagnostics: rerank.value.diagnostics,
    ...(packetPlanTrace === undefined ? {} : { packetPlanTrace }),
    phaseLatencyMs: Object.freeze({
      embedding: phaseLatency.embedding,
      assessment: phaseLatency.assessment + assessment.assessmentLatencyMs,
      cross_rerank: preparedCandidates === null ? 0 : rerank.latencyMs,
      delivery: phaseLatency.delivery + delivery.latencyMs
    })
  });
}

function captureAssessmentPacketPlanTrace(
  context: RecallExecutionContext,
  assessmentPath: "legacy" | "snapshot",
  observation: FineAssessmentResult["packetPlanObservation"]
) {
  if (observation === undefined) return undefined;
  const capture = captureSupportSetPacketPlanTrace(assessmentPath, observation);
  if (capture.status === "captured") return capture.trace;
  context.degradationReasons?.add("packet_plan_trace_capture_failed");
  context.warn("recall packet plan trace capture failed", capture.failure);
  return undefined;
}

function collectAnswerRerankStage(
  supplementaryData: FineAssessParams["supplementaryData"]
): Readonly<{
  readonly supplementaryData: FineAssessParams["supplementaryData"];
  readonly diagnostics: AssessmentStageResult["answerRerankDiagnostics"];
  readonly applied: boolean;
}> {
  return Object.freeze({
    supplementaryData,
    diagnostics: Object.freeze({
      status: "not_requested" as const,
      expected_count: 0,
      scored_count: 0,
      failure_class: null
    }),
    applied: false
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
  selectedCandidates: FineAssessmentResult["candidates"],
  selectedDiagnostics: FineAssessmentResult["diagnostics"],
  captureReceipt: FineAssessmentResult["capture_receipt"]
): Promise<ManifestedRecallResult> {
  const manifested = await measureAsync(async () => {
    const candidates = await applyManifestationBiasSidecar({
      manifestationSidecarPort: context.dependencies.manifestationSidecarPort,
      warn: context.warn,
      workspaceId: params.workspaceId,
      runId: params.runId ?? null,
      taskSurfaceRef: params.taskSurface,
      candidates: selectedCandidates
    });
    return Object.freeze({
      candidates,
      candidateDiagnostics: capturesRecallAnswerFeatures(params.diagnosticCapture)
        ? finalizeRecallCandidateDiagnostics(selectedDiagnostics, candidates, captureReceipt)
        : EMPTY_RECALL_CANDIDATE_DIAGNOSTICS
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
  coarse: CoarseStageResult,
  assessment: AssessmentStageResult,
  manifested: ManifestedRecallResult,
  completedAt: string
): Promise<void> {
  await appendRecallCompletedEvent(
    params, coarse, manifested, completedAt, context, assessment
  );
  await Promise.all([
    appendWeightTransferTelemetry({
      eventLogRepo: context.dependencies.eventLogRepo,
      warn: context.warn,
      now: () => completedAt,
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
  params: RecallExecutionParams,
  coarse: CoarseStageResult,
  manifested: ManifestedRecallResult,
  completedAt: string,
  context: RecallExecutionContext,
  assessment: AssessmentStageResult
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
      occurred_at: completedAt,
      delivery_path: assessment.finalAssessment.delivery_path,
      ranking_authority: assessment.finalAssessment.ranking_authority,
      ...(assessment.finalAssessment.capture_execution === undefined
        ? {}
        : { capture_execution: assessment.finalAssessment.capture_execution }),
      ...(assessment.finalAssessment.capture_identity === undefined
        ? {}
        : { capture_identity: assessment.finalAssessment.capture_identity })
    })
  });
}
