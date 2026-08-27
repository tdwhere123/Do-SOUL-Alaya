import { createHash } from "node:crypto";
import { compareD1FrozenCandidatePairs } from "@do-soul/alaya-core";
import { CANONICAL_CAPTURE_IDENTITY_DIGEST } from "@do-soul/alaya-protocol";
import type { LongMemEvalQuestionDiagnostic } from
  "../schema/diagnostics-types.js";

export const D1_PAIR_DENOMINATOR_BASIS =
  "field_present_production_miss_gold_x_delivered_ranks_1_to_5" as const;

export const D1_FROZEN_PAIR_AUTHORITY = Object.freeze({
  question_count: 100,
  question_multiset_sha256:
    "9f087d198b1047d589af86550a13254a08f55ed05fc0d1986e0ac23d10a9d340",
  receipt_multiset_sha256:
    "5aef714abffabe01b6080ba671d18f0989847d6f8734fde5102550d2bd2317d5",
  pair_denominator: 1_220,
  pair_multiset_sha256:
    "1dd05377557a8b51a60160abe605c4a8d621f8e1308302318bdbf4cdb5f60562",
  capture_identity_digest: CANONICAL_CAPTURE_IDENTITY_DIGEST
});

export type D1ResolvedGold = Readonly<{
  readonly object_id: string;
  readonly object_kind: "memory_entry" | "evidence_capsule";
}>;

export type D1FieldGoldMap =
  | Readonly<{
    readonly status: "MAPPED";
    readonly field_keys: readonly string[];
    readonly absent: number;
  }>
  | Readonly<{
    readonly status: "NOT_MAPPED";
    readonly reason: string;
  }>;

export type D1GoldResolution =
  | Readonly<{ readonly status: "RESOLVED"; readonly golds: readonly D1ResolvedGold[] }>
  | Readonly<{ readonly status: "NOT_RESOLVED"; readonly reason: string }>;

export type D1PairRate = Readonly<{
  readonly blocked_pairs: number;
  readonly denominator: number;
  readonly blocked_share: number;
}>;

type D1PairAuthorityHashes = Readonly<{
  readonly question_multiset_sha256: string;
  readonly receipt_multiset_sha256: string;
  readonly pair_multiset_sha256: string;
}>;

export type D1GoldOccupierBlockingReport =
  | Readonly<{
    readonly status: "REPLAYED";
    readonly denominator_basis: typeof D1_PAIR_DENOMINATOR_BASIS;
    readonly field_present_gold_count: number;
    readonly field_absent_gold_count: number;
    readonly denominator: number;
    readonly production: D1PairRate;
    readonly d1: D1PairRate;
    readonly authority: D1PairAuthorityHashes;
  }>
  | Readonly<{
    readonly status: "NOT_REPLAYABLE";
    readonly denominator_basis: typeof D1_PAIR_DENOMINATOR_BASIS;
    readonly reason: string;
    readonly expected_denominator: number;
    readonly observed_denominator: number | null;
  }>;

export type D1FrozenPairAuthorityEvidence = Readonly<{
  readonly question_count: number;
  readonly replayed_count: number;
  readonly question_multiset_sha256: string;
  readonly receipt_multiset_sha256: string;
  readonly pair_denominator: number;
  readonly pair_multiset_sha256: string;
  readonly capture_identity_digest: string | null;
}>;

export type D1PairAuthorityAccumulator = {
  readonly question_ids: string[];
  readonly receipt_digests: string[];
  readonly pair_ids: string[];
  field_present_gold_count: number;
  field_absent_gold_count: number;
  production_blocked: number;
  d1_blocked: number;
  failure: string | null;
};

export function createD1PairAuthorityAccumulator(): D1PairAuthorityAccumulator {
  return {
    question_ids: [],
    receipt_digests: [],
    pair_ids: [],
    field_present_gold_count: 0,
    field_absent_gold_count: 0,
    production_blocked: 0,
    d1_blocked: 0,
    failure: null
  };
}

