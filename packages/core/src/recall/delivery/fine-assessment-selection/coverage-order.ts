import { orderByCoverageMarginalGain } from "../coverage-selection.js";
import { buildFineAssessmentAnswerSupportContext } from
  "../answer-support/answer-support-context.js";
import {
  createAdmissionState,
  tryRecordAcceptedAdmission
} from "./admission.js";
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
  const answerSupport = buildFineAssessmentAnswerSupportContext({
    candidates: params.orderedCandidates,
    supplementaryData: params.supplementaryData,
    captureObservations: captureAnswerFeatures
  });
  return Object.freeze({
    config: params.config,
    supplementaryData: params.supplementaryData,
    tokenEstimator: params.tokenEstimator,
    rankByCandidateKey: params.rankByCandidateKey,
    finalRelevanceByCandidateKey: params.finalRelevanceByCandidateKey ?? new Map(),
    answerRelevanceRankByCandidateKey,
    captureAnswerFeatures,
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

export function prepareCoverageSelection(
  params: FineAssessmentSelectionParams,
  context: FineAssessmentSelectionContext
): readonly FineAssessmentCandidate[] {
  const coverageRelevance =
    params.coverageRelevanceByCandidateKey ?? context.finalRelevanceByCandidateKey;
  return orderFineAssessmentByCoverage(
    params.orderedCandidates,
    context,
    coverageRelevance,
    context.captureAnswerFeatures
  );
}

function orderFineAssessmentByCoverage(
  candidates: readonly FineAssessmentCandidate[],
  context: FineAssessmentSelectionContext,
  relevanceByCandidateKey: ReadonlyMap<string, number>,
  captureMarginalGain = false
): readonly FineAssessmentCandidate[] {
  const admission = createAdmissionState();
  return orderByCoverageMarginalGain({
    candidates,
    relevanceByCandidateKey,
    supplementaryData: context.supplementaryData,
    advancesCoverage: (candidate) => tryRecordAcceptedAdmission(
      admission,
      candidate,
      context
    ),
    onSelection: captureMarginalGain
      ? (observation) => context.coverageMarginalGainByCandidateKey.set(
          observation.candidate_key,
          observation.marginal_gain
        )
      : undefined
  });
}
