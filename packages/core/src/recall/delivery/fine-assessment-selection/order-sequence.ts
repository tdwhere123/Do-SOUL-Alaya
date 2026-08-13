import type { RecallCandidate } from "@do-soul/alaya-protocol";
import { buildRecallCandidateSelectionKey } from
  "../../runtime/recall-candidate-builder.js";
import type { FineAssessmentCandidate } from "./types.js";

export type FineAssessmentOrderOwner =
  | "coarse"
  | "fusion"
  | "deep_head"
  | "coverage"
  | "direct_evidence_promotion"
  | "semantic_memory_refinement"
  | "behavior_authority_promotion"
  | "verified_temporal_head"
  | "consensus"
  | "final_budget";

export type FineAssessmentOrderRanks = Readonly<{
  readonly coarse: ReadonlyMap<string, number | null>;
  readonly fusion: ReadonlyMap<string, number>;
  readonly deepHead: ReadonlyMap<string, number>;
  readonly coverage: ReadonlyMap<string, number>;
  readonly consensus: ReadonlyMap<string, number>;
  readonly final: ReadonlyMap<string, number>;
}>;

export type FineAssessmentOrderTransition = Readonly<{
  readonly owner: FineAssessmentOrderOwner;
  readonly order: readonly string[];
  readonly memberKeys: readonly string[];
}>;

export type FineAssessmentOrderSequence = Readonly<{
  readonly birthOrder: readonly string[];
  readonly currentOrder: readonly string[];
  readonly ranks: FineAssessmentOrderRanks;
  readonly transitions: readonly FineAssessmentOrderTransition[];
}>;

export type FineAssessmentOrderState = Readonly<{
  readonly birthCandidates: readonly FineAssessmentCandidate[];
  readonly candidates: readonly FineAssessmentCandidate[];
  readonly sequence: FineAssessmentOrderSequence;
}>;

export function birthFineAssessmentOrderState(
  members: readonly FineAssessmentCandidate[],
  deepHeadRanks: ReadonlyMap<string, number>,
  membership: (candidates: readonly FineAssessmentCandidate[]) => readonly string[],
  packetMembers?: readonly FineAssessmentCandidate[] | null
): FineAssessmentOrderState {
  const birthOrder = freezeKeys(members);
  const packetOrder = packetMembers === null ? null : freezeKeys(packetMembers ?? members);
  const fusionCandidates = orderByFusionReceipt(members);
  const sequence = Object.freeze({
    birthOrder,
    currentOrder: birthOrder,
    transitions: Object.freeze([
      transition("coarse", packetOrder ?? birthOrder, packetOrder === null ? [] : membership(
        packetMembers ?? members
      )),
      transition("fusion", freezeKeys(fusionCandidates), membership(fusionCandidates)),
      transition("deep_head", birthOrder, membership(members))
    ]),
    ranks: Object.freeze({
      coarse: packetOrder === null ? unavailableRanks(birthOrder) : ranksFromOrder(packetOrder),
      fusion: ranksFromFusionReceipts(members),
      deepHead: new Map(deepHeadRanks),
      coverage: ranksFromOrder(birthOrder),
      consensus: ranksFromOrder(birthOrder),
      final: ranksFromOrder(birthOrder)
    })
  });
  assertPermutation(sequence, members);
  if (packetMembers !== null) assertPermutation(sequence, packetMembers ?? members);
  return Object.freeze({
    birthCandidates: Object.freeze([...members]),
    candidates: Object.freeze([...members]),
    sequence
  });
}

export function advanceFineAssessmentOrderState(
  state: FineAssessmentOrderState,
  nextCandidates: readonly FineAssessmentCandidate[],
  stage: "coverage" | "consensus",
  memberKeys: readonly string[]
): FineAssessmentOrderState {
  const advanced = carryFineAssessmentOrderState(state, nextCandidates, stage, memberKeys);
  return Object.freeze({
    ...advanced,
    sequence: Object.freeze({
      ...advanced.sequence,
      ranks: Object.freeze({
        ...advanced.sequence.ranks,
        [stage]: ranksFromOrder(advanced.sequence.currentOrder)
      })
    })
  });
}