export function recordD1PairAuthorityQuestion(
  acc: D1PairAuthorityAccumulator,
  question: LongMemEvalQuestionDiagnostic
): void {
  acc.question_ids.push(question.question_id);
  const receipt = question.capture_receipt;
  if (receipt?.execution.status === "captured") {
    acc.receipt_digests.push(receipt.receipt_digest);
  }
}

export function resolveD1GoldAuthority(
  question: LongMemEvalQuestionDiagnostic
): D1GoldResolution {
  const memoryIds = unique(question.gold_memory_ids);
  const evidenceIds = unique(question.gold_evidence_ids);
  if (memoryIds.some((id) => evidenceIds.includes(id))) {
    return unresolved("gold_alias_mismatch:object_kind_collision");
  }
  const expectedObjects = [
    ...memoryIds.map((object_id) => ({ object_id, object_kind: "memory_entry" as const })),
    ...evidenceIds.map((object_id) => ({ object_id, object_kind: "evidence_capsule" as const }))
  ];
  const stableObjectIds = expectedObjects.map((gold) => gold.object_id);
  if (question.gold_object_ids !== undefined &&
      !sameSequence(unique(question.gold_object_ids), stableObjectIds)) {
    return unresolved("gold_alias_mismatch:gold_object_ids");
  }
  const diagnostics = uniqueDiagnosticGold(question);
  if ("failure" in diagnostics) return unresolved(diagnostics.failure);
  if (!sameIdentitySet(expectedObjects, diagnostics.golds)) {
    return unresolved("gold_alias_mismatch:question.gold");
  }
  return {
    status: "RESOLVED",
    golds: Object.freeze(expectedObjects.map((gold) => Object.freeze({ ...gold })))
  };
}

export function mapD1GoldsToFieldKeys(
  golds: readonly D1ResolvedGold[],
  receipt: NonNullable<LongMemEvalQuestionDiagnostic["capture_receipt"]>
): D1FieldGoldMap {
  const eligible = receipt.field_membership.eligible_keys;
  const observations = receipt.observations_by_candidate_key ?? {};
  const keys: string[] = [];
  let absent = 0;
  for (const gold of golds) {
    const suffix = `:${gold.object_kind}:${gold.object_id}`;
    const matches = eligible.filter((key) => key.endsWith(suffix));
    if (matches.length > 1) {
      return { status: "NOT_MAPPED", reason: "ambiguous_required_field:field_present_gold" };
    }
    const key = matches[0];
    if (key === undefined) {
      absent += 1;
      continue;
    }
    if (observations[key] === undefined) {
      return {
        status: "NOT_MAPPED",
        reason: "missing_required_field:capture_receipt.observations_by_candidate_key"
      };
    }
    keys.push(key);
  }
  return { status: "MAPPED", field_keys: Object.freeze(keys), absent };
}

export function recordD1GoldOccupierPairs(
  acc: D1PairAuthorityAccumulator,
  input: Readonly<{
    readonly question: LongMemEvalQuestionDiagnostic;
    readonly field_gold_keys: readonly string[];
    readonly field_absent: number;
  }>
): void {
  const receipt = input.question.capture_receipt;
  if (receipt === null || receipt.execution.status !== "captured") {
    noteD1PairAuthorityFailure(acc, "missing_required_field:capture_receipt");
    return;
  }
  const occupiers = deliveredTopFive(receipt);
  if ("failure" in occupiers) {
    noteD1PairAuthorityFailure(acc, occupiers.failure);
    return;
  }
  const pairs = goldOccupierPairs(input.field_gold_keys, occupiers.keys);
  const outcomes = compareOccupierPairs(receipt, input.question.lexical_bound_proofs, pairs);
  if (outcomes === null) {
    noteD1PairAuthorityFailure(acc, "invalid_candidate_pair_comparison_receipt");
    return;
  }
  acc.field_present_gold_count += input.field_gold_keys.length;
  acc.field_absent_gold_count += input.field_absent;
  for (let index = 0; index < pairs.length; index += 1) {
    const pair = pairs[index]!;
    const outcome = outcomes[index]!;
    acc.pair_ids.push(JSON.stringify([
      input.question.question_id,
      pair.left_candidate_key,
      pair.right_candidate_key
    ]));
    if (outcome.production_blocked) acc.production_blocked += 1;
    if (outcome.d1_blocked) acc.d1_blocked += 1;
  }
}

