import type {
  SelectGammaDecisionReceipt,
  SelectGammaWalkResult
} from "../types.js";

export type SelectGammaFirstExclusionReason =
  | "quality_displaced"
  | "coverage_displaced"
  | "duplicate_source"
  | "duplicate_object"
  | "dimension_limit"
  | "token_budget"
  | "entry_budget";

export function firstSelectGammaExclusionReason(
  goldKey: string,
  walk: SelectGammaWalkResult
): SelectGammaFirstExclusionReason | null {
  if (walk.selected_candidate_keys.includes(goldKey)) return null;
  const own = walk.decisions.find((decision) => decision.candidate_key === goldKey);
  if (own === undefined) {
    throw new Error("Select_Gamma gold is absent from the walk");
  }
  return mapSelectGammaConstraintReceipt(own.receipt);
}

export function mapSelectGammaConstraintReceipt(
  receipt: SelectGammaDecisionReceipt
): SelectGammaFirstExclusionReason {
  if (receipt.kind === "duplicate") {
    const channel: string = receipt.identity_channel;
    if (channel === "source") return "duplicate_source";
    if (channel === "object") return "duplicate_object";
    throw new Error("Select_Gamma duplicate identity channel is unknown");
  }
  if (receipt.kind === "dimension_limit") return "dimension_limit";
  if (receipt.kind === "max_total_tokens") return "token_budget";
  if (receipt.kind === "max_entries") return "entry_budget";
  if (receipt.kind === "coverage_displaced" || receipt.kind === "quality_displaced") {
    return receipt.kind;
  }
  throw new Error(`Select_Gamma exclusion receipt is unmapped: ${receipt.kind}`);
}
