import type {
  SelectGammaDecision,
  SelectGammaDecisionReceipt,
  SelectGammaWalkResult
} from "../types.js";

export function assertSelectGammaWalkReceipts(
  walk: SelectGammaWalkResult
): void {
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
      decision.marginal_gain !== null ||
      !validExclusion(receipt, retainedKeys, selectedCount, tokenTotal)) {
    throw new Error("Select_Gamma exclusion receipt is invalid");
  }
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
      receipt.identity_channel === "source" ||
      receipt.identity_channel === "lineage") &&
      nonEmpty(receipt.retained_candidate_key) &&
      retainedKeys.includes(receipt.retained_candidate_key);
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