export function carryFineAssessmentOrderState(
  state: FineAssessmentOrderState,
  nextCandidates: readonly FineAssessmentCandidate[],
  owner: FineAssessmentOrderOwner,
  memberKeys: readonly string[]
): FineAssessmentOrderState {
  assertPermutation(state.sequence, nextCandidates);
  const currentOrder = freezeKeys(nextCandidates);
  assertMembership(memberKeys, state.sequence.birthOrder);
  return Object.freeze({
    birthCandidates: state.birthCandidates,
    candidates: Object.freeze([...nextCandidates]),
    sequence: Object.freeze({
      ...state.sequence,
      currentOrder,
      transitions: Object.freeze([
        ...state.sequence.transitions,
        transition(owner, currentOrder, memberKeys)
      ])
    })
  });
}

export function stampFineAssessmentFinalRanks(
  state: FineAssessmentOrderState,
  deliveredCandidates: readonly Readonly<RecallCandidate>[],
): FineAssessmentOrderSequence {
  const deliveredKeys = deliveredCandidates.map(buildRecallCandidateSelectionKey);
  const delivered = new Set(deliveredKeys);
  const leftovers = state.sequence.currentOrder.filter((key) => !delivered.has(key));
  const finalOrder = Object.freeze([...deliveredKeys, ...leftovers]);
  return Object.freeze({
    birthOrder: state.sequence.birthOrder,
    currentOrder: state.sequence.currentOrder,
    transitions: Object.freeze([
      ...state.sequence.transitions,
      transition("final_budget", finalOrder, deliveredKeys)
    ]),
    ranks: Object.freeze({
      ...state.sequence.ranks,
      final: ranksFromOrder(finalOrder)
    })
  });
}

function transition(
  owner: FineAssessmentOrderOwner,
  order: readonly string[],
  memberKeys: readonly string[]
): FineAssessmentOrderTransition {
  return Object.freeze({
    owner,
    order: Object.freeze([...order]),
    memberKeys: Object.freeze([...memberKeys])
  });
}

function ranksFromFusionReceipts(
  members: readonly FineAssessmentCandidate[]
): ReadonlyMap<string, number> {
  return new Map(members.map((member) => [
    member.fusion.candidate_key,
    member.fusion.fused_rank
  ]));
}

function orderByFusionReceipt(
  members: readonly FineAssessmentCandidate[]
): readonly FineAssessmentCandidate[] {
  const ordered = new Array<FineAssessmentCandidate | undefined>(members.length);
  for (const member of members) {
    const index = member.fusion.fused_rank - 1;
    if (!Number.isSafeInteger(index) || index < 0 || index >= members.length ||
        ordered[index] !== undefined) return members;
    ordered[index] = member;
  }
  return ordered.some((member) => member === undefined)
    ? members
    : Object.freeze(ordered as FineAssessmentCandidate[]);
}

function freezeKeys(members: readonly FineAssessmentCandidate[]): readonly string[] {
  return Object.freeze(members.map((member) => member.fusion.candidate_key));
}

function ranksFromOrder(order: readonly string[]): ReadonlyMap<string, number> {
  return new Map(order.map((key, index) => [key, index + 1]));
}

function unavailableRanks(order: readonly string[]): ReadonlyMap<string, null> {
  return new Map(order.map((key) => [key, null]));
}

function assertMembership(memberKeys: readonly string[], birthOrder: readonly string[]): void {
  if (new Set(memberKeys).size !== memberKeys.length ||
      memberKeys.some((key) => !birthOrder.includes(key))) {
    throw new Error("fine-assessment order state membership identity mismatch");
  }
}

function assertPermutation(
  sequence: FineAssessmentOrderSequence,
  candidates: readonly FineAssessmentCandidate[]
): void {
  const keys = freezeKeys(candidates);
  if (keys.length !== sequence.birthOrder.length ||
      new Set(keys).size !== keys.length ||
      keys.some((key) => !sequence.ranks.final.has(key))) {
    throw new Error("fine-assessment order state candidate identity mismatch");
  }
}
