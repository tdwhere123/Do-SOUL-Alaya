import {
  selectFineAssessmentCandidates,
  type FineAssessmentSelectionResult
} from "../fine-assessment-selection.js";
import { applyDeliverySelection } from "../delivery-selection.js";
import {
  resolveFineAssessmentDeliveryBranch
} from "../fine-assessment-delivery-branch.js";
import { resolveFineAssessmentDeepHead } from
  "../fine-assessment-deep-head.js";
import {
  resolveIndependentEmbeddingEvidenceAssessment
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

export const INDEPENDENT_EMBEDDING_EVIDENCE_OPERATOR =
  "independent_embedding_evidence" as const;

/**
 * Counterfactual composition: same delivery seam as baseline reconstruction,
 * but deep-head scores use the registered independent-embedding operator.
 * Does not assert captured CURRENT-path fidelity; token estimates still fail
 * closed on unseen content.
 */
export function reconstructIndependentEmbeddingEvidenceComposition(
  boundary: FineAssessmentSelectionBoundaryCase,
  options: SelectionCompositionOptions = {}
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
    resolveIndependentEmbeddingEvidenceAssessment
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
      branch
    )
  );
  return Object.freeze({
    result: selected,
    branch,
    deepHead,
    delivery
  });
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