export function noteD1PairAuthorityFailure(
  acc: D1PairAuthorityAccumulator,
  reason: string
): void {
  acc.failure ??= reason;
}

export function finishD1PairAuthority(
  acc: D1PairAuthorityAccumulator,
  input: Readonly<{
    readonly question_count: number;
    readonly replayed_count: number;
    readonly capture_identity_digest: string | null;
  }>
): D1GoldOccupierBlockingReport {
  if (acc.failure !== null) return notReplayable(acc.failure, null);
  const evidence = authorityEvidence(acc, input);
  const failure = frozenD1PairAuthorityFailure(evidence);
  if (failure !== null) return notReplayable(failure, evidence.pair_denominator);
  return {
    status: "REPLAYED",
    denominator_basis: D1_PAIR_DENOMINATOR_BASIS,
    field_present_gold_count: acc.field_present_gold_count,
    field_absent_gold_count: acc.field_absent_gold_count,
    denominator: evidence.pair_denominator,
    production: pairRate(acc.production_blocked, evidence.pair_denominator),
    d1: pairRate(acc.d1_blocked, evidence.pair_denominator),
    authority: {
      question_multiset_sha256: evidence.question_multiset_sha256,
      receipt_multiset_sha256: evidence.receipt_multiset_sha256,
      pair_multiset_sha256: evidence.pair_multiset_sha256
    }
  };
}

export function frozenD1PairAuthorityFailure(
  evidence: D1FrozenPairAuthorityEvidence
): string | null {
  if (evidence.replayed_count !== evidence.question_count) {
    return "incomplete_question_replay";
  }
  if (evidence.question_count !== D1_FROZEN_PAIR_AUTHORITY.question_count) {
    return "frozen_question_count_mismatch";
  }
  if (evidence.capture_identity_digest !==
      D1_FROZEN_PAIR_AUTHORITY.capture_identity_digest) {
    return "frozen_capture_identity_mismatch";
  }
  if (evidence.question_multiset_sha256 !==
      D1_FROZEN_PAIR_AUTHORITY.question_multiset_sha256) {
    return "frozen_question_multiset_identity_mismatch";
  }
  if (evidence.receipt_multiset_sha256 !==
      D1_FROZEN_PAIR_AUTHORITY.receipt_multiset_sha256) {
    return "frozen_receipt_multiset_identity_mismatch";
  }
  if (evidence.pair_denominator !== D1_FROZEN_PAIR_AUTHORITY.pair_denominator) {
    return "gold_occupier_pair_denominator_mismatch";
  }
  if (evidence.pair_multiset_sha256 !== D1_FROZEN_PAIR_AUTHORITY.pair_multiset_sha256) {
    return "frozen_pair_multiset_identity_mismatch";
  }
  return null;
}

function authorityEvidence(
  acc: D1PairAuthorityAccumulator,
  input: Readonly<{
    readonly question_count: number;
    readonly replayed_count: number;
    readonly capture_identity_digest: string | null;
  }>
): D1FrozenPairAuthorityEvidence {
  return {
    ...input,
    question_multiset_sha256: stableMultisetSha256(acc.question_ids),
    receipt_multiset_sha256: stableMultisetSha256(acc.receipt_digests),
    pair_denominator: acc.pair_ids.length,
    pair_multiset_sha256: stableMultisetSha256(acc.pair_ids)
  };
}

