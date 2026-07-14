import type {
  MemoryEntry,
  RecallCandidate,
  RecallScoreFactors,
  RecallOriginPlane} from "@do-soul/alaya-protocol";

export type RecallAdmissionPlane =
  | "activation"
  | "protected_winner"
  | "object_probe"
  | "evidence_anchor"
  | "facet_concept"
  | "domain_tag_cluster"
  | "session_surface_cohort"
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
  | "duplicate"
  | "dimension_limit"
  | "max_entries"
  | "max_total_tokens";

export type RecallEmbeddingProviderStatus =
  | "provider_returned"
  | "provider_pending"
  | "provider_failed"
  | "provider_not_requested";

export type RecallDegradationReason =
  | "evidence_fts_failed"
  | "synthesis_fts_failed"
  | "embedding_coarse_injection_failed"
  | "graph_expansion_failed"
  | "path_expansion_failed";

export interface RecallEmbeddingWorkspaceScanDiagnostics {
  readonly workspace_scan_truncated?: boolean;
  readonly workspace_scan_cap?: number;
  readonly workspace_scanned_count?: number;
  readonly provider_kind?: string;
  readonly model_id?: string;
  readonly schema_version?: number;
}

export type RecallFusionStream =
  | "lexical_fts"
  | "trigram_fts"
  | "synthesis_fts"
  | "evidence_fts"
  | "evidence_structural_agreement"
  | "source_proximity"
  | "source_evidence_agreement"
  | "subject_alignment"
  | "structural"
  | "existing_score"
  | "embedding_similarity"
  | "graph_expansion"
  | "entity_seed"
  | "path_expansion"
  | "temporal_recency"
  | "workspace_activation"
  | "facet_overlap";

export type RecallFusionStreamRanks = Readonly<Record<RecallFusionStream, number | null>>;
export type RecallFusionStreamContributions = Readonly<Record<RecallFusionStream, number>>;

export type RecallConformantAxis = "object" | "path" | "evidence" | "temporal" | "control";

export type FloodAxisInactiveReason =
  | "active"
  | "inactive:no_fuel"
  | "inactive:no_slice"
  | "inactive:no_path"
  | "inactive:no_evidence"
  | "inactive:pass_through"
  | "inactive:beta_disabled";

export interface RecallFloodEdgeTraceV1 {
  readonly schema_version: 1;
  readonly path_id: string;
  readonly relation_kind: string;
  readonly seed_object_id: string;
  readonly target_object_id: string;
  readonly input_potential: number;
  readonly edge_conductance: number;
  readonly slice_compatibility:
    | "not_evaluated"
    | "no_query_key"
    | "missing_source_key"
    | "missing_target_key"
    | "missing_source_and_target_key"
    | "no_slice_match"
    | "slice_match";
  readonly raw_transfer: number;
  readonly capped_transfer: number;
  readonly decision: "transferred" | "rejected";
  readonly reason:
    | "transferred"
    | "capped"
    | "self_loop"
    | "missing_edge_provenance"
    | "missing_or_zero_input"
    | "non_positive_conductance"
    | "no_slice_match";
}

export interface IntegratedFloodCandidateDiagnostics {
  readonly R_obj: number;
  readonly Slice: number;
  readonly A_path: number;
  readonly B_evidence: number;
  readonly E_direct: number;
  readonly omega: number;
  readonly Flood: number;
  readonly lambda: number;
  readonly beta: number;
  readonly final_score: number;
  readonly slice_status: FloodAxisInactiveReason;
  readonly path_status: FloodAxisInactiveReason;
  readonly evidence_status: FloodAxisInactiveReason;
  readonly e_direct_status: FloodAxisInactiveReason;
  readonly fuel_verified: boolean;
  readonly edge_traces?: readonly Readonly<RecallFloodEdgeTraceV1>[];
  readonly edge_trace_truncated_count?: number;
}

export interface FloodFuelCoverageSummary {
  readonly candidates_total: number;
  readonly cold_start_count: number;
  readonly fuel_verified_count: number;
  readonly slice_active_count: number;
  readonly path_active_count: number;
  readonly evidence_active_count: number;
}

