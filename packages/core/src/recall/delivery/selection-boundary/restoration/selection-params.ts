import type { RecallSupplementaryData } from
  "../../../runtime/recall-service-types.js";
import type { FineAssessmentSelectionParams } from
  "../../fine-assessment-selection.js";
import type {
  FineAssessmentSelectionBoundaryInput,
  SelectionBoundaryNumberMap,
  SerializedRecallSupplementaryData
} from "../selection-boundary-types.js";
import { restoreSemanticActivations } from
  "../validation/evidence-semantic-receipt.js";
import { throwSelectionBoundaryFidelityMismatch } from
  "../validation/fidelity-error.js";
import { restoreCapturedPacketCandidates } from
  "../validation/packet-order.js";

export function restoreSelectionParams(
  input: FineAssessmentSelectionBoundaryInput
): FineAssessmentSelectionParams {
  return {
    orderedCandidates: input.ordered_candidates,
    packetCandidates: restoreCapturedPacketCandidates(input),
    config: input.config,
    supplementaryData: restoreSupplementaryData(input.supplementary_data),
    tokenEstimator: createCapturedTokenEstimator(
      input.token_estimates_by_content
    ),
    rankByCandidateKey: new Map(input.rank_by_candidate_key),
    ...(input.final_relevance_by_candidate_key === undefined ? {} : {
      finalRelevanceByCandidateKey: new Map(
        input.final_relevance_by_candidate_key
      )
    }),
    ...(input.coverage_relevance_by_candidate_key === undefined ? {} : {
      coverageRelevanceByCandidateKey: new Map(
        input.coverage_relevance_by_candidate_key
      )
    }),
    ...(input.coverage_relevance_upper_bound === undefined ? {} : {
      coverageRelevanceUpperBound: input.coverage_relevance_upper_bound
    }),
    ...(input.coverage_objective_config === undefined ? {} : {
      coverageObjectiveConfig: input.coverage_objective_config
    }),
    ...(input.answer_relevance_rank_by_candidate_key === undefined ? {} : {
      answerRelevanceRankByCandidateKey: new Map(
        input.answer_relevance_rank_by_candidate_key
      )
    }),
    ...(input.capture_answer_features === undefined ? {} : {
      captureAnswerFeatures: input.capture_answer_features
    }),
    ...(input.deep_head_trace_by_candidate_key === undefined ? {} : {
      deepHeadTraceByCandidateKey: new Map(
        input.deep_head_trace_by_candidate_key
      )
    })
  };
}

export function restoreSupplementaryData(
  data: SerializedRecallSupplementaryData
): RecallSupplementaryData {
  const {
    evidenceSemanticActivationsByCandidateKey,
    openSemanticFactorCandidateActivationsByCandidateKey,
    evidenceSemanticScoresByCandidateKey: _evidenceSemanticScoresByCandidateKey,
    evidenceSemanticWinnersByCandidateKey,
    answerRelevanceScoresByCandidateKey,
    routingKeysByOwnerIdentity,
    keyActivationByOwnerIdentity,
    ...plainData
  } = data;
  return {
    ...plainData,
    evidenceSemanticActivationsByCandidateKey: restoreSemanticActivations(
      evidenceSemanticActivationsByCandidateKey,
      evidenceSemanticWinnersByCandidateKey
    ),
    ...(openSemanticFactorCandidateActivationsByCandidateKey === undefined ? {} : {
      openSemanticFactorCandidateActivationsByCandidateKey: new Map(
        openSemanticFactorCandidateActivationsByCandidateKey
      )
    }),
    ...(answerRelevanceScoresByCandidateKey === undefined ? {} : {
      answerRelevanceScoresByCandidateKey: new Map(
        answerRelevanceScoresByCandidateKey
      )
    }),
    ...(routingKeysByOwnerIdentity === undefined ? {} : {
      routingKeysByOwnerIdentity: new Map(routingKeysByOwnerIdentity)
    }),
    ...(keyActivationByOwnerIdentity === undefined ? {} : {
      keyActivationByOwnerIdentity: new Map(keyActivationByOwnerIdentity)
    })
  };
}

export function createCapturedTokenEstimator(
  entries: SelectionBoundaryNumberMap
): FineAssessmentSelectionParams["tokenEstimator"] {
  const tokenEstimates = new Map(entries);
  return {
    estimate: (content) => {
      const estimate = tokenEstimates.get(content);
      if (estimate === undefined) throwSelectionBoundaryFidelityMismatch();
      return estimate;
    }
  };
}
