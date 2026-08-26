import { z } from "zod";
import { compareCodeUnits } from "../../field-contract/canonical-identity.js";
import { D0ExecutionSchema } from "./d0-execution.js";
import { canonicalJson } from "./canonical-json.js";
import {
  D0CandidateObservationSchema, D0DecisionSchema, D0FrontierSchema,
  D0RejectSchema, D0SetUtilitySchema
} from "./d0-receipt-structures.js";

export const CANONICAL_D0_ALGORITHM_ID =
  "alaya.recall.shadow.d0.safe-dominance-capture.v1" as const;
export const CANONICAL_D0_ALGORITHM_VERSION =
  "d0.safe-dominance-capture.v1.0.0" as const;
export const CANONICAL_D0_IDENTITY_DIGEST =
  "8f287df50610b28a3b40921b9bce765164794d6d4afd17c246e6807e768773fa" as const;
export const CANONICAL_D0_IDENTITY_BLOB_ID = "alaya.recall.shadow.d0.identity.v1" as const;
export const CANONICAL_D0_IDENTITY_BLOB = `${[
  CANONICAL_D0_IDENTITY_BLOB_ID,
  `algorithm_id: ${CANONICAL_D0_ALGORITHM_ID}`,
  `version: ${CANONICAL_D0_ALGORITHM_VERSION}`,
  "LexDomain: (lane_id, list_n, status, raw_key_kind)",
  "lane_id: exact | porter | trigram | object_key_porter | object_key_trigram",
  "list_n: nat",
  "status: empty | complete | truncated",
  "raw_key_kind: matched_token_count | bm25_raw_rank",
  "Cmp_lexical.skip: both states equal and both in {not_applicable, not_observed, producer_unavailable}",
  "Cmp_lexical.incomparable: mixed states, OR both observed with LexDomain(u) != LexDomain(v)",
  "Cmp_lexical.comparable: both observed AND LexDomain(u) = LexDomain(v)",
  "Cmp_lexical.numeric: higher-is-better grouped_ordinal of the merge-chosen lane; equal ordinal => channel-equal",
  "lineages: lexical | embedding | temporal | subject_preference",
  "Gamma_kinds: unscaled_remainder | Values_v | evidence_novelty_redundancy"
].join("\n")}\n` as const;

const Key = z.string().min(1);
const ReceiptDigest = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const Identity = z.object({ algorithm_id: z.literal(CANONICAL_D0_ALGORITHM_ID),
  version: z.literal(CANONICAL_D0_ALGORITHM_VERSION),
  digest: z.literal(CANONICAL_D0_IDENTITY_DIGEST) }).strict().readonly();
export const CANONICAL_D0_IDENTITY = Object.freeze({
  algorithm_id: CANONICAL_D0_ALGORITHM_ID,
  version: CANONICAL_D0_ALGORITHM_VERSION,
  digest: CANONICAL_D0_IDENTITY_DIGEST
});
export const CanonicalD0DispositionSchema = z.object({ candidate_key: Key, status: z.enum([
  "selected", "rejected", "ineligible", "unavailable"
]), reason: z.enum(["selected_by_gamma", "duplicate_object", "dimension_limit",
  "max_total_tokens", "h_ineligible", "fail_closed_unavailable"]) }).strict().readonly();

const CanonicalD0SelectionReceiptBodyObject = z.object({
  schema_version: z.literal(1), ranking_authority: z.literal("d0_prefix"),
  identity: Identity, execution: D0ExecutionSchema,
  field_membership: z.object({ e0_keys: z.array(Key).readonly(),
    e1_keys: z.array(Key).readonly(), eligible_keys: z.array(Key).readonly() }).strict(),
  observations_by_candidate_key: z.record(Key, D0CandidateObservationSchema).nullable(),
  frontiers: D0FrontierSchema.nullable(),
  gamma: z.object({ set_utilities: z.array(D0SetUtilitySchema).readonly(),
    decisions: z.array(D0DecisionSchema).readonly(),
    rejects: z.array(D0RejectSchema).readonly() }).strict(),
  dispositions: z.array(CanonicalD0DispositionSchema).readonly(),
  delivery: z.array(z.object({ candidate_key: Key,
    delivery_rank: z.number().int().positive() }).strict()).readonly()
}).strict();
export const CanonicalD0SelectionReceiptBodySchema =
  CanonicalD0SelectionReceiptBodyObject.readonly();
