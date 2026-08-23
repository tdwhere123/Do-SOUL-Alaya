import type {
  SelectGammaDecision,
  SelectGammaDecisionReceipt,
  SelectGammaSelectionReceipt,
  SelectGammaWalkResult
} from "../types.js";

export function assertSelectGammaWalkReceipts(
  walk: SelectGammaWalkResult
): void {
  if (!isValidSelectGammaSelectionReceipt(walk.selection_receipt)) {
    throw new Error("Select_Gamma selection receipt is invalid");
  }
  const retainedKeys: string[] = [];
  const decisionKeys = new Set<string>();
  let selectedCount = 0;
  let tokenTotal = 0;
  walk.decisions.forEach((decision, index) => {
    assertDecisionIdentity(decision, index, decisionKeys);
    const receipt = decision.receipt;
    if (receipt.kind === "retained") {
      assertRetainedDecision(decision, selectedCount, tokenTotal);
      retainedKeys.push(decision.candidate_key);
      selectedCount += 1;
      tokenTotal += receipt.token_estimate;
      return;
    }
    assertExcludedDecision(decision, retainedKeys, selectedCount, tokenTotal);
  });
  if (!sameOrder(walk.selected_candidate_keys, retainedKeys)) {
    throw new Error("Select_Gamma selected keys do not match retained receipts");
  }
  assertWalkMatchesSelectionReceipt(walk, selectedCount, tokenTotal);
}

function assertWalkMatchesSelectionReceipt(
  walk: SelectGammaWalkResult,
  selectedCount: number,
  tokenTotal: number
): void {
  const { witness, ordering_basis: orderingBasis } = walk.selection_receipt;
  const tokenExclusionInSlackMode = orderingBasis === "raw_marginal_gain" &&
    walk.decisions.some(({ receipt }) => receipt.kind === "max_total_tokens");
  if (witness.eligible_candidate_count !== walk.decisions.length ||
      selectedCount > witness.k ||
      tokenTotal > witness.top_k_token_cost_upper_bound ||
      tokenTotal > witness.token_budget || tokenExclusionInSlackMode) {
    throw new Error("Select_Gamma walk does not match its selection receipt");
  }
}

export function isValidSelectGammaSelectionReceipt(
  value: unknown
): value is SelectGammaSelectionReceipt {
  if (!record(value) || !record(value.witness)) return false;
  const witness = value.witness;
  if (!hasExactKeys(value, [
    "schema_version",
    "objective_semantic_id",
    "configuration_digest",
    "source_hard_dedupe",
    "ordering_basis",
    "witness"
  ]) ||
      !hasExactKeys(witness, [
        "kind",
        "eligible_candidate_count",
        "k",
        "top_k_token_cost_upper_bound",
        "token_budget"
      ])) return false;
  if (!nonNegativeInteger(witness.eligible_candidate_count) ||
      !nonNegativeInteger(witness.k) ||
      witness.k > witness.eligible_candidate_count ||
      !nonNegativeFinite(witness.top_k_token_cost_upper_bound) ||
      !nonNegativeFinite(witness.token_budget)) return false;
  const expectedBasis = witness.top_k_token_cost_upper_bound <= witness.token_budget
    ? "raw_marginal_gain" : "marginal_gain_per_token";
  return value.schema_version === 4 &&
    typeof value.objective_semantic_id === "string" &&
    value.objective_semantic_id.trim().length > 0 &&
    (value.configuration_digest === null ||
      (typeof value.configuration_digest === "string" &&
        value.configuration_digest.length > 0)) &&
    typeof value.source_hard_dedupe === "boolean" &&
    witness.kind === "static_top_k_token_bound" &&
    value.ordering_basis === expectedBasis;
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[]
): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length &&
    actual.every((key) => expected.includes(key));
}

function assertDecisionIdentity(
  decision: SelectGammaDecision,
  index: number,
  decisionKeys: Set<string>
): void {
  if (!nonEmpty(decision.candidate_key) ||
      decision.selection_order !== index + 1 ||
      decisionKeys.has(decision.candidate_key)) {
    throw new Error("Select_Gamma decision identity is invalid");
  }
  decisionKeys.add(decision.candidate_key);
}