export interface RecallFusionBreakdown {
  readonly candidate_key: string;
  readonly object_id: string;
  readonly object_kind: RecallCandidate["object_kind"];
  readonly origin_plane: RecallOriginPlane;
  readonly facet_overlap: number;
  readonly per_stream_rank: RecallFusionStreamRanks;
  readonly fused_rank: number;
  readonly fused_score: number;
  readonly fused_rank_contribution_per_stream: RecallFusionStreamContributions;
  readonly per_axis_rank?: Readonly<Record<RecallConformantAxis, number | null>>;
  readonly per_axis_contribution?: Readonly<Record<RecallConformantAxis, number>>;
  readonly flood_potential?: Readonly<IntegratedFloodCandidateDiagnostics>;
  readonly flood_fuel_coverage?: Readonly<FloodFuelCoverageSummary>;
}

export interface RecallCandidateDiagnostic {
  readonly candidate_key: string;
  readonly object_id: string;
  readonly object_kind: RecallCandidate["object_kind"];
  readonly created_at: string;
  readonly facet_overlap: number;
  // Object's memory dimension (typed facet) — for facet-separation diagnostics. Provenance only.
  readonly dimension: string;
  readonly origin_plane: RecallOriginPlane;
  readonly admission_planes: readonly RecallAdmissionPlane[];
  readonly plane_first_admitted: RecallAdmissionPlane;
  readonly plane_winning_admission: RecallAdmissionPlane;
  readonly pre_budget_rank: number;
  readonly selection_order: number;
  readonly fused_rank: number;
  readonly fused_score: number;
  readonly per_stream_rank: RecallFusionStreamRanks;
  readonly fused_rank_contribution_per_stream: RecallFusionStreamContributions;
  readonly per_axis_rank?: Readonly<Record<RecallConformantAxis, number | null>>;
  readonly per_axis_contribution?: Readonly<Record<RecallConformantAxis, number>>;
  readonly flood_potential?: Readonly<IntegratedFloodCandidateDiagnostics>;
  readonly flood_fuel_coverage?: Readonly<FloodFuelCoverageSummary>;
  readonly final_rank: number | null;
  /** MemTrace alias of final_rank after delivery selection. */
  readonly post_rank?: number | null;
  /** MemTrace alias of within_budget. */
  readonly in_final_packet?: boolean;
  /** MemTrace alias of dropped_reason. */
  readonly eviction_reason?: RecallCandidateDropReason | null;
  readonly dropped_reason: RecallCandidateDropReason | null;
  readonly within_budget: boolean;
  readonly relevance_score: number;
  readonly answer_relevance_score?: number;
  readonly answer_relevance_rank?: number;
  readonly additive_score: number;
  readonly lexical_rank: number | null;
  readonly structural_score: number;
  readonly score_factors: Readonly<RecallScoreFactors>;
  readonly source_channels: readonly string[];
  readonly path_expansion_sources: readonly RecallPathExpansionSourceDiagnostic[];
  readonly answer_features?: Readonly<RecallCandidateAnswerFeatures>;
  readonly path_suppression_score: number;
  // Per-stage delivery rank trajectory through fineAssess (1-based): shows where a candidate fell out of the top-k window; reserved_by names the stage that pulled it in. Provenance only, never feeds ranking.
  readonly rank_after_fusion?: number;
  readonly rank_after_feature_rerank?: number;
  readonly rank_after_lexical_priority?: number;
  readonly rank_after_synthesis_reserve?: number;
  readonly rank_after_structural_reserve?: number;
  readonly rank_after_coverage_selector?: number;
  readonly rank_after_session_coverage?: number;
  readonly coverage_selector_action?: "noop" | "kept" | "promoted" | "displaced";
  readonly session_coverage_action?: "noop" | "kept" | "promoted" | "displaced";
  readonly session_key?: string;
  readonly source_cohort_key?: string | null;
  readonly reserved_by?: "none" | "synthesis" | "structural";
}

