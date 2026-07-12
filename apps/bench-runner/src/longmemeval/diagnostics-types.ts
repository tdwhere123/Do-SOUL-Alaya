import {
  BenchEmbeddingProviderStateSchema,
  DiagnosticActiveConstraintResultSchema,
  DiagnosticCandidateAnswerFeaturesSchema,
  DiagnosticFloodEdgeTraceV1Schema,
  DiagnosticFloodPotentialSchema,
  DiagnosticRecallResultSchema,
  LongMemEvalGoldDiagnosticSchema,
  LongMemEvalMissTaxonomySchema,
  LongMemEvalQuestionDiagnosticSchema,
  LongMemEvalQuestionMeasurementAxesSchema,
  DiagnosticQueryProbesSchema
} from "./diagnostics-schema.js";
import type { BenchCommitResolution } from "../shared/version.js";
import type { z } from "zod";

// @anchor diagnostics-schema: the persisted shape of these records is owned
// by diagnostics-schema.ts; these aliases keep one source of truth.
export type BenchEmbeddingProviderState = z.infer<
  typeof BenchEmbeddingProviderStateSchema
>;

export type DiagnosticRecallResult = z.infer<typeof DiagnosticRecallResultSchema>;

export type DiagnosticActiveConstraintResult = z.infer<
  typeof DiagnosticActiveConstraintResultSchema
>;

export type DiagnosticScoreFactors = Readonly<Record<string, unknown>>;
export type DiagnosticStreamRanks = Readonly<Record<string, number | null>>;
export type DiagnosticStreamContributions = Readonly<Record<string, number>>;
export type DiagnosticAxisRanks = Readonly<Record<string, number | null>>;
export type DiagnosticAxisContributions = Readonly<Record<string, number>>;
export type DiagnosticQueryProbes = z.infer<typeof DiagnosticQueryProbesSchema>;
export type DiagnosticCandidateAnswerFeatures = z.infer<
  typeof DiagnosticCandidateAnswerFeaturesSchema
>;
export type DiagnosticFloodEdgeTraceV1 = z.infer<typeof DiagnosticFloodEdgeTraceV1Schema>;
export type DiagnosticFloodPotential = z.infer<typeof DiagnosticFloodPotentialSchema>;
export type DiagnosticFloodFuelCoverage = Readonly<{
  readonly candidates_total: number;
  readonly cold_start_count: number;
  readonly fuel_verified_count: number;
  readonly slice_active_count: number;
  readonly path_active_count: number;
  readonly evidence_active_count: number;
}>;

export type LongMemEvalReplayCandidate = Readonly<{
  readonly object_id: string;
  readonly object_kind?: string;
  readonly candidate_key: string;
  readonly dimension: string | null;
  readonly final_rank: number | null;
  readonly pre_budget_rank: number | null;
  readonly selection_order: number | null;
  readonly fused_rank: number | null;
  readonly fused_score: number | null;
  readonly per_stream_rank: DiagnosticStreamRanks | null;
  readonly fused_rank_contribution_per_stream: DiagnosticStreamContributions | null;
  readonly per_axis_rank: DiagnosticAxisRanks | null;
  readonly per_axis_contribution: DiagnosticAxisContributions | null;
  readonly flood_potential: DiagnosticFloodPotential | null;
  readonly plane_first_admitted: string | null;
  readonly plane_winning_admission: string | null;
  readonly source_planes: readonly string[];
  readonly source_channels: readonly string[];
  readonly rank_after_fusion: number | null;
  readonly rank_after_feature_rerank: number | null;
  readonly rank_after_lexical_priority: number | null;
  readonly rank_after_synthesis_reserve: number | null;
  readonly rank_after_structural_reserve: number | null;
  readonly rank_after_coverage_selector: number | null;
  readonly rank_after_session_coverage: number | null;
  readonly answer_features: DiagnosticCandidateAnswerFeatures | null;
  readonly path_suppression_score: number | null;
  readonly score_factors: DiagnosticScoreFactors;
}>;

