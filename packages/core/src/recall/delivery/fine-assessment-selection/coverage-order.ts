import { buildFineAssessmentAnswerSupportContext } from
  "../answer-support/answer-support-context.js";
import {
  recallAnswerShapeSupportsSingleSemanticLeader,
  resolvePreparedAnswerShapePlan
} from "../../query/recall-answer-shape-plan.js";
import type {
  FineAssessmentCandidate,
  FineAssessmentSelectionContext,
  FineAssessmentSelectionParams
} from "./types.js";

export function createSelectionContext(
  params: FineAssessmentSelectionParams
): FineAssessmentSelectionContext {
  const answerRelevanceRankByCandidateKey =
    params.answerRelevanceRankByCandidateKey ?? new Map();
  const captureAnswerFeatures = params.captureAnswerFeatures ?? false;
  const answerShapePlan = resolvePreparedAnswerShapePlan(
    params.supplementaryData.queryProbes,
    params.answerShapePlan
  );
  const answerSupport = buildFineAssessmentAnswerSupportContext({
    candidates: params.orderedCandidates,
    supplementaryData: params.supplementaryData,
    captureObservations: captureAnswerFeatures,
    plan: answerShapePlan
  });
  return Object.freeze({
    config: params.config,
    supplementaryData: params.supplementaryData,
    tokenEstimator: params.tokenEstimator,
    rankByCandidateKey: params.rankByCandidateKey,
    finalRelevanceByCandidateKey: params.finalRelevanceByCandidateKey ?? new Map(),
    coverageRelevanceByCandidateKey:
      params.coverageRelevanceByCandidateKey ??
      params.finalRelevanceByCandidateKey ?? new Map(),
    coverageRelevanceUpperBound: params.coverageRelevanceUpperBound ?? null,
    answerRelevanceRankByCandidateKey,
    captureAnswerFeatures,
    answerShapePlan,
    supportsSingleSemanticLeader:
      recallAnswerShapeSupportsSingleSemanticLeader(answerShapePlan),
    answerSupportByCandidateKey: answerSupport.supportByCandidateKey,
    answerSupportObservationsByCandidateKey:
      answerSupport.observationsByCandidateKey,
    deepHeadTraceByCandidateKey: captureAnswerFeatures
      ? params.deepHeadTraceByCandidateKey ?? new Map()
      : new Map(),
    coverageMarginalGainByCandidateKey: new Map(),
    tokenEstimateByCandidateKey: new Map()
  });
}
