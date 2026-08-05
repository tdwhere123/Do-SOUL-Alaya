import {
  materializeCoverageSelectionObjectiveReceipt,
  orderCoverageSelectionCandidateStatesByMarginalGain,
  type CoverageSelectionObjectiveReceipt
} from "../coverage-selection.js";
import { materializeConfiguredCoverageSelection } from
  "../../field/facility/selection-objective.js";
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
    coverageRelevanceByCandidateKey:
      params.coverageRelevanceByCandidateKey ??
      params.finalRelevanceByCandidateKey ?? new Map(),
    coverageRelevanceUpperBound: params.coverageRelevanceUpperBound ?? null,
    answerRelevanceRankByCandidateKey,
    captureAnswerFeatures,
    answerSupportByCandidateKey: answerSupport.supportByCandidateKey,
    answerSupportObservationsByCandidateKey:
      answerSupport.observationsByCandidateKey,
    deepHeadTraceByCandidateKey: captureAnswerFeatures
      ? params.deepHeadTraceByCandidateKey ?? new Map()
      : new Map(),
    coverageMarginalGainByCandidateKey: new Map(),
    tokenEstimateByCandidateKey: new Map(),
    coverageObjectiveConfig: params.coverageObjectiveConfig
  });
}

export function prepareCoverageSelection(
  params: FineAssessmentSelectionParams,
  context: FineAssessmentSelectionContext
): Readonly<{
  readonly candidates: readonly FineAssessmentCandidate[];
  readonly objective: CoverageSelectionObjectiveReceipt;
  readonly preparedSelection: ReturnType<
    typeof materializeConfiguredCoverageSelection<FineAssessmentCandidate>
  >;
}> {
  const preparedSelection = materializeConfiguredCoverageSelection({
    candidates: params.orderedCandidates,
    relevanceByCandidateKey: context.coverageRelevanceByCandidateKey,
    supplementaryData: context.supplementaryData,
    config: context.coverageObjectiveConfig
  });
  const candidates = orderFineAssessmentByCoverage(
    preparedSelection,
    context,
    context.captureAnswerFeatures
  );
  return Object.freeze({
    candidates,
    objective: materializeCoverageSelectionObjectiveReceipt(
      preparedSelection.objective
    ),
    preparedSelection
  });
}

function orderFineAssessmentByCoverage(
  prepared: ReturnType<
    typeof materializeConfiguredCoverageSelection<FineAssessmentCandidate>
  >,
  context: FineAssessmentSelectionContext,
  captureMarginalGain: boolean
): readonly FineAssessmentCandidate[] {
  const admission = createAdmissionState();
  return Object.freeze(orderCoverageSelectionCandidateStatesByMarginalGain({
    candidates: prepared.candidateStates,
    objective: prepared.objective,
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
  }).map(({ candidate }) => candidate));
}
