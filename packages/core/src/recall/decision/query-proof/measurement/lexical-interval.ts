import type {
  D1EnvelopeIdentity,
  D1EnvelopeValue
} from "../adapters/lexical-bound/legal-envelope.js";
import { createMeasurementGroupContractV1 } from "./contract.js";

export type LexicalIntervalIdentityV1 = D1EnvelopeIdentity;
export type LexicalIntervalValueV1 = D1EnvelopeValue;

export type LexicalIntervalVoteV1 =
  | "gt"
  | "lt"
  | "eq"
  | "skip"
  | "incomparable";

export const LEXICAL_INTERVAL_PROPOSITION_ID = "lex.interval" as const;

export const LEXICAL_INTERVAL_MEASUREMENT_CONTRACT =
  createMeasurementGroupContractV1({
    contract_id: "measure.lexical.interval.v1",
    operator_version: "1",
    proposition_schema: LEXICAL_INTERVAL_PROPOSITION_ID,
    measurement_domain: "numeric_interval",
    comparison_direction: "higher_is_stronger",
    correlation_policy: "identity_dedupe",
    combine_operator: "bound_intersection",
    soundness_preconditions: ["receipt_backed_interval", "lex_domain_frozen"],
    upper_bound_rule: "interval_upper"
  });

export function compareLexicalIntervals(
  left: LexicalIntervalValueV1,
  right: LexicalIntervalValueV1
): LexicalIntervalVoteV1 {
  if (left.kind === "inapplicable" && right.kind === "inapplicable") return "skip";
  if (left.kind !== "interval" || right.kind !== "interval") return "incomparable";
  if (left.lower > left.upper || right.lower > right.upper) return "incomparable";
  if (left.lower > right.upper) return "gt";
  if (right.lower > left.upper) return "lt";
  if (isSamePoint(left, right)) return "eq";
  return "incomparable";
}

export function lexicalIntervalIdentitiesEqual(
  left: LexicalIntervalIdentityV1,
  right: LexicalIntervalIdentityV1
): boolean {
  return left.field_prefix === right.field_prefix &&
    left.snapshot_digest === right.snapshot_digest &&
    left.request_digest === right.request_digest &&
    left.workspace_id === right.workspace_id;
}

function isSamePoint(
  left: Extract<LexicalIntervalValueV1, { kind: "interval" }>,
  right: Extract<LexicalIntervalValueV1, { kind: "interval" }>
): boolean {
  return left.lower === left.upper &&
    right.lower === right.upper &&
    left.lower === right.lower;
}
