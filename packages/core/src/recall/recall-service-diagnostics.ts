import type {
  BudgetSnapshot,
  EventLogEntry,
  EvidenceCapsule,
  ManifestationState,
  MemoryDimension as MemoryDimensionType,
  MemoryEntry,
  PathAnchorRef,
  PathRelation,
  ProjectMappingAnchor,
  RecallCandidate,
  RecallScoreFactors,
  RecallOriginPlane,
  SoulActiveConstraint,
  SoulRecallHostContext,
  SoulRecallTokenizerHint,
  SoulMemorySearchDegradationReason,
  Slot,
  StorageTier as StorageTierType,
  SynthesisCapsule
} from "@do-soul/alaya-protocol";
import type { ScopeClass } from "@do-soul/alaya-protocol";
import type {
  EmbeddingNeighborHit,
  EmbeddingWorkspaceNeighborResult,
  EmbeddingRecallSupplementResult,
  PreparedEmbeddingSupplement,
  PreparedEmbeddingQueryHandle
} from "../embedding-recall/embedding-recall-service.js";
import type {
  ManifestationBiasSidecarEntry
} from "../manifestation/manifestation-resolver.js";
import type {
  GlobalMemoryRecallCachePort,
  GlobalMemoryRecallPort
} from "./global-memory-recall-port.js";

export type RecallAdmissionPlane =
  | "activation"
  | "protected_winner"
  | "object_probe"
  | "evidence_anchor"
  | "domain_tag_cluster"
  | "session_surface_cohort"
  | "source_proximity"
  | "graph_expansion"
  | "path_expansion"
  | "lexical"
  // Coarse-injection candidates surfaced by the embedding workspace neighbor
  // scan. They have no lexical / structural anchor, so a separate plane name
  // keeps source-proximity / graph-expansion seed selection honest.
  | "semantic_supplement"
  // see also: collectEntityDerivedSeeds — query-time entity FTS hits that
  // both seed graph_expansion and admit candidates on their own plane.
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
  // see also: packages/core/src/recall/fusion-delivery.ts:scoreRecallFusionStream
  | "entity_seed"
  // invariant: path_expansion is the direct multi-session fan-in carrier.
  // Earned sparse co_recalled PathRelations fan a query that hits a
  // non-representative cohort member into same-session siblings via the unified
  // path plane.
  // see also: packages/core/src/recall/fusion-delivery.ts:scoreRecallFusionStream
  | "path_expansion"
  | "temporal_recency"
  | "workspace_activation";

export type RecallFusionStreamRanks = Readonly<Record<RecallFusionStream, number | null>>;
export type RecallFusionStreamContributions = Readonly<Record<RecallFusionStream, number>>;

export interface RecallFusionBreakdown {
  readonly candidate_key: string;
  readonly object_id: string;
  readonly object_kind: RecallCandidate["object_kind"];
  readonly origin_plane: RecallOriginPlane;
  readonly per_stream_rank: RecallFusionStreamRanks;
  readonly fused_rank: number;
  readonly fused_score: number;
  readonly fused_rank_contribution_per_stream: RecallFusionStreamContributions;
}