const ReceiptShapeSchema = CanonicalD0SelectionReceiptBodyObject.extend({
  receipt_digest: ReceiptDigest
}).strict().readonly();

export type CanonicalD0SelectionReceiptBody = z.infer<
  typeof CanonicalD0SelectionReceiptBodySchema
>;
export type CanonicalD0SelectionReceipt = z.infer<typeof ReceiptShapeSchema>;
export type CanonicalD0Disposition = z.infer<typeof CanonicalD0DispositionSchema>;
export type CanonicalD0Sha256 = (preimage: string) => string;
export const CanonicalD0SelectionReceiptSchema =
  ReceiptShapeSchema.superRefine(validateReceipt).readonly();

export function createCanonicalD0SelectionReceipt(
  input: unknown,
  sha256: CanonicalD0Sha256
): CanonicalD0SelectionReceipt {
  const body = CanonicalD0SelectionReceiptBodySchema.parse(input);
  return CanonicalD0SelectionReceiptSchema.parse({
    ...body, receipt_digest: digest(canonicalD0ReceiptPreimage(body), sha256)
  });
}

export function verifyCanonicalD0SelectionReceipt(
  input: unknown,
  sha256: CanonicalD0Sha256
): CanonicalD0SelectionReceipt {
  const receipt = CanonicalD0SelectionReceiptSchema.parse(input);
  const { receipt_digest: _digest, ...body } = receipt;
  if (receipt.receipt_digest !== digest(canonicalD0ReceiptPreimage(body), sha256)) {
    throw new Error("canonical D0 receipt digest mismatch");
  }
  return receipt;
}

export function canonicalD0ReceiptPreimage(body: CanonicalD0SelectionReceiptBody): string {
  return canonicalJson(body);
}

function validateReceipt(receipt: CanonicalD0SelectionReceipt, context: z.RefinementCtx): void {
  const membership = receipt.field_membership;
  const captured = receipt.execution.status === "captured";
  if (captured !== (receipt.observations_by_candidate_key !== null) ||
      captured !== (receipt.frontiers !== null)) return issue(context, "D0 execution mismatch");
  if (![membership.e0_keys, membership.e1_keys, membership.eligible_keys].every(unique) ||
      membership.eligible_keys.some((key) => !membership.e1_keys.includes(key))) {
    return issue(context, "D0 field membership mismatch");
  }
  if (membership.e0_keys.some((key) => !membership.e1_keys.includes(key)) !==
      (receipt.execution.reason === "membership_shrink")) {
    return issue(context, "D0 membership shrink status mismatch");
  }
  if (!captured) return validateFailClosed(receipt, context);
  validateCapturedClosure(receipt, context);
}

function validateFailClosed(
  receipt: CanonicalD0SelectionReceipt,
  context: z.RefinementCtx
): void {
  const gammaEmpty = receipt.gamma.set_utilities.length === 0 &&
    receipt.gamma.decisions.length === 0 && receipt.gamma.rejects.length === 0;
  const unavailable = receipt.dispositions.every((row) =>
    row.status === "unavailable" && row.reason === "fail_closed_unavailable");
  if (!gammaEmpty || receipt.delivery.length > 0 ||
      !sameSet(receipt.dispositions.map(keyOf), receipt.field_membership.e1_keys) ||
      !unavailable) issue(context, "failed D0 receipt is not closed");
}

