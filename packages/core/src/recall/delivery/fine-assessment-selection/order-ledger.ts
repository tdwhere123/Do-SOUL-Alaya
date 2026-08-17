import type { FineAssessmentOrderSequence } from "./order-sequence.js";

export type FineAssessmentMembershipOwner =
  | "select_gamma"
  | "unavailable";

type FineAssessmentOrderLedgerCandidate = Readonly<{
  readonly candidate_key: string;
  readonly ranks: Readonly<{
    readonly coarse: number | null;
    readonly fusion: number;
    readonly deep_head: number;
    readonly select_gamma: number;
    readonly final: number;
  }>;
  readonly first_membership_changing_owner:
    FineAssessmentMembershipOwner | null;
  readonly membership_changing_owners:
    readonly FineAssessmentMembershipOwner[];
}>;

export type FineAssessmentOrderLedger = Readonly<{
  readonly schema_version: 2;
  readonly candidate_count: number;
  readonly delivered_count: number;
  readonly coarse_identity: "captured" | "unavailable";
  readonly candidates: readonly FineAssessmentOrderLedgerCandidate[];
}>;

const SIMULTANEOUS_MEMBERSHIP_OWNERS =
  "selection order ledger has multiple simultaneous membership-changing owners";

export function buildFineAssessmentOrderLedger(
  sequence: FineAssessmentOrderSequence,
  deliveredCount: number
): FineAssessmentOrderLedger {
  assertDeliveredCount(sequence, deliveredCount);
  assertOrderSequenceRanks(sequence);
  const coarseAvailable = [...sequence.ranks.coarse.values()].every(
    (rank) => rank !== null
  );
  const ledger = Object.freeze({
    schema_version: 2 as const,
    candidate_count: sequence.birthOrder.length,
    delivered_count: deliveredCount,
    coarse_identity: coarseAvailable ? "captured" as const : "unavailable" as const,
    candidates: Object.freeze(sequence.birthOrder.map((candidateKey) => {
      const ranks = ranksForCandidate(sequence, candidateKey);
      const membershipOwners = membershipChangingOwners(
        sequence,
        candidateKey,
        ranks
      );
      return Object.freeze({
        candidate_key: candidateKey,
        ranks,
        first_membership_changing_owner: membershipOwners[0] ?? null,
        membership_changing_owners: membershipOwners
      });
    }))
  });
  assertFineAssessmentOrderLedgerAttribution(ledger);
  return ledger;
}

// Sequential flips keep the first owner; a first-owner tie is simultaneous.
export function assertFineAssessmentOrderLedgerAttribution(
  ledger: FineAssessmentOrderLedger
): void {
  for (const candidate of ledger.candidates) {
    assertCandidateMembershipAttribution(candidate);
  }
}

function assertCandidateMembershipAttribution(
  candidate: FineAssessmentOrderLedgerCandidate
): void {
  const owners = candidate.membership_changing_owners;
  const first = candidate.first_membership_changing_owner;
  if (owners.length === 0) {
    if (first !== null) {
      throw new Error("selection order ledger membership owner identity mismatch");
    }
    return;
  }
  if (first === null) {
    throwSimultaneousMembershipOwners("missing first-owner identity");
  }
  if (first !== owners[0]) {
    throwSimultaneousMembershipOwners("first owner is not owners[0]");
  }
  if (new Set(owners).size !== owners.length) {
    throwSimultaneousMembershipOwners("duplicate owners");
  }
  if (!isCanonicalOwnerSequence(owners)) {
    throwSimultaneousMembershipOwners("non-canonical stage order");
  }
}

function throwSimultaneousMembershipOwners(detail: string): never {
  throw new Error(`${SIMULTANEOUS_MEMBERSHIP_OWNERS}: ${detail}`);
}

function isCanonicalOwnerSequence(
  owners: readonly FineAssessmentMembershipOwner[]
): boolean {
  return owners.length === 1 &&
    (owners[0] === "select_gamma" || owners[0] === "unavailable");
}

function ranksForCandidate(
  sequence: FineAssessmentOrderSequence,
  candidateKey: string
) {
  return Object.freeze({
    coarse: requiredRank(sequence.ranks.coarse, candidateKey),
    fusion: requiredNumericRank(sequence.ranks.fusion, candidateKey),
    deep_head: requiredNumericRank(sequence.ranks.deepHead, candidateKey),
    select_gamma: requiredNumericRank(sequence.ranks.selectGamma, candidateKey),
    final: requiredNumericRank(sequence.ranks.final, candidateKey)
  });
}

