import { z } from "zod";
import { compareCodeUnits } from "../../field-contract/canonical-identity.js";
import { CaptureExecutionSchema } from "./capture-execution.js";
import { canonicalJson } from "./canonical-json.js";
import {
  CaptureCandidateObservationSchema, CaptureDecisionSchema, CaptureFrontierSchema,
  CaptureRejectSchema, CaptureSetUtilitySchema
} from "./capture-receipt-structures.js";

export const CANONICAL_CAPTURE_ALGORITHM_ID =
  "alaya.recall.shadow.safe-dominance-capture.v1" as const;
export const CANONICAL_CAPTURE_ALGORITHM_VERSION =
  "safe-dominance-capture.v1.0.0" as const;
export const CANONICAL_CAPTURE_IDENTITY_DIGEST =
  "db68fc1dbd2f3e2a71dab08df7feb86c683de12c54ccdc10edfb17916dcef0e3" as const;
export const CANONICAL_CAPTURE_IDENTITY_BLOB_ID = "alaya.recall.shadow.identity.v1" as const;
export const CANONICAL_CAPTURE_IDENTITY_BLOB = `${[
  CANONICAL_CAPTURE_IDENTITY_BLOB_ID,
  `algorithm_id: ${CANONICAL_CAPTURE_ALGORITHM_ID}`,
  `version: ${CANONICAL_CAPTURE_ALGORITHM_VERSION}`,
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
const Identity = z.object({ algorithm_id: z.literal(CANONICAL_CAPTURE_ALGORITHM_ID),
  version: z.literal(CANONICAL_CAPTURE_ALGORITHM_VERSION),
  digest: z.literal(CANONICAL_CAPTURE_IDENTITY_DIGEST) }).strict().readonly();
export const CANONICAL_CAPTURE_IDENTITY = Object.freeze({
  algorithm_id: CANONICAL_CAPTURE_ALGORITHM_ID,
  version: CANONICAL_CAPTURE_ALGORITHM_VERSION,
  digest: CANONICAL_CAPTURE_IDENTITY_DIGEST
});
export const CanonicalDispositionSchema = z.object({ candidate_key: Key, status: z.enum([
  "selected", "rejected", "ineligible", "unavailable"
]), reason: z.enum(["selected_by_gamma", "duplicate_object", "dimension_limit",
  "max_total_tokens", "h_ineligible", "fail_closed_unavailable"]) }).strict().readonly();

const CanonicalSelectionReceiptBodyObject = z.object({
  schema_version: z.literal(1), ranking_authority: z.literal("prefix_sk"),
  identity: Identity, execution: CaptureExecutionSchema,
  field_membership: z.object({ e0_keys: z.array(Key).readonly(),
    e1_keys: z.array(Key).readonly(), eligible_keys: z.array(Key).readonly() }).strict(),
  observations_by_candidate_key: z.record(Key, CaptureCandidateObservationSchema).nullable(),
  frontiers: CaptureFrontierSchema.nullable(),
  gamma: z.object({ set_utilities: z.array(CaptureSetUtilitySchema).readonly(),
    decisions: z.array(CaptureDecisionSchema).readonly(),
    rejects: z.array(CaptureRejectSchema).readonly() }).strict(),
  dispositions: z.array(CanonicalDispositionSchema).readonly(),
  delivery: z.array(z.object({ candidate_key: Key,
    delivery_rank: z.number().int().positive() }).strict()).readonly()
}).strict();
export const CanonicalSelectionReceiptBodySchema =
  CanonicalSelectionReceiptBodyObject.readonly();
const ReceiptShapeSchema = CanonicalSelectionReceiptBodyObject.extend({
  receipt_digest: ReceiptDigest
}).strict().readonly();

export type CanonicalSelectionReceiptBody = z.infer<
  typeof CanonicalSelectionReceiptBodySchema
>;
export type CanonicalSelectionReceipt = z.infer<typeof ReceiptShapeSchema>;
export type CanonicalDisposition = z.infer<typeof CanonicalDispositionSchema>;
export type CanonicalSelectionSha256 = (preimage: string) => string;
export const CanonicalSelectionReceiptSchema =
  ReceiptShapeSchema.superRefine(validateReceipt).readonly();

export function createCanonicalSelectionReceipt(
  input: unknown,
  sha256: CanonicalSelectionSha256
): CanonicalSelectionReceipt {
  const body = CanonicalSelectionReceiptBodySchema.parse(input);
  return CanonicalSelectionReceiptSchema.parse({
    ...body, receipt_digest: digest(canonicalSelectionReceiptPreimage(body), sha256)
  });
}

export function verifyCanonicalSelectionReceipt(
  input: unknown,
  sha256: CanonicalSelectionSha256
): CanonicalSelectionReceipt {
  const receipt = CanonicalSelectionReceiptSchema.parse(input);
  const { receipt_digest: _digest, ...body } = receipt;
  if (receipt.receipt_digest !== digest(canonicalSelectionReceiptPreimage(body), sha256)) {
    throw new Error("canonical selection receipt digest mismatch");
  }
  return receipt;
}

export function canonicalSelectionReceiptPreimage(body: CanonicalSelectionReceiptBody): string {
  return canonicalJson(body);
}

function validateReceipt(receipt: CanonicalSelectionReceipt, context: z.RefinementCtx): void {
  const membership = receipt.field_membership;
  const captured = receipt.execution.status === "captured";
  if (captured !== (receipt.observations_by_candidate_key !== null) ||
      captured !== (receipt.frontiers !== null)) return issue(context, "capture execution mismatch");
  if (![membership.e0_keys, membership.e1_keys, membership.eligible_keys].every(unique) ||
      membership.eligible_keys.some((key) => !membership.e1_keys.includes(key))) {
    return issue(context, "capture field membership mismatch");
  }
  if (membership.e0_keys.some((key) => !membership.e1_keys.includes(key)) !==
      (receipt.execution.reason === "membership_shrink")) {
    return issue(context, "capture membership shrink status mismatch");
  }
  if (!captured) return validateFailClosed(receipt, context);
  validateCapturedClosure(receipt, context);
}

function validateFailClosed(
  receipt: CanonicalSelectionReceipt,
  context: z.RefinementCtx
): void {
  const gammaEmpty = receipt.gamma.set_utilities.length === 0 &&
    receipt.gamma.decisions.length === 0 && receipt.gamma.rejects.length === 0;
  const unavailable = receipt.dispositions.every((row) =>
    row.status === "unavailable" && row.reason === "fail_closed_unavailable");
  if (!gammaEmpty || receipt.delivery.length > 0 ||
      !sameSet(receipt.dispositions.map(keyOf), receipt.field_membership.e1_keys) ||
      !unavailable) issue(context, "failed capture receipt is not closed");
}

function validateCapturedClosure(
  receipt: CanonicalSelectionReceipt,
  context: z.RefinementCtx
): void {
  const e1 = receipt.field_membership.e1_keys;
  const observations = Object.keys(receipt.observations_by_candidate_key ?? {});
  const utilities = receipt.gamma.set_utilities.map(keyOf);
  const dispositions = receipt.dispositions.map(keyOf);
  if (!sameSet(observations, e1) || !sameSet(utilities, e1) ||
      !sameSet(dispositions, e1) || receipt.dispositions.some((row) =>
        row.status === "unavailable")) {
    return issue(context, "captured candidate closure mismatch");
  }
  validateFrontiers(receipt, context);
  validateDispositions(receipt, context);
}

function validateFrontiers(
  receipt: CanonicalSelectionReceipt,
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
  receipt: CanonicalSelectionReceipt,
  context: z.RefinementCtx
): void {
  const eligible = receipt.field_membership.eligible_keys;
  const decisions = receipt.gamma.decisions.map(keyOf);
  const rejects = receipt.gamma.rejects.map(keyOf);
  if (!unique(decisions) || !unique(rejects) ||
      !sameSet([...decisions, ...rejects], eligible) ||
      decisions.some((key) => rejects.includes(key))) {
    return issue(context, "capture decisions and rejects must partition eligible keys");
  }
  const rejectedReasons = new Map(receipt.gamma.rejects.map((row) =>
    [row.candidate_key, row.walk_reject]));
  const ineligible = receipt.field_membership.e1_keys.filter((key) => !eligible.includes(key));
  for (const row of receipt.dispositions) {
    if (!dispositionMatches(row, decisions, rejectedReasons, ineligible)) {
      return issue(context, "disposition does not match its authority row");
    }
  }
  validateDeliveryPrefix(receipt, decisions, context);
}

function dispositionMatches(
  row: CanonicalDisposition,
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
  receipt: CanonicalSelectionReceipt,
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
function digest(preimage: string, sha256: CanonicalSelectionSha256): string {
  return `sha256:${sha256(preimage)}`;
}
function issue(context: z.RefinementCtx, message: string): void {
  context.addIssue({ code: "custom", message });
}