export interface DiagnosticRecallResultInput {
  readonly object_id: string;
  readonly object_kind?: string | null;
  readonly rank: number;
  readonly relevance_score: number;
  readonly fused_rank?: number | null;
  readonly fused_score?: number | null;
  readonly abstention_confidence_score?: number | null;
  readonly plane_first_admitted?: string | null;
  readonly plane_winning_admission?: string | null;
  readonly score_factors?: DiagnosticScoreFactors | null;
  readonly per_axis_rank?: DiagnosticAxisRanks | null;
  readonly per_axis_contribution?: DiagnosticAxisContributions | null;
  readonly flood_potential?: DiagnosticFloodPotential | null;
  readonly flood_fuel_coverage?: DiagnosticFloodFuelCoverage | null;
}

export type LongMemEvalGoldDiagnostic = z.infer<
  typeof LongMemEvalGoldDiagnosticSchema
>;

export type LongMemEvalQuestionDiagnostic = z.infer<
  typeof LongMemEvalQuestionDiagnosticSchema
>;

export type LongMemEvalQuestionMeasurementAxes = z.infer<
  typeof LongMemEvalQuestionMeasurementAxesSchema
>;

export type LongMemEvalMissTaxonomy = z.infer<
  typeof LongMemEvalMissTaxonomySchema
>;

export type LongMemEvalMissTaxonomySummary = Readonly<
  Record<LongMemEvalMissTaxonomy, number>
>;

export type LongMemEvalMissTaxonomyDistribution = LongMemEvalMissTaxonomySummary;

export interface ProviderStateSummary {
  readonly total: number;
  readonly provider_returned: number;
  readonly provider_pending: number;
  readonly provider_failed: number;
  readonly provider_not_requested: number;
  readonly unknown: number;
  readonly provider_returned_rate: number;
  readonly provider_pending_rate: number;
  readonly provider_failed_rate: number;
  readonly provider_not_requested_rate: number;
  readonly unknown_rate: number;
}

export interface LongMemEvalEmbeddingVectorCacheSummary {
  readonly expected_count: number;
  readonly ready_count: number;
  readonly not_ready_count: number;
  readonly ready_rate: number;
  readonly max_pass_count: number;
}

export interface LongMemEvalQueryEmbeddingCacheSummary {
  readonly requested_count: number;
  readonly ready_count: number;
  readonly not_ready_count: number;
  readonly ready_rate: number;
  readonly cache_hit_count: number;
  readonly provider_requested_count: number;
  readonly last_error?: string;
}

export interface LongMemEvalReportUsageSummary {
  readonly mode: "none" | "always-used" | "gold-only" | "mixed";
  readonly reports_attempted: number;
  readonly reports_used: number;
  readonly reports_skipped: number;
  readonly used_object_count: number;
}

export interface LongMemEvalQuestionFailureSummary {
  readonly failed_count: number;
  readonly completed_count: number;
  readonly failed_question_ids: readonly string[];
}

export interface LongMemEvalReportSideEffectSnapshot {
  readonly question_id: string;
  readonly workspace_id: string;
  // invariant: `memory_graph_edges_*` are COMPATIBILITY ALIASES of the
  // unified `path_relations` (path-plane) counts, NOT a live
  // `memory_graph_edges` table — that table is retired (migration 085).
  // Names are kept verbatim so historical bench-archive schemas stay stable;
  // do not rename. Populated from path-plane counts in runner.ts
  // (readLongMemEvalReportSideEffectSnapshot); see graph-health-service.ts.
  readonly memory_graph_edges_total: number;
  readonly memory_graph_edges_by_type: Readonly<Record<string, number>>;
  readonly recalls_edge_count: number;
  readonly path_relations_total: number;
  readonly latest_path_event_at: string | null;
  readonly warnings: readonly string[];
}

export interface LongMemEvalReportSideEffectSummary {
  readonly mode: "none" | "always-used" | "gold-only" | "mixed";
  readonly workspaces_observed: number;
  readonly memory_graph_edges_total: number;
  readonly memory_graph_edges_by_type: Readonly<Record<string, number>>;
  readonly recalls_edge_count: number;
  readonly path_relations_total: number;
  readonly latest_path_event_at: string | null;
  readonly snapshots: readonly LongMemEvalReportSideEffectSnapshot[];
}

export type LongMemEvalGraphExpansionPlaneCountPerHop = readonly [number, number];

export interface LongMemEvalGraphExpansionPlaneCountPerEdgeType {
  readonly derives_from: number;
  readonly recalls: number;
  readonly supports: number;
}

