import { withEmbeddingSimilarityScores } from "../../coarse-filter/coarse-candidates.js";
import {
  deliverFineAssessment,
  prepareFineAssessment,
  prepareFineAssessmentWaist,
  type FineAssessParams,
  type FineAssessmentWaistParams
} from "../../delivery/fine-assessment.js";
import type { FineAssessmentPruneResult } from
  "../../delivery/fine-assessment-prune.js";
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
  readonly waist: FineAssessmentPruneResult;
  readonly assessmentSpans: readonly TimedSpan[];
  readonly deliverySpans: readonly TimedSpan[];
}>;

type RerankResult = Readonly<{
  readonly supplementaryData: FineAssessParams["supplementaryData"];
  readonly applied: boolean;
}>;

export type CollectedFineAssessmentData = Readonly<{
  readonly supplementaryData: FineAssessParams["supplementaryData"];
  readonly waist: FineAssessmentPruneResult;
}>;

export function prepareRecallFineAssessmentWaist(
  context: RecallExecutionContext,
  prepared: PreparedRecallRequest,
  coarse: CoarseStageResult
): FineAssessmentPruneResult {
  return prepareFineAssessmentWaist(
    buildFineAssessmentWaistParams(context, prepared, coarse)
  );
}

export function collectTimedSupplementaryData(
  context: RecallExecutionContext,
  params: RecallExecutionParams,
  prepared: PreparedRecallRequest,
  coarse: CoarseStageResult,
  waist: FineAssessmentPruneResult = prepareRecallFineAssessmentWaist(
    context, prepared, coarse
  )
): Promise<TimedResult<CollectedFineAssessmentData>> {
  return measureAsync(async () => {
    const supplementaryData = await collectCoarseFilterSupplementaryData(
      buildCoarseAssessmentParams(context, params, prepared, coarse, waist.survivors)
    );
    return Object.freeze({ supplementaryData, waist });
  });
}

export async function collectInitialLegacyAssessment(
  context: RecallExecutionContext,
  params: RecallExecutionParams,
  prepared: PreparedRecallRequest,
  coarse: CoarseStageResult,
  waist: FineAssessmentPruneResult
): Promise<LegacyInitialAssessment> {
  const collected = await collectTimedSupplementaryData(
    context, params, prepared, coarse, waist
  );
  const fineParams = buildFineAssessParams(
    context, params, prepared, collected.value.supplementaryData, collected.value.waist.survivors
  );
  const preparation = measureSync(() => prepareFineAssessment(
    fineParams,
    collected.value.waist
  ));
  const delivery = measureSync(() => deliverFineAssessment(fineParams, preparation.value));
  return Object.freeze({
    assessment: delivery.value,
    supplementaryData: collected.value.supplementaryData,
    waist: collected.value.waist,
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
    embeddingData.poolRescoreScores
  );
  const reassessmentRequired = needsEmbeddingReassessment(embeddingData, coarse);
  return Object.freeze({
    supplementaryData,
    reassessmentRequired,
    preparedCandidates: reassessmentRequired
      ? prepareFineAssessment(
        buildFineAssessParams(
          context, params, prepared, supplementaryData, initial.waist.survivors
        ),
        initial.waist
      )
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
    embeddingData.poolRescoreScores
  );
  return Object.freeze({
    supplementaryData,
    preparedCandidates: prepareFineAssessment(
      buildFineAssessParams(
        context, params, prepared, supplementaryData, base.waist.survivors
      ),
      base.waist
    )
  });
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
    captureAnswerFeatures: params.diagnosticCapture === "answer_features"
  };
}

function buildCoarseAssessmentParams(
  context: RecallExecutionContext,
  params: RecallExecutionParams,
  prepared: PreparedRecallRequest,
  coarse: CoarseStageResult,
  candidates: FineAssessmentWaistParams["candidates"]
): Parameters<typeof collectCoarseFilterSupplementaryData>[0] {
  return {
    dependencies: context.dependencies,
    warn: context.warn,
    now: () => prepared.referenceTime,
    coarseFilter: Object.freeze({ ...coarse.coarseFilter, candidates }),
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

function buildFineAssessmentWaistParams(
  context: RecallExecutionContext,
  prepared: PreparedRecallRequest,
  coarse: CoarseStageResult
): Parameters<typeof prepareFineAssessmentWaist>[0] {
  const snapshotScores = coarse.embeddingCoarseInjection.requestScoreSnapshot
    ?.poolScoresByObjectId ?? {};
  return {
    candidates: coarse.combinedCoarseCandidates,
    policy: prepared.policy,
    winnerMemoryIds: prepared.winnerMemoryIds,
    supplementaryData: {
      ftsRanks: coarse.coarseFilter.ftsRanks,
      trigramFtsRanks: coarse.coarseFilter.trigramFtsRanks,
      synthesisFtsRanks: coarse.coarseFilter.synthesisFtsRanks,
      evidenceFtsRanks: coarse.coarseFilter.evidenceFtsRanks,
      structuralScores: coarse.coarseFilter.structuralScores,
      embeddingSimilarityScores: Object.freeze({
        ...snapshotScores,
        ...coarse.embeddingCoarseInjection.similarityScores
      })
    },
    warn: context.warn
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
