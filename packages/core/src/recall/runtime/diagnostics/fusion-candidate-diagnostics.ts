import type { MemoryEntry, RecallCandidate, RecallOriginPlane, RecallScoreFactors } from
  "@do-soul/alaya-protocol";
import type { RecallCandidateSelectorObservation } from
  "./candidate-selector-observation.js";
import type {
  FloodFuelCoverageSummary,
  IntegratedFloodCandidateDiagnostics
} from "./flood-diagnostics.js";
import type { RecallAdmissionPlane, RecallCandidateDropReason } from "./vocabulary.js";

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
  | "workspace_activation";

export type RecallFusionStreamRanks = Readonly<Record<RecallFusionStream, number | null>>;
export type RecallFusionStreamContributions = Readonly<Record<RecallFusionStream, number>>;

export type RecallConformantAxis = "object" | "path" | "evidence" | "temporal" | "control";

export interface RecallFusionBreakdown {
  readonly candidate_key: string;
  readonly object_id: string;
  readonly object_kind: RecallCandidate["object_kind"];
  readonly origin_plane: RecallOriginPlane;
  readonly per_stream_rank: RecallFusionStreamRanks;
  readonly fused_rank: number;
  readonly fused_score: number;
  readonly fused_rank_contribution_per_stream: RecallFusionStreamContributions;
  readonly per_axis_rank?: Readonly<Record<RecallConformantAxis, number | null>>;
  readonly per_axis_contribution?: Readonly<Record<RecallConformantAxis, number>>;
  readonly flood_potential?: Readonly<IntegratedFloodCandidateDiagnostics>;
  readonly flood_fuel_coverage?: Readonly<FloodFuelCoverageSummary>;
}

export type RecallAdmissionDiagnosticPass = "final_selector";

export interface RecallAdmissionAttemptDiagnostic {
  readonly pass: RecallAdmissionDiagnosticPass;
  readonly selection_order: number;
  readonly admitted: boolean;
  readonly dropped_reason: RecallCandidateDropReason | null;
}

export interface RecallCandidateDiagnostic {
  readonly candidate_key: string;
  readonly object_id: string;
  readonly object_kind: RecallCandidate["object_kind"];
  readonly created_at: string;
  // Object's memory dimension (typed facet) — for facet-separation diagnostics. Provenance only.
  readonly dimension: string;
  readonly origin_plane: RecallOriginPlane;
  readonly admission_planes: readonly RecallAdmissionPlane[];
  readonly plane_first_admitted: RecallAdmissionPlane;
  readonly plane_winning_admission: RecallAdmissionPlane;
  readonly pre_budget_rank: number;
  readonly selection_order: number;
  readonly admission_attempts: readonly Readonly<RecallAdmissionAttemptDiagnostic>[];
  readonly evidence_projection_matches: readonly Readonly<
    import("../recall-service-results.js").RecallEvidenceProjectionMatchReceipt
  >[];
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
  readonly deep_head_trace?: Readonly<
    import("../../rerank/deep-head.js").RecallDeepHeadTrace
  >;
  readonly coverage_marginal_gain?: number;
  // Capture-only upstream state; delivery never reads this field.
  readonly selector_observation?: Readonly<RecallCandidateSelectorObservation>;
  readonly path_suppression_score: number;
  // Live delivery-stage ranks (1-based). Provenance only — never feeds ranking.
  readonly rank_after_fusion?: number;
  readonly rank_after_feature_rerank?: number;
  readonly rank_after_coverage_selector?: number;
  readonly coverage_selector_action?: "noop" | "kept" | "promoted" | "displaced";
  // Retired stages: producers omit these. Optional only for old diagnostic dumps.
  readonly rank_after_lexical_priority?: number;
  readonly rank_after_synthesis_reserve?: number;
  readonly rank_after_structural_reserve?: number;
  readonly rank_after_session_coverage?: number;
  readonly session_coverage_action?: "noop" | "kept" | "promoted" | "displaced";
  readonly reserved_by?: "none" | "synthesis" | "structural";
  readonly session_key?: string;
  readonly source_cohort_key?: string | null;
}

export interface FineAssessmentPrunedCandidateDiagnostic {
  readonly candidate_key: string;
  readonly origin_plane: RecallOriginPlane;
  readonly object_kind: RecallCandidate["object_kind"];
  readonly object_id: string;
  readonly coarse_index: number;
  readonly drop_reason: "fine_assessment_cap";
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
  readonly answer_support?: Readonly<
    import("../../query/recall-candidate-answer-support.js").RecallCandidateAnswerSupport
  >;
  readonly answer_support_observations?: readonly Readonly<
    import("../../query/recall-answer-support-observation.js").RecallAnswerSupportObservation
  >[];
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