function validateCapturedClosure(
  receipt: CanonicalD0SelectionReceipt,
  context: z.RefinementCtx
): void {
  const e1 = receipt.field_membership.e1_keys;
  const observations = Object.keys(receipt.observations_by_candidate_key ?? {});
  const utilities = receipt.gamma.set_utilities.map(keyOf);
  const dispositions = receipt.dispositions.map(keyOf);
  if (!sameSet(observations, e1) || !sameSet(utilities, e1) ||
      !sameSet(dispositions, e1) || receipt.dispositions.some((row) =>
        row.status === "unavailable")) {
    return issue(context, "captured D0 candidate closure mismatch");
  }
  validateFrontiers(receipt, context);
  validateDispositions(receipt, context);
}

function validateFrontiers(
  receipt: CanonicalD0SelectionReceipt,
  context: z.RefinementCtx
): void {
  const members = receipt.frontiers?.layers.flatMap((layer, index) => {
    if (layer.index !== index + 1 || !unique(layer.member_keys)) issue(context, "invalid frontier");
    return layer.member_keys;
  }) ?? [];
  if (!unique(members) || !sameSet(members, receipt.field_membership.eligible_keys)) {
    issue(context, "frontiers must partition eligible keys");
  }
}

function validateDispositions(
  receipt: CanonicalD0SelectionReceipt,
  context: z.RefinementCtx
): void {
  const eligible = receipt.field_membership.eligible_keys;
  const decisions = receipt.gamma.decisions.map(keyOf);
  const rejects = receipt.gamma.rejects.map(keyOf);
  if (!unique(decisions) || !unique(rejects) ||
      !sameSet([...decisions, ...rejects], eligible) ||
      decisions.some((key) => rejects.includes(key))) {
    return issue(context, "D0 decisions and rejects must partition eligible keys");
  }
  const rejectedReasons = new Map(receipt.gamma.rejects.map((row) =>
    [row.candidate_key, row.walk_reject]));
  const ineligible = receipt.field_membership.e1_keys.filter((key) => !eligible.includes(key));
  for (const row of receipt.dispositions) {
    if (!dispositionMatches(row, decisions, rejectedReasons, ineligible)) {
      return issue(context, "D0 disposition does not match its authority row");
    }
  }
  validateDeliveryPrefix(receipt, decisions, context);
}

function dispositionMatches(
  row: CanonicalD0Disposition,
  decisions: readonly string[],
  rejects: ReadonlyMap<string, string>,
  ineligible: readonly string[]
): boolean {
  if (row.status === "selected") {
    return row.reason === "selected_by_gamma" && decisions.includes(row.candidate_key);
  }
  if (row.status === "rejected") return rejects.get(row.candidate_key) === row.reason;
  return row.status === "ineligible" && row.reason === "h_ineligible" &&
    ineligible.includes(row.candidate_key);
}

function validateDeliveryPrefix(
  receipt: CanonicalD0SelectionReceipt,
  decisions: readonly string[],
  context: z.RefinementCtx
): void {
  const delivered = receipt.delivery.map((row, index) => {
    if (row.delivery_rank !== index + 1) issue(context, "delivery ranks are not contiguous");
    return row.candidate_key;
  });
  if (!unique(delivered) || !delivered.every((key, index) => key === decisions[index])) {
    issue(context, "delivery is not a selected prefix");
  }
}

function keyOf(value: { readonly candidate_key: string }): string { return value.candidate_key; }
function unique(values: readonly string[]): boolean { return new Set(values).size === values.length; }
function sameSet(left: readonly string[], right: readonly string[]): boolean {
  const sortedRight = [...right].sort(compareCodeUnits);
  return left.length === right.length && [...left].sort(compareCodeUnits).every(
    (value, index) => value === sortedRight[index]
  );
}
function digest(preimage: string, sha256: CanonicalD0Sha256): string {
  return `sha256:${sha256(preimage)}`;
}
function issue(context: z.RefinementCtx, message: string): void {
  context.addIssue({ code: "custom", message });
}
