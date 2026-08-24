import type { RecallPacketPlanTrace } from
  "../delivery/packet-plan/packet-plan-trace.js";
import type { RecallFiniteFieldChannelCapture } from
  "../field/finite-field-capture.js";
import type { RecallQueryEntityExtractionCapture } from
  "../field/query-entity-attribution-producer.js";
import type { RecallFieldRefinementStopCertificate } from
  "../field/refinement/field-refinement-stop-certificate.js";
import type { PinnedProjectionCandidateSelection } from
  "../field/retrieval/projection/pinned-projection-selection.js";
import type {
  RecallAnswerRerankFailureClass,
  RecallAnswerRerankStatus,
  RecallEvidenceEmbeddingFailureClass,
  RecallEvidenceEmbeddingStatus
} from "./diagnostics/stage-status.js";
import type {
  FineAssessmentPrunedCandidateDiagnostic,
  RecallCandidateDiagnostic,
  RecallFusionBreakdown
} from "./diagnostics/fusion-candidate-diagnostics.js";
import type {
  RecallDegradationReason,
  RecallEmbeddingProviderStatus
} from "./diagnostics/vocabulary.js";

export type {
  RecallAnswerRerankDiagnostics,
  RecallAnswerRerankFailureClass,
  RecallAnswerRerankStatus,
  RecallEvidenceEmbeddingFailureClass,
  RecallEvidenceEmbeddingStatus
} from "./diagnostics/stage-status.js";
export type {
  RecallAdmissionPlane,
  RecallCandidateDropReason,
  RecallDegradationReason,
  RecallEmbeddingProviderStatus,
  RecallEmbeddingWorkspaceScanDiagnostics
} from "./diagnostics/vocabulary.js";
export {
  RECALL_FLOOD_EDGE_REASONS
} from "./diagnostics/flood-diagnostics.js";
export type {
  FloodAxisInactiveReason,
  FloodFuelCoverageSummary,
  IntegratedFloodCandidateDiagnostics,
  RecallFloodEdgeTraceV1,
  RecallFloodH1TransitionCounts
} from "./diagnostics/flood-diagnostics.js";
export type {
  FineAssessmentPrunedCandidateDiagnostic,
  RecallAdmissionAttemptDiagnostic,
  RecallAdmissionDiagnosticPass,
  RecallCandidateAnswerFeatures,
  RecallCandidateDiagnostic,
  RecallSelectGammaDecisionDiagnostic,
  RecallConformantAxis,
  RecallFusionBreakdown,
  RecallFusionStream,
  RecallFusionStreamContributions,
  RecallFusionStreamRanks,
  RecallPathExpansionSourceDiagnostic
} from "./diagnostics/fusion-candidate-diagnostics.js";

// invariant: per-recall token economy is measure-only — never feeds ranking, gates eligibility, or enters the protocol payload; lives only in the in-memory RecallDiagnostics sub-object.
// see also: diagnostics.ts buildRecallDiagnostics/computeRecallTokenEconomy, bench-runner recall-diagnostics-schema.ts, longmemeval/diagnostics.ts.
// @anchor recall-token-economy-token-units: every "tokens" figure is the chars/4 estimate (OpenAI-style English); CJK is underestimated ~3-4x, so mean/p95 figures must carry this caveat.
export interface RecallTokenEconomy {
  readonly delivered_context_tokens_estimate: number;
  readonly coarse_pool_size: number;
  readonly fine_evaluated: number;
  // Must remain zero: a non-zero value would reveal hidden pre-selection deletion.
  readonly fine_pruned_count: number;
  // Must remain zero because channel priority cannot own candidate deletion.
  readonly fine_priority_overflow_count: number;
  readonly fusion_families_with_hits: number;
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
  readonly answer_shape_plan?: Readonly<
    import("../query/recall-answer-shape-plan.js").RecallAnswerShapePlan
  >;
  readonly query_sought_facets: readonly string[];
  readonly retrieval_field_captures?: readonly Readonly<RecallFiniteFieldChannelCapture>[];
  readonly retrieval_field_refinement_receipts?: readonly Readonly<
    import("../field/refinement/field-refinement-receipt.js")
      .RecallRetrievalFieldRefinementReceipt
  >[];
  readonly field_refinement_stop_certificate?:
    Readonly<RecallFieldRefinementStopCertificate>;
  readonly query_condition?: Readonly<
    import("./query-condition-parity.js").QueryConditionParityView
  >;
  readonly field_projection_trace?: Readonly<
    PinnedProjectionCandidateSelection & {
      readonly generation_id: string;
      readonly condition_digest: string;
    }
  >;
  readonly query_entity_extraction?: Readonly<RecallQueryEntityExtractionCapture>;
  readonly query_fact_frame_extraction?: Readonly<
    import("../field/query-attribution/query-fact-frame-attribution-producer.js")
      .RecallQueryFactFrameExtractionCapture
  >;
  readonly query_open_semantic_factor_formation?: Readonly<
    import("@do-soul/alaya-protocol").OpenSemanticFactorFormationCapture
  >;
  readonly query_open_semantic_factor_completeness_receipt?: Readonly<
    import("@do-soul/alaya-protocol").QueryOsfSemanticCompletenessReceipt
  >;
  readonly open_semantic_factor_compatibility_trace?: Readonly<
    import("../field/open-semantic-factors/compatibility-trace.js")
      .OpenSemanticFactorCompatibilityTrace
  >;
  readonly open_semantic_factor_composition?: Readonly<
    import("../field/open-semantic-factors/composition.js")
      .OpenSemanticFactorCompositionReceipt
  >;
  readonly open_semantic_factor_activation?: Readonly<
    import("../field/open-semantic-factors/activation.js")
      .OpenSemanticFactorActivationReceipt
  >;
  readonly kind_constraint_alignment?: Readonly<
    import("../field/kind-projection/alignment.js").KindConstraintAlignmentReceipt
  >;
  readonly total_scanned: number;
  readonly candidate_pool_count: number;
  readonly pre_budget_count: number;
  readonly delivered_count: number;
  readonly packet_plan_trace?: Readonly<RecallPacketPlanTrace>;
  readonly embedding_provider_status: RecallEmbeddingProviderStatus;
  readonly embedding_supplement_status:
    import("../supplements/supplements.js").EmbeddingSupplementCollectionStatus;
  readonly evidence_embedding_status: RecallEvidenceEmbeddingStatus;
  readonly evidence_embedding_expected_count: number;
  readonly evidence_embedding_scored_count: number;
  readonly evidence_embedding_inference_calls: number;
  readonly evidence_embedding_latency_ms: number;
  readonly evidence_embedding_failure_class: RecallEvidenceEmbeddingFailureClass | null;
  readonly evidence_embedding_selection_receipt?: Readonly<
    import("../../embedding-recall/types.js").EvidenceCandidateScoringSelectionReceipt
  >;
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
  // Empty unless diagnosticCapture requested per-candidate flood/fusion dumps.
  readonly fusion_breakdown: readonly Readonly<RecallFusionBreakdown>[];
  readonly candidates: readonly Readonly<RecallCandidateDiagnostic>[];
  readonly fine_assessment_pruned_candidates:
    readonly Readonly<FineAssessmentPrunedCandidateDiagnostic>[];
  // Per-recall token instrument; emitted on both normal and degraded paths to keep bench coverage at 100% without synthetic zero samples.
  readonly token_economy?: Readonly<RecallTokenEconomy>;
  // Exclusive critical-path contributions: an earlier phase owns concurrent overlap, and a later phase reports residual wait.
  readonly phase_latency_ms?: Readonly<Record<string, number>>;
}
