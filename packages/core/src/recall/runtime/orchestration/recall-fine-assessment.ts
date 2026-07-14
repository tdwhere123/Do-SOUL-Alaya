import { withEmbeddingSimilarityScores } from "../../coarse-filter/coarse-candidates.js";
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
import { collectCoarseFilterSupplementaryData } from "./coarse.js";
import type { EmbeddingAssessmentData } from "./recall-embedding-assessment.js";
import {
  asTimedSpan,
  instantTimedResult,
  measureAsync,
  measureSync,
  type TimedResult,
  type TimedSpan
} from "./recall-phase-latency.js";

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

export function collectTimedSupplementaryData(
  context: RecallExecutionContext,
  params: RecallExecutionParams,
  prepared: PreparedRecallRequest,
  coarse: CoarseStageResult
): Promise<TimedResult<FineAssessParams["supplementaryData"]>> {
  return measureAsync(() => collectCoarseFilterSupplementaryData(
    buildCoarseAssessmentParams(context, params, prepared, coarse)
  ));
}

export async function collectInitialLegacyAssessment(
  context: RecallExecutionContext,
  params: RecallExecutionParams,
  prepared: PreparedRecallRequest,
  coarse: CoarseStageResult
): Promise<LegacyInitialAssessment> {
  const supplementary = await collectTimedSupplementaryData(context, params, prepared, coarse);
  const fineParams = buildFineAssessParams(
    context, params, prepared, coarse, supplementary.value
  );
  const preparation = measureSync(() => prepareFineAssessment(fineParams));
  const delivery = measureSync(() => deliverFineAssessment(fineParams, preparation.value));
  return Object.freeze({
    assessment: delivery.value,
    supplementaryData: supplementary.value,
    assessmentSpans: Object.freeze([asTimedSpan(supplementary), asTimedSpan(preparation)]),
    deliverySpans: Object.freeze([asTimedSpan(delivery)])
  });
}

function preparationFromAssessment(
  assessment: FineAssessmentResult
): FineAssessmentPreparation {
  return Object.freeze({
    candidates: assessment.preparedCandidates,
    coarsePoolSize: assessment.coarsePoolSize,
    fineEvaluated: assessment.fineEvaluated,
    finePrunedCount: assessment.finePrunedCount
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
    embeddingData.poolRescoreScores
  );
  const reassessmentRequired = needsEmbeddingReassessment(embeddingData, coarse);
  return Object.freeze({
    supplementaryData,
    reassessmentRequired,
    preparedCandidates: reassessmentRequired
      ? prepareFineAssessment(buildFineAssessParams(context, params, prepared, coarse, supplementaryData))
      : preparationFromAssessment(initial.assessment)
  });
}

export function prepareSnapshotAssessment(
  context: RecallExecutionContext,
  params: RecallExecutionParams,
  prepared: PreparedRecallRequest,
  coarse: CoarseStageResult,
  baseSupplementaryData: FineAssessParams["supplementaryData"],
  embeddingData: EmbeddingAssessmentData
): Readonly<{
  readonly preparedCandidates: FineAssessmentPreparation;
  readonly supplementaryData: FineAssessParams["supplementaryData"];
}> {
  const supplementaryData = withEmbeddingSimilarityScores(
    baseSupplementaryData,
    embeddingData.supplement.similarityHintsByObjectId,
    coarse.embeddingCoarseInjection.similarityScores,
    embeddingData.poolRescoreScores
  );
  return Object.freeze({
    supplementaryData,
    preparedCandidates: prepareFineAssessment(
      buildFineAssessParams(context, params, prepared, coarse, supplementaryData)
    )
  });
}

export function deliverOrReuseAssessment(
  context: RecallExecutionContext,
  params: RecallExecutionParams,
  prepared: PreparedRecallRequest,
  coarse: CoarseStageResult,
  preparedCandidates: FineAssessmentPreparation,
  rerank: RerankResult,
  reusableAssessment?: FineAssessmentResult
): TimedResult<FineAssessmentResult> {
  if (!rerank.applied && reusableAssessment !== undefined) {
    return instantTimedResult(reusableAssessment);
  }
  return measureSync(() => deliverFineAssessment(
    buildFineAssessParams(context, params, prepared, coarse, rerank.supplementaryData),
    preparedCandidates
  ));
}

function buildFineAssessParams(
  context: RecallExecutionContext,
  params: RecallExecutionParams,
  prepared: PreparedRecallRequest,
  coarse: CoarseStageResult,
  supplementaryData: FineAssessParams["supplementaryData"]
): FineAssessParams {
  return {
    candidates: coarse.combinedCoarseCandidates,
    policy: prepared.policy,
    winnerMemoryIds: prepared.winnerMemoryIds,
    supplementaryData,
    tokenEstimator: prepared.tokenEstimator,
    now: () => prepared.referenceTime,
    warn: context.warn,
    captureAnswerFeatures: params.diagnosticCapture === "answer_features"
  };
}

function buildCoarseAssessmentParams(
  context: RecallExecutionContext,
  params: RecallExecutionParams,
  prepared: PreparedRecallRequest,
  coarse: CoarseStageResult
): Parameters<typeof collectCoarseFilterSupplementaryData>[0] {
  return {
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
  };
}

function needsEmbeddingReassessment(
  embeddingData: EmbeddingAssessmentData,
  coarse: CoarseStageResult
): boolean {
  return Object.keys(embeddingData.supplement.similarityHintsByObjectId).length > 0 ||
    coarse.embeddingCoarseInjection.candidates.length > 0 ||
    Object.keys(embeddingData.poolRescoreScores).length > 0;
}
