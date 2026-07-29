import { hasObservedDeepHeadEmbedding } from "../rerank/deep-head.js";
import type { DeliverySelectionCandidate } from "./delivery-selection.js";

export type FineAssessmentDeliveryBranch = Readonly<{
  readonly replacePublicRelevance: boolean;
  readonly hasEmbeddingRefinement: boolean;
  readonly finalOrderAfterCoverage: "coverage" | "public_relevance" | "delivery_rank";
  readonly maxHeadDropAfterCoverage: number | undefined;
}>;

/**
 * Shared live / composition delivery branch.
 * Composition fidelity must mirror this seam bit-identically.
 */
export function resolveFineAssessmentDeliveryBranch(input: Readonly<{
  readonly answerRelevanceScores: ReadonlyMap<string, number>;
  readonly candidates: readonly DeliverySelectionCandidate[];
  readonly supplementaryData: Parameters<typeof hasObservedDeepHeadEmbedding>[1];
  readonly deepHeadScores: ReadonlyMap<string, number>;
  readonly finalAuthorityMaxHeadDrop?: number;
}>): FineAssessmentDeliveryBranch {
  // CE present → scores own public relevance. Lightweight head reorders only so
  // fused_score / 8-factor governance stay visible on RecallCandidate.
  const replacePublicRelevance = input.answerRelevanceScores.size > 0;
  const hasEmbeddingRefinement = hasObservedDeepHeadEmbedding(
    input.candidates,
    input.supplementaryData
  );
  return Object.freeze({
    replacePublicRelevance,
    hasEmbeddingRefinement,
    // Without an independent semantic refinement, re-sorting by fused relevance
    // would erase the set decision the lightweight head just made.
    finalOrderAfterCoverage: input.deepHeadScores.size === 0
      ? "public_relevance"
      : replacePublicRelevance
        ? "delivery_rank"
        : hasEmbeddingRefinement ? "public_relevance" : "coverage",
    maxHeadDropAfterCoverage: !replacePublicRelevance &&
      hasEmbeddingRefinement && input.deepHeadScores.size > 0
      ? input.finalAuthorityMaxHeadDrop
      : undefined
  });
}
