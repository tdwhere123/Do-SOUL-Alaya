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

export type RecallDegradationReason =
  | "evidence_fts_failed"
  | "evidence_candidate_embedding_failed"
  | "synthesis_fts_failed"
  | "keyword_search_failed"
  | "embedding_query_timeout"
  | "embedding_query_failed"
  | "embedding_warmup_in_progress"
  | "embedding_inference_failed"
  | "embedding_workspace_scan_truncated"
  | "path_plasticity_query_failed"
  | "path_expansion_query_failed"
  | "graph_support_query_failed"
  | "active_constraints_failed"
  | "budget_penalty_failed";

export interface RecallTokenEconomy {
  readonly delivered_context_tokens_estimate: number;
  readonly coarse_pool_size: number;
  readonly fine_pool_size: number;
  readonly delivered_pool_size: number;
  readonly embedding_inference_calls: number;
  readonly path_expansion_queries: number;
  readonly fine_priority_overflow_count?: number;
}