export type LongMemEvalPhaseLatencyMs = Readonly<Record<string, number>>;

export interface LongMemEvalRecallEvidenceSummary {
  readonly delivered_result_count: number;
  readonly graph_support_gold_count: number;
  readonly path_plasticity_gold_count: number;
  readonly graph_expansion_plane_count: number;
  readonly path_expansion_plane_count: number;
  readonly graph_expansion_plane_count_per_hop: LongMemEvalGraphExpansionPlaneCountPerHop;
  readonly graph_expansion_plane_count_per_edge_type: Readonly<LongMemEvalGraphExpansionPlaneCountPerEdgeType>;
  readonly delivered_plane_counts: Readonly<{
    readonly first_admitted: Readonly<Record<string, number>>;
    readonly winning_admission: Readonly<Record<string, number>>;
  }>;
  readonly miss_taxonomy_distribution: LongMemEvalMissTaxonomyDistribution;
  readonly gold_source_channel_counts: Readonly<Record<string, number>>;
  readonly gold_source_plane_counts: Readonly<Record<string, number>>;
}

export interface LongMemEvalDiagnosticsSidecar {
  readonly schema_version: 1;
  readonly bench_name: "public" | "public-multiturn" | "public-crossquestion" | "public-locomo";
  readonly split: string;
  readonly run_at: string;
  readonly alaya_commit: string;
  readonly commit_resolution?: BenchCommitResolution;
  readonly recall_pipeline_version?: string;
  readonly embedding_provider: string;
  readonly embedding_mode: "disabled" | "env";
  readonly policy_shape?: "stress" | "chat";
  readonly simulate_report?: "none" | "always-used" | "gold-only" | "mixed";
  readonly seed_extraction_path?: {
    readonly path: "official_api_compile" | "no_credentials_fallback";
    readonly cache_hits: number;
    readonly llm_calls: number;
    readonly offline_fallbacks: number;
    readonly live_extraction_failures: number;
    readonly cached_extraction_failures: number;
    readonly facts_produced: number;
    readonly signals_dropped: number;
    readonly parse_dropped: number;
    readonly compile_overflow_dropped: number;
    readonly signals_dropped_by_reason: {
      readonly candidate_absent: number;
      readonly materialization_drop: number;
    };
  };
  readonly seed_fuel_inventory?: {
    readonly objects_total: number;
    readonly evidence_refs_total: number;
    readonly facet_anchors_total: number;
    readonly path_candidates_total: number;
    readonly support_bearing_candidates: number;
  };
  readonly report_usage?: LongMemEvalReportUsageSummary;
  readonly question_failures?: LongMemEvalQuestionFailureSummary;
  readonly report_side_effects?: LongMemEvalReportSideEffectSummary;
  readonly scored_recall_evidence?: LongMemEvalRecallEvidenceSummary;
  readonly embedding_vector_cache?: LongMemEvalEmbeddingVectorCacheSummary;
  readonly query_embedding_cache?: LongMemEvalQueryEmbeddingCacheSummary;
  readonly miss_taxonomy_summary?: LongMemEvalMissTaxonomySummary;
  readonly provider_state_summary: ProviderStateSummary;
  readonly questions: readonly LongMemEvalQuestionDiagnostic[];
}

export interface LongMemEvalCompactDiagnosticsSidecar {
  readonly schema_version: 1;
  readonly compact_schema_version: 1;
  readonly bench_name: LongMemEvalDiagnosticsSidecar["bench_name"];
  readonly split: string;
  readonly run_at: string;
  readonly alaya_commit: string;
  readonly commit_resolution?: BenchCommitResolution;
  readonly recall_pipeline_version?: string;
  readonly embedding_provider: string;
  readonly embedding_mode: "disabled" | "env";
  readonly policy_shape?: "stress" | "chat";
  readonly simulate_report?: "none" | "always-used" | "gold-only" | "mixed";
  readonly question_count: number;
  readonly full_diagnostics_artifact_path: string;
  readonly provider_state_summary: ProviderStateSummary;
  readonly seed_extraction_path?: LongMemEvalDiagnosticsSidecar["seed_extraction_path"];
  readonly report_usage?: LongMemEvalReportUsageSummary;
  readonly question_failures?: LongMemEvalQuestionFailureSummary;
  readonly report_side_effects?: Omit<LongMemEvalReportSideEffectSummary, "snapshots"> & {
    readonly snapshot_count: number;
  };
  readonly scored_recall_evidence?: LongMemEvalRecallEvidenceSummary;
  readonly embedding_vector_cache?: LongMemEvalEmbeddingVectorCacheSummary;
  readonly query_embedding_cache?: LongMemEvalQueryEmbeddingCacheSummary;
  readonly miss_taxonomy_summary?: LongMemEvalMissTaxonomySummary;
  readonly questions?: readonly LongMemEvalQuestionDiagnostic[];
}

