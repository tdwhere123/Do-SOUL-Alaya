import type { RecallCandidate } from "@do-soul/alaya-protocol";
import { buildRecallCandidateSelectionKey } from
  "../../runtime/recall-candidate-builder.js";
import { compareFusedRecallCandidates } from "../fusion-delivery-scoring.js";
import type { FineAssessmentCandidate } from "./types.js";

export type FineAssessmentOrderRanks = Readonly<{
  readonly coarse: ReadonlyMap<string, number>;
  readonly fusion: ReadonlyMap<string, number>;
  readonly deepHead: ReadonlyMap<string, number>;
  readonly coverage: ReadonlyMap<string, number>;
  readonly consensus: ReadonlyMap<string, number>;
  readonly final: ReadonlyMap<string, number>;
}>;

export type FineAssessmentOrderSequence = Readonly<{
  readonly birthOrder: readonly string[];
  readonly currentOrder: readonly string[];
  readonly ranks: FineAssessmentOrderRanks;
}>;

export function birthFineAssessmentOrderSequence(
  members: readonly FineAssessmentCandidate[],
  deepHeadRanks: ReadonlyMap<string, number>,
  packetMembers?: readonly FineAssessmentCandidate[]
): FineAssessmentOrderSequence {
  const birthOrder = freezeKeys(members);
  return Object.freeze({
    birthOrder,
    currentOrder: birthOrder,
    ranks: Object.freeze({
      coarse: ranksFromOrder(freezeKeys(packetMembers ?? members)),
      fusion: ranksFromSortedFusion(members),
      deepHead: new Map(deepHeadRanks),
      coverage: ranksFromOrder(birthOrder),
      consensus: ranksFromOrder(birthOrder),
      final: ranksFromOrder(birthOrder)
    })
  });
}

export function advanceFineAssessmentOrderSequence(
  sequence: FineAssessmentOrderSequence,
  nextCandidates: readonly FineAssessmentCandidate[],
  stage: "coverage" | "consensus"
): FineAssessmentOrderSequence {
  const currentOrder = freezeKeys(nextCandidates);
  return Object.freeze({
    birthOrder: sequence.birthOrder,
    currentOrder,
    ranks: Object.freeze({
      ...sequence.ranks,
      [stage]: ranksFromOrder(currentOrder)
    })
  });
}

export function stampFineAssessmentFinalRanks(
  sequence: FineAssessmentOrderSequence,
  deliveredCandidates: readonly Readonly<RecallCandidate>[],
  walkCandidates: readonly FineAssessmentCandidate[]
): FineAssessmentOrderSequence {
  const deliveredKeys = deliveredCandidates.map(buildRecallCandidateSelectionKey);
  const delivered = new Set(deliveredKeys);
  const leftovers = freezeKeys(walkCandidates).filter((key) => !delivered.has(key));
  return Object.freeze({
    birthOrder: sequence.birthOrder,
    currentOrder: sequence.currentOrder,
    ranks: Object.freeze({
      ...sequence.ranks,
      final: ranksFromOrder([...deliveredKeys, ...leftovers])
    })
  });
}

function ranksFromSortedFusion(
  members: readonly FineAssessmentCandidate[]
): ReadonlyMap<string, number> {
  return ranksFromOrder(
    [...members]
      .sort(compareFusedRecallCandidates)
      .map((member) => member.fusion.candidate_key)
  );
}

function freezeKeys(members: readonly FineAssessmentCandidate[]): readonly string[] {
  return Object.freeze(members.map((member) => member.fusion.candidate_key));
}

function ranksFromOrder(order: readonly string[]): ReadonlyMap<string, number> {
  return new Map(order.map((key, index) => [key, index + 1]));
}
