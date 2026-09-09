export * from "./recall-service-ports.js";
export * from "./recall-service-results.js";
export type { SoulRecallHostContext, RecallCandidate } from "@do-soul/alaya-protocol";

export type RecallCandidateDropReason =
  | "ineligible"
  | "duplicate"
  | "dimension_limit"
  | "max_entries"
  | "max_total_tokens"
  | "coverage_displaced"
  | "quality_displaced"
  | "rank_displaced";
