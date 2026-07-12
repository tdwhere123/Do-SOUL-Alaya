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

export function applyDeliverySelection(
  scoredCandidates: readonly DeliverySelectionCandidate[]
): Readonly<{
  readonly orderedCandidates: readonly DeliverySelectionCandidate[];
  readonly rankByCandidateKey: ReadonlyMap<string, number>;
}> {
  const rankedCandidates = Object.freeze(
    [...scoredCandidates].sort(compareFusedRecallCandidates)
  );
  return Object.freeze({
    orderedCandidates: rankedCandidates,
    rankByCandidateKey: new Map(
      rankedCandidates.map((candidate, index) => [candidate.fusion.candidate_key, index + 1])
    )
  });
}
