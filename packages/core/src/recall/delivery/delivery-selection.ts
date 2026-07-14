import type { RecallScoreFactors } from "@do-soul/alaya-protocol";
import type {
  CoarseRecallCandidate,
  RecallFusionBreakdown
} from "../runtime/recall-service-types.js";
import { compareFusedRecallCandidates } from "./fusion-delivery-scoring.js";

export type DeliverySelectionCandidate = Readonly<CoarseRecallCandidate & {
  readonly effectiveScore: number;
  readonly effectiveFactors: RecallScoreFactors;
  readonly fusion: RecallFusionBreakdown;
}>;

export type DeliverySelectionOptions = Readonly<{
  /**
   * When true (cross-encoder path), scores own the public relevance scalar.
   * Lightweight deep-head reorder must leave fused_score as the public scalar so
   * 8-factor / plasticity / conflict governance stay visible on RecallCandidate.
   */
  readonly replacePublicRelevance?: boolean;
}>;

export function applyDeliverySelection(
  scoredCandidates: readonly DeliverySelectionCandidate[],
  answerRelevanceScores: ReadonlyMap<string, number> = new Map(),
  options: DeliverySelectionOptions = {}
): Readonly<{
  readonly orderedCandidates: readonly DeliverySelectionCandidate[];
  readonly rankByCandidateKey: ReadonlyMap<string, number>;
  readonly finalRelevanceByCandidateKey: ReadonlyMap<string, number>;
  readonly answerRelevanceRankByCandidateKey: ReadonlyMap<string, number>;
}> {
  const fusionOrdered = Object.freeze(
    [...scoredCandidates].sort(compareFusedRecallCandidates)
  );
  const rankedCandidates = rankByAnswerRelevance(fusionOrdered, answerRelevanceScores);
  // Default true preserves CE/test callers that pass scores without options.
  const replacePublicRelevance = options.replacePublicRelevance ?? true;
  return Object.freeze({
    orderedCandidates: rankedCandidates,
    rankByCandidateKey: new Map(
      rankedCandidates.map((candidate, index) => [candidate.fusion.candidate_key, index + 1])
    ),
    finalRelevanceByCandidateKey: new Map(rankedCandidates.map((candidate) => [
      candidate.fusion.candidate_key,
      replacePublicRelevance
        ? (answerRelevanceScores.get(candidate.fusion.candidate_key) ?? candidate.fusion.fused_score)
        : candidate.fusion.fused_score
    ])),
    answerRelevanceRankByCandidateKey: replacePublicRelevance
      ? buildAnswerRelevanceRanks(rankedCandidates, answerRelevanceScores)
      : new Map()
  });
}

function rankByAnswerRelevance(
  fusionOrdered: readonly DeliverySelectionCandidate[],
  scores: ReadonlyMap<string, number>
): readonly DeliverySelectionCandidate[] {
  if (scores.size === 0) return fusionOrdered;
  return Object.freeze([...fusionOrdered].sort((left, right) => {
    const leftScore = scores.get(left.fusion.candidate_key);
    const rightScore = scores.get(right.fusion.candidate_key);
    if (leftScore !== undefined && rightScore !== undefined) {
      return rightScore - leftScore || compareFusedRecallCandidates(left, right);
    }
    if (leftScore !== undefined) return -1;
    if (rightScore !== undefined) return 1;
    return compareFusedRecallCandidates(left, right);
  }));
}

function buildAnswerRelevanceRanks(
  candidates: readonly DeliverySelectionCandidate[],
  scores: ReadonlyMap<string, number>
): ReadonlyMap<string, number> {
  const scored = candidates.filter((candidate) => scores.has(candidate.fusion.candidate_key));
  return new Map(scored.map((candidate, index) => [candidate.fusion.candidate_key, index + 1]));
}
