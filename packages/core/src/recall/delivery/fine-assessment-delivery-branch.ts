export type FineAssessmentDeliveryBranch = Readonly<{
  readonly replacePublicRelevance: boolean;
}>;

/**
 * Live and composition must share this bit; a second branch would fork order.
 */
export function resolveFineAssessmentDeliveryBranch(_input: Readonly<{
  readonly answerRelevanceScores: ReadonlyMap<string, number>;
}>): FineAssessmentDeliveryBranch {
  return Object.freeze({
    replacePublicRelevance: false
  });
}