function membershipChangingOwners(
  sequence: FineAssessmentOrderSequence,
  candidateKey: string,
  ranks: ReturnType<typeof ranksForCandidate>
): readonly FineAssessmentMembershipOwner[] {
  if (ranks.coarse === null) return Object.freeze(["unavailable"]);
  const stages = sequence.transitions;
  let included = stages[0]?.memberKeys.includes(candidateKey) ?? false;
  const owners: FineAssessmentMembershipOwner[] = [];
  for (const stage of stages.slice(1)) {
    const nextIncluded = stage.memberKeys.includes(candidateKey);
    if (nextIncluded !== included) {
      if (stage.owner !== "select_gamma") {
        throw new Error("selection order ledger has a non-Gamma membership owner");
      }
      owners.push("select_gamma");
    }
    included = nextIncluded;
  }
  return Object.freeze(owners);
}

function requiredNumericRank(
  ranks: ReadonlyMap<string, number>,
  candidateKey: string
): number {
  const rank = ranks.get(candidateKey);
  if (rank === undefined || !Number.isSafeInteger(rank) || rank < 1) {
    throw new Error("fine-assessment order ledger rank identity mismatch");
  }
  return rank;
}

function requiredRank(
  ranks: ReadonlyMap<string, number | null>,
  candidateKey: string
): number | null {
  if (!ranks.has(candidateKey)) {
    throw new Error("fine-assessment order ledger rank identity mismatch");
  }
  const rank = ranks.get(candidateKey) ?? null;
  if (rank !== null && (!Number.isSafeInteger(rank) || rank < 1)) {
    throw new Error("fine-assessment order ledger rank identity mismatch");
  }
  return rank;
}

function assertDeliveredCount(
  sequence: FineAssessmentOrderSequence,
  deliveredCount: number
): void {
  if (!Number.isSafeInteger(deliveredCount) || deliveredCount < 0 ||
      deliveredCount > sequence.birthOrder.length) {
    throw new Error("fine-assessment order ledger delivered count is invalid");
  }
}

function assertOrderSequenceRanks(sequence: FineAssessmentOrderSequence): void {
  const expectedKeys = new Set(sequence.birthOrder);
  assertRankPermutation(sequence.ranks.fusion, expectedKeys);
  assertRankPermutation(sequence.ranks.deepHead, expectedKeys);
  assertRankPermutation(sequence.ranks.selectGamma, expectedKeys);
  assertRankPermutation(sequence.ranks.final, expectedKeys);
  const coarse = sequence.ranks.coarse;
  const coarseValues = [...coarse.values()];
  const unavailable = coarseValues.every((rank) => rank === null);
  const partiallyUnavailable = coarseValues.some((rank) => rank === null);
  if (!unavailable && partiallyUnavailable) {
    throw new Error("fine-assessment order ledger coarse identity mismatch");
  }
  if (!unavailable) assertRankPermutation(coarse, expectedKeys);
  assertTransitionOwners(sequence.transitions);
  for (const transition of sequence.transitions) {
    assertOrderPermutation(transition.order, expectedKeys);
    assertMembershipKeys(transition.memberKeys, expectedKeys);
  }
}

function assertTransitionOwners(
  transitions: FineAssessmentOrderSequence["transitions"]
): void {
  const expected = [
    "coarse", "fusion", "deep_head", "select_gamma", "final_budget"
  ];
  if (transitions.length !== expected.length ||
      transitions.some((transition, index) => transition.owner !== expected[index])) {
    throw new Error("fine-assessment order ledger transition order is invalid");
  }
}

function assertRankPermutation(
  ranks: ReadonlyMap<string, number | null>,
  expectedKeys: ReadonlySet<string>
): void {
  if (ranks.size !== expectedKeys.size ||
      [...ranks.keys()].some((key) => !expectedKeys.has(key))) {
    throw new Error("fine-assessment order ledger rank identity mismatch");
  }
  const values = [...ranks.values()];
  if (values.some((rank) => rank === null) ||
      new Set(values).size !== expectedKeys.size ||
      values.some((rank) => rank! < 1 || rank! > expectedKeys.size)) {
    throw new Error("fine-assessment order ledger rank permutation mismatch");
  }
}

function assertOrderPermutation(
  order: readonly string[],
  expectedKeys: ReadonlySet<string>
): void {
  if (order.length !== expectedKeys.size || new Set(order).size !== order.length ||
      order.some((key) => !expectedKeys.has(key))) {
    throw new Error("fine-assessment order ledger transition identity mismatch");
  }
}

function assertMembershipKeys(
  memberKeys: readonly string[],
  expectedKeys: ReadonlySet<string>
): void {
  if (new Set(memberKeys).size !== memberKeys.length ||
      memberKeys.some((key) => !expectedKeys.has(key))) {
    throw new Error("fine-assessment order ledger membership identity mismatch");
  }
}