export interface NarrowRecallDiagnostics {
  readonly keys: readonly string[];
  readonly queryProbes: DiagnosticQueryProbes | null;
  readonly querySoughtFacets: readonly string[] | null;
  readonly candidatePoolComplete: boolean;
  readonly candidatesByObjectId: ReadonlyMap<string, CandidateDiagnostic>;
  readonly candidatesByObjectIdentity: ReadonlyMap<string, CandidateDiagnostic>;
  readonly candidatesByCandidateKey: ReadonlyMap<string, CandidateDiagnostic>;
  readonly candidateKeysByObjectId: ReadonlyMap<string, readonly string[]>;
  readonly providerState: BenchEmbeddingProviderState;
  readonly providerDegradationReason: string | null;
  readonly graphExpansionPlaneCountPerHop: LongMemEvalGraphExpansionPlaneCountPerHop;
  readonly graphExpansionPlaneCountPerEdgeType: Readonly<LongMemEvalGraphExpansionPlaneCountPerEdgeType>;
  readonly phaseLatencyMs: LongMemEvalPhaseLatencyMs | null;
}

export interface CandidateDiagnostic {
  readonly candidateKey: string;
  readonly objectId: string;
  readonly objectKind: string;
  readonly createdAt: string | null;
  readonly facetOverlap: number | null;
  readonly dimension: string | null;
  readonly originPlane: string;
  readonly preBudgetRank: number | null;
  readonly selectionOrder: number | null;
  readonly finalRank: number | null;
  readonly fusedRank: number | null;
  readonly fusedScore: number | null;
  readonly perStreamRank: DiagnosticStreamRanks | null;
  readonly fusedRankContributionPerStream: DiagnosticStreamContributions | null;
  readonly perAxisRank: DiagnosticAxisRanks | null;
  readonly perAxisContribution: DiagnosticAxisContributions | null;
  readonly floodPotential: DiagnosticFloodPotential | null;
  readonly floodFuelCoverage: DiagnosticFloodFuelCoverage | null;
  readonly planeFirstAdmitted: string | null;
  readonly planeWinningAdmission: string | null;
  readonly sourcePlanes: readonly string[];
  readonly lexicalRank: number | null;
  readonly structuralScore: number | null;
  readonly scoreFactors: DiagnosticScoreFactors | null;
  readonly sourceChannels: readonly string[];
  readonly budgetDropReason: string | null;
  readonly rankAfterFusion: number | null;
  readonly rankAfterFeatureRerank: number | null;
  readonly rankAfterLexicalPriority: number | null;
  readonly rankAfterSynthesisReserve: number | null;
  readonly rankAfterStructuralReserve: number | null;
  readonly rankAfterCoverageSelector: number | null;
  readonly rankAfterSessionCoverage: number | null;
  readonly answerFeatures: DiagnosticCandidateAnswerFeatures | null;
  readonly pathSuppressionScore: number | null;
  readonly coverageSelectorAction: DeliveryStageAction | null;
  readonly sessionCoverageAction: DeliveryStageAction | null;
  readonly sessionKey: string | null;
  readonly sourceCohortKey: string | null;
  readonly reservedBy: string | null;
}

export type DeliveryStageAction = "noop" | "kept" | "promoted" | "displaced";

export interface ReadCandidateDiagnosticsResult {
  readonly candidatePoolComplete: boolean;
  readonly byObjectId: ReadonlyMap<string, CandidateDiagnostic>;
  readonly byObjectIdentity: ReadonlyMap<string, CandidateDiagnostic>;
  readonly byCandidateKey: ReadonlyMap<string, CandidateDiagnostic>;
  readonly keysByObjectId: ReadonlyMap<string, readonly string[]>;
}