export interface RecallCandidateAnswerFeatures {
  readonly content: MemoryEntry["content"];
  readonly evidence_gist: string | null;
  readonly evidence_gist_truncated: boolean;
  readonly domain_tags: MemoryEntry["domain_tags"];
  readonly evidence_refs: MemoryEntry["evidence_refs"];
  readonly facet_tags: NonNullable<MemoryEntry["facet_tags"]>;
  readonly canonical_entities: NonNullable<MemoryEntry["canonical_entities"]>;
  readonly projection_schema_version: Exclude<MemoryEntry["projection_schema_version"], undefined>;
  readonly event_time_start: Exclude<MemoryEntry["event_time_start"], undefined>;
  readonly event_time_end: Exclude<MemoryEntry["event_time_end"], undefined>;
  readonly valid_from: Exclude<MemoryEntry["valid_from"], undefined>;
  readonly valid_to: Exclude<MemoryEntry["valid_to"], undefined>;
  readonly time_precision: Exclude<MemoryEntry["time_precision"], undefined>;
  readonly time_source: Exclude<MemoryEntry["time_source"], undefined>;
  readonly preference_subject: Exclude<MemoryEntry["preference_subject"], undefined>;
  readonly preference_predicate: Exclude<MemoryEntry["preference_predicate"], undefined>;
  readonly preference_object: Exclude<MemoryEntry["preference_object"], undefined>;
  readonly preference_category: Exclude<MemoryEntry["preference_category"], undefined>;
  readonly preference_polarity: Exclude<MemoryEntry["preference_polarity"], undefined>;
}

export interface RecallPathExpansionSourceDiagnostic {
  readonly path_id: string;
  readonly seed_id: string;
  readonly seed_kind: "memory" | "time_concern";
  readonly target_object_id: string;
  readonly source_channel: "path_expansion" | "time_concern";
  // The relation (constitution.relation_kind) and firing facet_key that carried the candidate. Provenance only — attributes gold delivery to a relation/facet, not a flat stream label.
  readonly relation_kind: string;
  readonly facet_key: string | null;
}

// invariant: per-recall token economy is measure-only — never feeds ranking, gates eligibility, or enters the protocol payload; lives only in the in-memory RecallDiagnostics sub-object.
// see also: diagnostics.ts buildRecallDiagnostics/computeRecallTokenEconomy, bench-runner recall-diagnostics-schema.ts, longmemeval/diagnostics.ts.
// @anchor recall-token-economy-token-units: every "tokens" figure is the chars/4 estimate (OpenAI-style English); CJK is underestimated ~3-4x, so mean/p95 figures must carry this caveat.
export interface RecallTokenEconomy {
  // Sum of token_estimate over delivered candidates, same heuristic as RecallCandidate.token_estimate.
  readonly delivered_context_tokens_estimate: number;
  // Coarse-stage pool size flowing into fineAssess (matches candidate_pool_count).
  readonly coarse_pool_size: number;
  // Fine-assess evaluated count; equals the input pool length even when the budget drops rows.
  readonly fine_evaluated: number;
  // Distinct fusion streams with a non-null per_stream_rank across pre-budget candidates.
  readonly fusion_streams_with_hits: number;
  // Embedding provider inference calls for this recall: 0 when not requested / cache hit / failed, 1 on a fresh invocation.
  readonly embedding_inference_calls: number;
}

export type RecallGraphExpansionTrackedEdgeType =
  | "derives_from"
  | "recalls"
  | "supports";

export type RecallGraphExpansionPlaneCountPerHop = readonly [number, number];

export type RecallGraphExpansionPlaneCountPerEdgeType = Readonly<
  Record<RecallGraphExpansionTrackedEdgeType, number>
>;

// invariant: multi-seed fan-in measured per addGraphExpansionCandidates call; when entity_seed contributes 2+ seeds each expands independently and per-seed counts aggregate here. see also: recall-service.ts addGraphExpansionCandidates.
export interface RecallMultiSeedGraphFanInDiagnostics {
  readonly distinct_seeds: number;
  readonly candidates_per_seed_p50: number;
  readonly candidates_per_seed_p95: number;
  readonly dedup_collisions: number;
}

