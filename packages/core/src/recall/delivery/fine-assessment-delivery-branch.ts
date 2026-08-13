export type FineAssessmentDeliveryBranch = Readonly<{
  readonly replacePublicRelevance: boolean;
}>;

/**
 * Shared live / composition delivery branch.
 * Composition fidelity must mirror this seam bit-identically.
 */
export function resolveFineAssessmentDeliveryBranch(input: Readonly<{
  readonly answerRelevanceScores: ReadonlyMap<string, number>;
}>): FineAssessmentDeliveryBranch {
  // CE present → scores own public relevance. Lightweight head reorders only so
  // fused_score / 8-factor governance stay visible on RecallCandidate.
  return Object.freeze({
    replacePublicRelevance: input.answerRelevanceScores.size > 0
  });
}
