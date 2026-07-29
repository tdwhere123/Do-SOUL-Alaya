import {
  selectFineAssessmentCandidates,
  type FineAssessmentSelectionResult
} from "../fine-assessment-selection.js";
import { applyDeliverySelection } from "../delivery-selection.js";
import {
  resolveFineAssessmentDeliveryBranch
} from "../fine-assessment-delivery-branch.js";
import {
  resolveFineAssessmentDeepHead,
  type DeepHeadAssessmentResolver
} from "../fine-assessment-deep-head.js";
import {
  resolveIndependentEmbeddingEvidenceAssessment,
  resolveNonlexicalUnitIntervalCompositionAssessment
} from "../../rerank/deep-head.js";
import { buildRecallCandidateSelectionKey } from
  "../../runtime/recall-candidate-builder.js";
import {
  restoreSupplementaryData,
  validateSelectionBoundary
} from "./selection-boundary-restore.js";
import type {
  FineAssessmentSelectionBoundaryCase
} from "./selection-boundary-types.js";
import {
  buildCompositionSelectionParams,
  type SelectionCompositionOptions,
  type SelectionCompositionReconstruction
} from "./selection-boundary-composition.js";
import {
  createLivePlusCompanionTokenEstimator
} from "./selection-boundary-cf-token-companion.js";

export const INDEPENDENT_EMBEDDING_EVIDENCE_OPERATOR =
  "independent_embedding_evidence" as const;

export const NONLEXICAL_UNIT_INTERVAL_COMPOSITION_OPERATOR =
  "nonlexical_unit_interval_composition" as const;

export type CounterfactualCompositionOptions = SelectionCompositionOptions &
  Readonly<{
    /** Companion waist estimates keyed by content sha256; F0 live map unchanged. */
    readonly cfTokenCompanionAuxiliaryByContentSha256?: ReadonlyMap<
      string,
      number
    >;
  }>;

/**
 * Counterfactual composition: same delivery seam as baseline reconstruction,
 * but deep-head scores use the registered independent-embedding operator.
 * Does not assert captured CURRENT-path fidelity; token estimates still fail
 * closed on unseen content unless a proved companion map is supplied.
 */
export function reconstructIndependentEmbeddingEvidenceComposition(
  boundary: FineAssessmentSelectionBoundaryCase,
  options: CounterfactualCompositionOptions = {}
): SelectionCompositionReconstruction {
  return reconstructCounterfactualComposition(
    boundary,
    options,
    resolveIndependentEmbeddingEvidenceAssessment
  );
}

/**
 * Counterfactual composition omitting fusion-echo lexical agreement from the
 * unit-interval deep-head objective. Product CURRENT default unchanged.
 */
export function reconstructNonlexicalUnitIntervalComposition(
  boundary: FineAssessmentSelectionBoundaryCase,
  options: CounterfactualCompositionOptions = {}
): SelectionCompositionReconstruction {
  return reconstructCounterfactualComposition(
    boundary,
    options,
    resolveNonlexicalUnitIntervalCompositionAssessment
  );
}

export function counterfactualDeliveredCandidateKeys(
  result: FineAssessmentSelectionResult
): readonly string[] {
  return Object.freeze(
    result.candidates.map((candidate) =>
      buildRecallCandidateSelectionKey(candidate)
    )
  );
}

function reconstructCounterfactualComposition(
  boundary: FineAssessmentSelectionBoundaryCase,
  options: CounterfactualCompositionOptions,
  resolveAssessment: DeepHeadAssessmentResolver
): SelectionCompositionReconstruction {
  validateSelectionBoundary(boundary);
  const input = boundary.input;
  const candidates = input.ordered_candidates;
  const supplementaryData = restoreSupplementaryData(input.supplementary_data);
  const answerRelevanceScores =
    supplementaryData.answerRelevanceScoresByCandidateKey ?? new Map();
  const deepHead = resolveFineAssessmentDeepHead(
    {
      candidates,
      answerRelevanceScores,
      supplementaryData,
      captureAnswerFeatures: input.capture_answer_features
    },
    resolveAssessment
  );
  const branch = resolveFineAssessmentDeliveryBranch({
    answerRelevanceScores,
    candidates,
    supplementaryData,
    deepHeadScores: deepHead.scores,
    finalAuthorityMaxHeadDrop: options.finalAuthorityMaxHeadDrop
  });
  const delivery = applyDeliverySelection(candidates, deepHead.scores, {
    replacePublicRelevance: branch.replacePublicRelevance
  });
  const selected = selectFineAssessmentCandidates(
    buildCompositionSelectionParams(
      input,
      supplementaryData,
      delivery,
      deepHead,
      branch,
      createLivePlusCompanionTokenEstimator(
        input.token_estimates_by_content,
        options.cfTokenCompanionAuxiliaryByContentSha256
      )
    )
  );
  return Object.freeze({
    result: selected,
    branch,
    deepHead,
    delivery
  });
}
