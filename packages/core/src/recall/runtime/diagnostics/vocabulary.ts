export type RecallAdmissionPlane =
  | "activation"
  | "protected_winner"
  | "object_probe"
  | "evidence_anchor"
  | "facet_concept"
  | "domain_tag_cluster"
  | "session_surface_cohort"
  | "temporal_window"
  | "source_proximity"
  | "graph_expansion"
  | "path_expansion"
  | "lexical"
  // High-precision anchor FTS lane: admitted only on a required anchor token. see also: recall-query-plan.ts, coarse-filter-semantic.ts.
  | "lexical_anchor"
  | "synthesis_child"
  // Embedding-workspace-scan injections with no lexical/structural anchor; separate plane name keeps seed selection honest.
  | "semantic_supplement"
  // see also: collectEntityDerivedSeeds — entity FTS hits that seed graph_expansion and admit on their own plane.
  | "entity_seed";

export type RecallCandidateDropReason =
  | "ineligible"
  | "duplicate"
  | "dimension_limit"
  | "max_entries"
  | "max_total_tokens"
  | "coverage_displaced"
  | "quality_displaced"
  | "rank_displaced";

export type RecallEmbeddingProviderStatus =
  | "provider_returned"
  | "provider_pending"
  | "provider_failed"
  | "provider_not_requested"
  | "query_embedding_unusable";

export type RecallDegradationReason =
  | "evidence_fts_failed"
  | "evidence_candidate_embedding_failed"
  | "synthesis_fts_failed"
  | "embedding_coarse_injection_failed"
  | "graph_expansion_failed"
  | "path_expansion_failed"
  | "packet_plan_trace_capture_failed"
  | "entity_seed_lookup_failed"
  | "evidence_context_bulk_failed"
  | "graph_metrics_bulk_failed";

export interface RecallEmbeddingWorkspaceScanDiagnostics {
  readonly workspace_scan_truncated?: boolean;
  readonly workspace_scan_cap?: number;
  readonly workspace_scanned_count?: number;
  readonly injection_truncated?: boolean;
  readonly injection_eligible_count?: number;
  readonly injection_admitted_count?: number;
  readonly provider_kind?: string;
  readonly model_id?: string;
  readonly schema_version?: number;
}