export interface RecallGraphExpansionDiagnostics {
  readonly graph_expansion_plane_count_per_hop: RecallGraphExpansionPlaneCountPerHop;
  readonly graph_expansion_plane_count_per_edge_type: RecallGraphExpansionPlaneCountPerEdgeType;
  // Absent when no entity-derived seeds fanned in; absence preserves the legacy shape for readers that ignore the field. see also: recall-service.ts addGraphExpansionCandidates.
  readonly multi_seed_graph_fan_in?: Readonly<RecallMultiSeedGraphFanInDiagnostics>;
}

export type RecallAnswerRerankStatus =
  | "not_requested"
  | "not_applicable"
  | "returned"
  | "failed";

export type RecallAnswerRerankFailureClass =
  | "invalid_score_count"
  | "invalid_score_value"
  | "service_error";

export interface RecallAnswerRerankDiagnostics {
  readonly status: RecallAnswerRerankStatus;
  readonly expected_count: number;
  readonly scored_count: number;
  readonly failure_class: RecallAnswerRerankFailureClass | null;
}

export interface RecallDiagnostics {
  readonly query_probes: {
    readonly normalized_query: string | null;
    readonly subject_hints: readonly string[];
    readonly object_ids: readonly string[];
    readonly evidence_refs: readonly string[];
    readonly run_ids: readonly string[];
    readonly surface_ids: readonly string[];
    readonly file_paths: readonly string[];
    readonly command_names: readonly string[];
    readonly package_names: readonly string[];
    readonly task_refs: readonly string[];
    readonly dimensions: readonly string[];
    readonly scope_classes: readonly string[];
    readonly domain_tags: readonly string[];
    readonly lexical_terms: readonly string[];
    readonly expanded_terms: readonly string[];
    readonly phrases: readonly string[];
    readonly char_ngrams: readonly string[];
    readonly date_terms: readonly string[];
  };
  readonly query_sought_facets: readonly string[];
  readonly total_scanned: number;
  readonly candidate_pool_count: number;
  readonly pre_budget_count: number;
  readonly delivered_count: number;
  readonly embedding_provider_status: RecallEmbeddingProviderStatus;
  readonly provider_degradation_reason: string | null;
  readonly answer_rerank_status: RecallAnswerRerankStatus;
  readonly answer_rerank_expected_count: number;
  readonly answer_rerank_scored_count: number;
  readonly answer_rerank_failure_class: RecallAnswerRerankFailureClass | null;
  readonly degradation_reasons?: readonly RecallDegradationReason[];
  readonly embedding_workspace_scan_cap?: number;
  readonly embedding_workspace_scanned_count?: number;
  readonly embedding_workspace_truncated?: boolean;
  readonly embedding_workspace_provider_kind?: string;
  readonly embedding_workspace_model_id?: string;
  readonly embedding_workspace_schema_version?: number;
  readonly graph_expansion_plane_count_per_hop: RecallGraphExpansionPlaneCountPerHop;
  readonly graph_expansion_plane_count_per_edge_type: RecallGraphExpansionPlaneCountPerEdgeType;
  // Present only when entity_seed drove 1+ seeds into graph fan-in; absence means content/structural-seed driven only.
  readonly multi_seed_graph_fan_in?: Readonly<RecallMultiSeedGraphFanInDiagnostics>;
  readonly fusion_breakdown: readonly Readonly<RecallFusionBreakdown>[];
  readonly candidates: readonly Readonly<RecallCandidateDiagnostic>[];
  // Per-recall token instrument; emitted on both normal and degraded paths to keep bench coverage at 100% without synthetic zero samples.
  readonly token_economy?: Readonly<RecallTokenEconomy>;
  // Exclusive critical-path contributions: an earlier phase owns concurrent overlap, and a later phase reports residual wait.
  readonly phase_latency_ms?: Readonly<Record<string, number>>;
}