function assertRetainedDecision(
  decision: SelectGammaDecision,
  selectedCount: number,
  tokenTotal: number
): void {
  const receipt = decision.receipt;
  if (receipt.kind !== "retained" ||
      decision.selected_rank !== selectedCount + 1 ||
      !nonNegativeFinite(decision.marginal_gain) ||
      receipt.selected_count_before !== selectedCount ||
      receipt.token_total_before !== tokenTotal ||
      !positiveFinite(receipt.token_estimate) ||
      !identityChannel(receipt.source) ||
      !identityChannel(receipt.lineage)) {
    throw new Error("Select_Gamma retained receipt is invalid");
  }
}

function assertExcludedDecision(
  decision: SelectGammaDecision,
  retainedKeys: readonly string[],
  selectedCount: number,
  tokenTotal: number
): void {
  const receipt = decision.receipt;
  if (receipt.kind === "retained" || decision.selected_rank !== null ||
      !validExclusion(receipt, retainedKeys, selectedCount, tokenTotal) ||
      !validExclusionGain(decision, receipt)) {
    throw new Error("Select_Gamma exclusion receipt is invalid");
  }
}

function validExclusionGain(
  decision: SelectGammaDecision,
  receipt: SelectGammaDecisionReceipt
): boolean {
  if (receipt.kind === "coverage_displaced" || receipt.kind === "quality_displaced") {
    return decision.marginal_gain === receipt.candidate_marginal_gain &&
      nonNegativeFinite(decision.marginal_gain);
  }
  return decision.marginal_gain === null;
}

function validExclusion(
  receipt: Exclude<SelectGammaDecisionReceipt, { readonly kind: "retained" }>,
  retainedKeys: readonly string[],
  selectedCount: number,
  tokenTotal: number
): boolean {
  if (receipt.kind === "ineligible") {
    return eligibility(receipt.risk) && eligibility(receipt.authority) &&
      (receipt.risk === "blocked" || receipt.authority === "blocked");
  }
  if (receipt.kind === "duplicate") {
    return (receipt.identity_channel === "object" ||
      receipt.identity_channel === "source") &&
      nonEmpty(receipt.retained_candidate_key) &&
      retainedKeys.includes(receipt.retained_candidate_key);
  }
  if (receipt.kind === "coverage_displaced" || receipt.kind === "quality_displaced") {
    return nonEmpty(receipt.competing_candidate_key) &&
      retainedKeys.includes(receipt.competing_candidate_key) &&
      nonNegativeFinite(receipt.competing_marginal_gain) &&
      nonNegativeFinite(receipt.candidate_marginal_gain);
  }
  if (receipt.kind === "dimension_limit") {
    return nonEmpty(receipt.dimension) && nonNegativeInteger(receipt.limit) &&
      nonNegativeInteger(receipt.accepted_before) &&
      receipt.accepted_before >= receipt.limit;
  }
  if (receipt.kind === "max_entries") {
    return receipt.accepted_before === selectedCount &&
      nonNegativeInteger(receipt.limit) && selectedCount >= receipt.limit;
  }
  if (receipt.kind !== "max_total_tokens") return false;
  return receipt.token_total_before === tokenTotal &&
    positiveFinite(receipt.token_estimate) &&
    nonNegativeFinite(receipt.limit) &&
    tokenTotal + receipt.token_estimate > receipt.limit;
}

function identityChannel(value: unknown): boolean {
  if (!record(value)) return false;
  const keys = Object.keys(value);
  return value.status === "unavailable" ? keys.length === 1 :
    value.status === "available" && nonEmpty(value.key) && keys.length === 2;
}

function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length &&
    left.every((key, index) => key === right[index]);
}

function eligibility(value: unknown): boolean {
  return value === "clear" || value === "blocked";
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function positiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function nonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
