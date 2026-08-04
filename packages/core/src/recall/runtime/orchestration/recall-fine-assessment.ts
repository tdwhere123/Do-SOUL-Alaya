import { withEmbeddingSimilarityScores } from
  "../../coarse-filter/embedding/embedding-similarity-supplement.js";
import {
  deliverFineAssessment,
  prepareFineAssessment,
  type FineAssessParams
} from "../../delivery/fine-assessment.js";
import type { CoarseStageResult } from "../recall-service-runner-coarse.js";
import type {
  FineAssessmentPreparation,
  FineAssessmentResult,
  PreparedRecallRequest,
  RecallExecutionContext,
  RecallExecutionParams
} from "../recall-service-runner-types.js";
import { shouldCaptureRecallAnswerFeatures } from "../recall-service-runner-types.js";
import { collectCoarseFilterSupplementaryData } from "./coarse.js";
import type { EmbeddingAssessmentData } from "./recall-embedding-assessment.js";
import { attributeEvidenceSemanticWinners } from
  "./evidence-semantic-candidates.js";
import {
  asTimedSpan,
  instantTimedResult,
  measureAsync,
  measureSync,
  type TimedResult,
  type TimedSpan
} from "./recall-phase-latency.js";
import { recallFinalAuthorityMaxHeadDrop } from
  "../../../config/recall-env-access.js";

export type LegacyInitialAssessment = Readonly<{
  readonly assessment: FineAssessmentResult;
  readonly supplementaryData: FineAssessParams["supplementaryData"];
  readonly assessmentSpans: readonly TimedSpan[];
  readonly deliverySpans: readonly TimedSpan[];
}>;

type RerankResult = Readonly<{
  readonly supplementaryData: FineAssessParams["supplementaryData"];
  readonly applied: boolean;
}>;

export type CollectedFineAssessmentData = Readonly<{
  readonly supplementaryData: FineAssessParams["supplementaryData"];
}>;

export function collectTimedSupplementaryData(
  context: RecallExecutionContext,
  params: RecallExecutionParams,
  prepared: PreparedRecallRequest,
  coarse: CoarseStageResult
): Promise<TimedResult<CollectedFineAssessmentData>> {
  return measureAsync(async () => {
    const supplementaryData = await collectCoarseFilterSupplementaryData(
      buildCoarseAssessmentParams(
        context,
        params,
        prepared,
        coarse,
        coarse.combinedCoarseCandidates
      )
    );
    return Object.freeze({ supplementaryData });
  });
}

export async function collectInitialLegacyAssessment(
  context: RecallExecutionContext,
  params: RecallExecutionParams,
  prepared: PreparedRecallRequest,
  coarse: CoarseStageResult
): Promise<LegacyInitialAssessment> {
  const collected = await collectTimedSupplementaryData(context, params, prepared, coarse);
  const fineParams = buildFineAssessParams(
    context,
    params,
    prepared,
    collected.value.supplementaryData,
    coarse.combinedCoarseCandidates
  );
  const preparation = measureSync(() => prepareFineAssessment(fineParams));
  const delivery = measureSync(() => deliverFineAssessment(fineParams, preparation.value));
  return Object.freeze({
    assessment: delivery.value,
    supplementaryData: collected.value.supplementaryData,
    assessmentSpans: Object.freeze([asTimedSpan(collected), asTimedSpan(preparation)]),
    deliverySpans: Object.freeze([asTimedSpan(delivery)])
  });
}

function preparationFromAssessment(
  assessment: FineAssessmentResult
): FineAssessmentPreparation {
  return Object.freeze({
    candidates: assessment.preparedCandidates,
    prunedCandidates: assessment.prunedCandidates,
    coarsePoolSize: assessment.coarsePoolSize,
    fineEvaluated: assessment.fineEvaluated,
    finePrunedCount: assessment.finePrunedCount,
    finePriorityOverflowCount: assessment.finePriorityOverflowCount
  });
}

export function prepareLegacyReassessment(
  context: RecallExecutionContext,
  params: RecallExecutionParams,
  prepared: PreparedRecallRequest,
  coarse: CoarseStageResult,
  initial: LegacyInitialAssessment,
  embeddingData: EmbeddingAssessmentData
): Readonly<{
  readonly preparedCandidates: FineAssessmentPreparation;
  readonly supplementaryData: FineAssessParams["supplementaryData"];
  readonly reassessmentRequired: boolean;
}> {
  const supplementaryData = withEmbeddingSimilarityScores(
    initial.supplementaryData,
    embeddingData.supplement.similarityHintsByObjectId,
    coarse.embeddingCoarseInjection.similarityScores,
    embeddingData.poolRescoreScores,
    embeddingData.evidenceScoring.scores,
    attributedEvidenceWinners(initial.supplementaryData, embeddingData)
  );
  const reassessmentRequired = needsEmbeddingReassessment(embeddingData, coarse);
  return Object.freeze({
    supplementaryData,
    reassessmentRequired,
    preparedCandidates: reassessmentRequired
      ? prepareFineAssessment(buildFineAssessParams(
        context,
        params,
        prepared,
        supplementaryData,
        coarse.combinedCoarseCandidates
      ))
      : preparationFromAssessment(initial.assessment)
  });
}