function deliveredTopFive(
  receipt: NonNullable<LongMemEvalQuestionDiagnostic["capture_receipt"]>
): Readonly<{ readonly keys: readonly string[] }> | Readonly<{ readonly failure: string }> {
  const topFive = receipt.delivery
    .filter((row) => row.delivery_rank <= 5)
    .sort((left, right) => left.delivery_rank - right.delivery_rank);
  if (topFive.length !== 5 ||
      topFive.some((row, index) => row.delivery_rank !== index + 1) ||
      new Set(topFive.map((row) => row.candidate_key)).size !== 5) {
    return { failure: "missing_required_field:capture_receipt.delivery[1..5]" };
  }
  const eligible = new Set(receipt.field_membership.eligible_keys);
  const observations = receipt.observations_by_candidate_key ?? {};
  for (const row of topFive) {
    if (!eligible.has(row.candidate_key)) {
      return { failure: "missing_required_field:capture_receipt.field_membership.eligible_keys" };
    }
    if (observations[row.candidate_key] === undefined) {
      return { failure: "missing_required_field:capture_receipt.observations_by_candidate_key" };
    }
  }
  return { keys: Object.freeze(topFive.map((row) => row.candidate_key)) };
}

function goldOccupierPairs(
  goldKeys: readonly string[],
  occupierKeys: readonly string[]
): readonly { readonly left_candidate_key: string; readonly right_candidate_key: string }[] {
  return goldKeys.flatMap((gold) => occupierKeys.map((occupier) => ({
    left_candidate_key: gold,
    right_candidate_key: occupier
  })));
}

function compareOccupierPairs(
  receipt: NonNullable<LongMemEvalQuestionDiagnostic["capture_receipt"]>,
  proofs: LongMemEvalQuestionDiagnostic["lexical_bound_proofs"],
  pairs: readonly { readonly left_candidate_key: string; readonly right_candidate_key: string }[]
): ReturnType<typeof compareD1FrozenCandidatePairs> | null {
  try {
    return compareD1FrozenCandidatePairs({
      observations_by_candidate_key: receipt.observations_by_candidate_key,
      lexical_bound_proofs: proofs,
      candidate_pairs: pairs
    });
  } catch (error) {
    if (isCompareContractFailure(error)) return null;
    throw error;
  }
}

function isCompareContractFailure(error: unknown): boolean {
  // Name, not instanceof: bench and core can load different envelope copies.
  return error instanceof TypeError ||
    (error instanceof Error && error.name === "ShadowContractError");
}

function uniqueDiagnosticGold(
  question: LongMemEvalQuestionDiagnostic
): Readonly<{ readonly golds: readonly Pick<D1ResolvedGold, "object_id" | "object_kind">[] }> |
  Readonly<{ readonly failure: string }> {
  const mapped = new Map<string, Pick<D1ResolvedGold, "object_id" | "object_kind">>();
  for (const gold of question.gold) {
    if (gold.object_kind !== "memory_entry" && gold.object_kind !== "evidence_capsule") {
      return { failure: "gold_alias_mismatch:unsupported_object_kind" };
    }
    mapped.set(identityKey(gold), {
      object_id: gold.object_id,
      object_kind: gold.object_kind
    });
  }
  return { golds: Object.freeze([...mapped.values()]) };
}

function sameIdentitySet(
  left: readonly Pick<D1ResolvedGold, "object_id" | "object_kind">[],
  right: readonly Pick<D1ResolvedGold, "object_id" | "object_kind">[]
): boolean {
  const expected = new Set(left.map(identityKey));
  const observed = new Set(right.map(identityKey));
  return expected.size === observed.size && [...expected].every((key) => observed.has(key));
}

function identityKey(gold: Pick<D1ResolvedGold, "object_id" | "object_kind">): string {
  return `${gold.object_kind}:${gold.object_id}`;
}

function unique(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)]);
}

function sameSequence(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function unresolved(reason: string): D1GoldResolution {
  return { status: "NOT_RESOLVED", reason };
}

function stableMultisetSha256(values: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify([...values].sort()), "utf8").digest("hex");
}

function pairRate(blocked: number, denominator: number): D1PairRate {
  return {
    blocked_pairs: blocked,
    denominator,
    blocked_share: blocked / denominator
  };
}

function notReplayable(
  reason: string,
  observedDenominator: number | null
): D1GoldOccupierBlockingReport {
  return {
    status: "NOT_REPLAYABLE",
    denominator_basis: D1_PAIR_DENOMINATOR_BASIS,
    reason,
    expected_denominator: D1_FROZEN_PAIR_AUTHORITY.pair_denominator,
    observed_denominator: observedDenominator
  };
}