export interface RecallCandidateDiagnostic {
  readonly candidate_key: string;
  readonly object_id: string;
  readonly object_kind: RecallCandidate["object_kind"];
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
  readonly final_rank: number | null;
  readonly dropped_reason: RecallCandidateDropReason | null;
  readonly within_budget: boolean;
  readonly relevance_score: number;
  readonly lexical_rank: number | null;
  readonly structural_score: number;
  readonly score_factors: Readonly<RecallScoreFactors>;
  readonly source_channels: readonly string[];
  readonly path_expansion_sources: readonly RecallPathExpansionSourceDiagnostic[];
  // Per-stage delivery rank trajectory through fineAssess (1-based). Lets
  // diagnostics see WHERE a candidate fell out of the top-k delivery window:
  // natural fusion ordering vs feature rerank vs lexical priority vs a reserve
  // displacing it. reserved_by names the stage that pulled THIS candidate into
  // the window. Optional — provenance only, never feeds ranking.
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

export interface RecallPathExpansionSourceDiagnostic {
  readonly path_id: string;
  readonly seed_id: string;
  readonly seed_kind: "memory" | "time_concern";
  readonly target_object_id: string;
  readonly source_channel: "path_expansion" | "time_concern";
  // Which relation carried the candidate (constitution.relation_kind) and, when
  // the path is anchored on a specific object facet, which facet_key fired.
  // Provenance only — lets diagnostics attribute gold delivery to a relation/
  // facet instead of a flat "path_expansion" stream label.
  readonly relation_kind: string;
  readonly facet_key: string | null;
}

// invariant: per-recall token economy is measure-only instrumentation.
// It never feeds back into recall ranking, never gates eligibility, and
// never becomes part of the protocol payload — it lives entirely inside
// the in-memory RecallDiagnostics sub-object that the bench harness
// captures via BenchRecallDiagnosticsSchema.
// see also:
//   packages/core/src/recall/diagnostics.ts:buildRecallDiagnostics, computeRecallTokenEconomy
//   apps/bench-runner/src/harness/recall-diagnostics-schema.ts
//   apps/bench-runner/src/longmemeval/diagnostics.ts (KPI aggregation)
//
// @anchor recall-token-economy-token-units: every "tokens" figure is the
// chars/4 approximation produced by makeTokenEstimator (see resolveCharsPerToken
// above). The default 4 chars/token is OpenAI-style English heuristic; CJK
// content is underestimated by roughly 3-4x because Chinese / Japanese /
// Korean characters average closer to 1-1.5 chars/token under cl100k/o200k.
// Release notes citing mean / p95 figures must qualify with this caveat.
export interface RecallTokenEconomy {
  // Sum of token_estimate over candidates actually delivered to the caller.
  // Derived from the same chars/token heuristic the caller sees in the
  // delivered RecallCandidate.token_estimate field, so the figure agrees
  // with the bench's existing total_token_estimate KPI per recall.
  readonly delivered_context_tokens_estimate: number;
  // Coarse-stage pool size — the number of candidates flowing into
  // fineAssess, matching candidate_pool_count.
  readonly coarse_pool_size: number;
  // Fine-assess evaluated count — every coarse candidate has its fused
  // score and feature rerank computed before delivery truncation, so this
  // equals the input pool length even when the budget drops some rows.
  readonly fine_evaluated: number;
  // Number of distinct fusion streams that produced at least one non-null
  // per_stream_rank across all pre-budget candidates. Surfaces "how many
  // recall channels actually contributed signal" per call.
  readonly fusion_streams_with_hits: number;
  // Embedding provider inference calls attributable to this recall. 0 when
  // the provider was not requested, the snapshot was a cache hit, or the
  // provider failed before returning. 1 when the recall pipeline actually
  // consumed a fresh provider invocation for its query embedding.
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

// invariant: multi-seed fan-in is measured per addGraphExpansionCandidates
// call. When the entity_seed plane contributes 2+ distinct entity-derived
// seeds, each seed expands independently and the per-seed candidate counts
// are aggregated here so downstream tuning can read distribution shape
// without re-deriving from raw graph events.
// see also: recall-service.ts addGraphExpansionCandidates
export interface RecallMultiSeedGraphFanInDiagnostics {
  readonly distinct_seeds: number;
  readonly candidates_per_seed_p50: number;
  readonly candidates_per_seed_p95: number;
  readonly dedup_collisions: number;
}

export interface RecallGraphExpansionDiagnostics {
  readonly graph_expansion_plane_count_per_hop: RecallGraphExpansionPlaneCountPerHop;
  readonly graph_expansion_plane_count_per_edge_type: RecallGraphExpansionPlaneCountPerEdgeType;
  // Optional only when no entity-derived seeds were fanned in (distinct_seeds
  // would be 0 in that case). Absence preserves the legacy
  // RecallGraphExpansionDiagnostics shape so external readers that ignore
  // the field stay binary-compatible. see also: recall-service.ts
  // addGraphExpansionCandidates multi-seed fan-in path.
  readonly multi_seed_graph_fan_in?: Readonly<RecallMultiSeedGraphFanInDiagnostics>;
}

export interface RecallDiagnostics {
  readonly query_probes: {
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
  readonly total_scanned: number;
  readonly candidate_pool_count: number;
  readonly pre_budget_count: number;
  readonly delivered_count: number;
  readonly embedding_provider_status: RecallEmbeddingProviderStatus;
  readonly provider_degradation_reason: string | null;
  readonly embedding_workspace_scan_cap?: number;
  readonly embedding_workspace_scanned_count?: number;
  readonly embedding_workspace_truncated?: boolean;
  readonly embedding_workspace_provider_kind?: string;
  readonly embedding_workspace_model_id?: string;
  readonly embedding_workspace_schema_version?: number;
  readonly graph_expansion_plane_count_per_hop: RecallGraphExpansionPlaneCountPerHop;
  readonly graph_expansion_plane_count_per_edge_type: RecallGraphExpansionPlaneCountPerEdgeType;
  // Optional. Only present when the entity_seed plane drove 1+ entity-derived
  // seeds into graph fan-in for this recall. Absence means the recall's
  // graph_expansion plane was content/structural-seed driven only and has
  // no per-seed distribution to summarise.
  readonly multi_seed_graph_fan_in?: Readonly<RecallMultiSeedGraphFanInDiagnostics>;
  readonly fusion_breakdown: readonly Readonly<RecallFusionBreakdown>[];
  readonly candidates: readonly Readonly<RecallCandidateDiagnostic>[];
  // Per-recall structural token instrument. Optional only for legacy callers
  // and malformed diagnostics; RecallService emits it for both normal and
  // degraded recall paths so bench token-instrument coverage can stay at
  // 100% per recall call without inventing synthetic zero samples.
  readonly token_economy?: Readonly<RecallTokenEconomy>;
  // Per-phase wall-clock (ms) for offline latency-bottleneck localization.
  // Optional: only emitted on the instrumented full recall path.
  readonly phase_latency_ms?: Readonly<Record<string, number>>;
}