export function prepareSnapshotAssessment(
  context: RecallExecutionContext,
  params: RecallExecutionParams,
  prepared: PreparedRecallRequest,
  coarse: CoarseStageResult,
  base: CollectedFineAssessmentData,
  embeddingData: EmbeddingAssessmentData
): Readonly<{
  readonly preparedCandidates: FineAssessmentPreparation;
  readonly supplementaryData: FineAssessParams["supplementaryData"];
}> {
  const supplementaryData = withEmbeddingSimilarityScores(
    base.supplementaryData,
    embeddingData.supplement.similarityHintsByObjectId,
    coarse.embeddingCoarseInjection.similarityScores,
    embeddingData.poolRescoreScores,
    embeddingData.evidenceScoring.scores,
    attributedEvidenceWinners(base.supplementaryData, embeddingData)
  );
  return Object.freeze({
    supplementaryData,
    preparedCandidates: prepareFineAssessment(buildFineAssessParams(
      context,
      params,
      prepared,
      supplementaryData,
      coarse.combinedCoarseCandidates
    ))
  });
}

function attributedEvidenceWinners(
  supplementaryData: FineAssessParams["supplementaryData"],
  embeddingData: EmbeddingAssessmentData
) {
  const winners = embeddingData.evidenceScoring.winnersByCandidateKey;
  if (winners.size === 0) return undefined;
  const attributed = attributeEvidenceSemanticWinners({
    winners,
    evidenceDocumentsByMemoryId:
      supplementaryData.evidenceSemanticDocumentsByMemoryId ?? {}
  });
  return attributed.size === 0 ? undefined : attributed;
}

export function deliverOrReuseAssessment(
  context: RecallExecutionContext,
  params: RecallExecutionParams,
  prepared: PreparedRecallRequest,
  preparedCandidates: FineAssessmentPreparation,
  rerank: RerankResult,
  reusableAssessment?: FineAssessmentResult
): TimedResult<FineAssessmentResult> {
  if (!rerank.applied && reusableAssessment !== undefined) {
    return instantTimedResult(reusableAssessment);
  }
  return measureSync(() => deliverFineAssessment(
    buildFineAssessParams(
      context, params, prepared, rerank.supplementaryData, preparedCandidates.candidates
    ),
    preparedCandidates
  ));
}

function buildFineAssessParams(
  context: RecallExecutionContext,
  params: RecallExecutionParams,
  prepared: PreparedRecallRequest,
  supplementaryData: FineAssessParams["supplementaryData"],
  candidates: FineAssessParams["candidates"]
): FineAssessParams {
  return {
    candidates,
    policy: prepared.policy,
    winnerMemoryIds: prepared.winnerMemoryIds,
    supplementaryData,
    tokenEstimator: prepared.tokenEstimator,
    now: () => prepared.referenceTime,
    warn: context.warn,
    captureAnswerFeatures: shouldCaptureRecallAnswerFeatures(params),
    capturePacketPlanTrace: params.diagnosticCapture === "packet_trace",
    finalAuthorityMaxHeadDrop: recallFinalAuthorityMaxHeadDrop(),
    selectionBoundaryObserver: params.selectionBoundaryObserver
  };
}

function buildCoarseAssessmentParams(
  context: RecallExecutionContext,
  params: RecallExecutionParams,
  prepared: PreparedRecallRequest,
  coarse: CoarseStageResult,
  candidates: FineAssessParams["candidates"]
): Parameters<typeof collectCoarseFilterSupplementaryData>[0] {
  return {
    dependencies: context.dependencies,
    warn: context.warn,
    now: () => prepared.referenceTime,
    coarseFilter: Object.freeze({ ...coarse.coarseFilter, candidates }),
    workspaceId: params.workspaceId,
    pathProjectionAsOf: prepared.temporalProjectionAsOf,
    runId: params.runId ?? null,
    queryText: prepared.queryText,
    policy: prepared.policy,
    queryProbes: prepared.queryProbes,
    winnerMemoryIds: prepared.winnerMemoryIds,
    tokenEstimator: prepared.tokenEstimator,
    captureAnswerFeatures: shouldCaptureRecallAnswerFeatures(params)
  };
}

function needsEmbeddingReassessment(
  embeddingData: EmbeddingAssessmentData,
  coarse: CoarseStageResult
): boolean {
  return Object.keys(embeddingData.supplement.similarityHintsByObjectId).length > 0 ||
    coarse.embeddingCoarseInjection.candidates.length > 0 ||
    Object.keys(embeddingData.poolRescoreScores).length > 0 ||
    embeddingData.evidenceScoring.scores.size > 0;
}
