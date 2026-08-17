import { z } from "zod";
import { RecallOriginPlaneSchema } from "@do-soul/alaya-protocol";
import { assertBiEncoderRunActivation } from "../embedding/embedding-treatment-activation.js";
import { refuseRetiredLocalCrossEncoderTreatment } from
  "../strict-treatment-config.js";
import {
  RecallAnswerShapePlanSchema,
  RecallAnswerSupportObservationSchema,
  RecallCandidateAnswerSupportSchema,
  RecallDeepHeadTraceSchema
} from "./answer-trace-schema.js";
import {
  BenchAnswerRerankFailureClassSchema,
  BenchAnswerRerankStatusSchema,
  RecallMultiSeedGraphFanInDiagnosticsSchema,
  RecallPacketPlanTraceSchema
} from "./recall-diagnostics-support-schema.js";
import { EvidenceEmbeddingDiagnosticsSchemaShape } from
  "./evidence/evidence-scoring-schema.js";
import {
  RecallFloodEdgeTraceV1Schema,
  RecallH1FuelCoverageSchemaShape,
  RecallH1MaxProductSchema,
  RecallH1OverlaySchema,
  validateRecallH1FloodOverlayRelationship
} from "./h1/recall-h1-diagnostics-schema.js";
import { RecallCandidateSelectorObservationSchema } from
  "./candidate-selector-observation-schema.js";
import { FieldProjectionTraceSchema, RecallQueryConditionParitySchema } from
  "./field/field-projection-diagnostics-schema.js";
import {
  RecallAdmissionAttemptDiagnosticSchema,
  RecallEvidenceProjectionMatchReceiptSchema
} from "./candidate-projection-diagnostics-schema.js";
import { RecallFieldRefinementStopCertificateSchema, RecallFiniteFieldChannelCaptureSchema,
  RecallQueryEntityExtractionCaptureSchema, RecallQueryFactFrameExtractionCaptureSchema,
  RecallRetrievalFieldRefinementReceiptSchema } from "./field-capture-schema.js";
import { OpenSemanticFactorActivationReceiptSchema, OpenSemanticFactorCompatibilityTraceSchema,
  OpenSemanticFactorCompositionReceiptSchema, OpenSemanticFactorFormationCaptureSchema } from
  "./semantic-factors/open-semantic-factor-diagnostics-schema.js";
export { RecallEvidenceProjectionMatchReceiptSchema } from
  "./candidate-projection-diagnostics-schema.js";
export {
  BenchAnswerRerankFailureClassSchema,
  BenchAnswerRerankStatusSchema,
  BenchEvidenceEmbeddingFailureClassSchema,
  BenchEvidenceEmbeddingStatusSchema
} from "./recall-diagnostics-support-schema.js";
export { EvidenceCandidateScoringSelectionReceiptSchema } from
  "./evidence/evidence-scoring-schema.js";

const RecallDiagnosticObjectKindSchema = z.enum(["memory_entry", "evidence_capsule", "synthesis_capsule"]);
const RecallFusionStreamRankSchema = z
  .object({
    lexical_fts: z.number().int().positive().nullable(),
    trigram_fts: z.number().int().positive().nullable(),
    synthesis_fts: z.number().int().positive().nullable(),
    evidence_fts: z.number().int().positive().nullable(),
    evidence_structural_agreement: z.number().int().positive().nullable(),
    source_proximity: z.number().int().positive().nullable(),
    source_evidence_agreement: z.number().int().positive().nullable(),
    subject_alignment: z.number().int().positive().nullable(),
    structural: z.number().int().positive().nullable(),
    existing_score: z.number().int().positive().nullable(),
    embedding_similarity: z.number().int().positive().nullable(),
    graph_expansion: z.number().int().positive().nullable(),
    entity_seed: z.number().int().positive().nullable(),
    path_expansion: z.number().int().positive().nullable(),
    temporal_recency: z.number().int().positive().nullable(),
    workspace_activation: z.number().int().positive().nullable(),
    facet_overlap: z.number().int().positive().nullable().optional()
  })
  .strict()
  .readonly();

const RecallFusionStreamContributionSchema = z
  .object({
    lexical_fts: z.number().min(0),
    trigram_fts: z.number().min(0),
    synthesis_fts: z.number().min(0),
    evidence_fts: z.number().min(0),
    evidence_structural_agreement: z.number().min(0),
    source_proximity: z.number().min(0),
    source_evidence_agreement: z.number().min(0),
    subject_alignment: z.number().min(0),
    structural: z.number().min(0),
    existing_score: z.number().min(0),
    embedding_similarity: z.number().min(0),
    graph_expansion: z.number().min(0),
    entity_seed: z.number().min(0),
    path_expansion: z.number().min(0),
    temporal_recency: z.number().min(0),
    workspace_activation: z.number().min(0),
    facet_overlap: z.number().min(0).optional()
  })
  .strict()
  .readonly();

const RecallConformantAxisRankSchema = z
  .record(z.string(), z.number().int().positive().nullable())
  .readonly();

const RecallConformantAxisContributionSchema = z
  .record(z.string(), z.number().min(0))
  .readonly();

const RecallIntegratedFloodCandidateDiagnosticsSchema = z
  .object({
    R_obj: z.number().min(0),
    Slice: z.number().min(0),
    A_path: z.number().min(0),
    B_evidence: z.number().min(0),
    E_direct: z.number().min(0),
    omega: z.number().min(0),
    Flood: z.number().min(0),
    lambda: z.number().min(0),
    beta: z.number().min(0),
    final_score: z.number().min(0),
    slice_status: z.string().min(1),
    path_status: z.string().min(1),
    evidence_status: z.string().min(1),
    e_direct_status: z.string().min(1),
    fuel_verified: z.boolean(),
    edge_traces: z.array(RecallFloodEdgeTraceV1Schema).max(16).readonly().optional(),
    edge_trace_truncated_count: z.number().int().nonnegative().optional(),
    score_mode: z.literal("rrf_seeded_h1_max_product").optional(),
    h1_max_product: RecallH1MaxProductSchema.optional(),
    h1_overlay: RecallH1OverlaySchema.optional()
  })
  .strict()
  .superRefine(validateRecallH1FloodOverlayRelationship)
  .readonly();

const RecallFloodFuelCoverageSummarySchema = z
  .object({
    candidates_total: z.number().int().nonnegative(),
    cold_start_count: z.number().int().nonnegative(),
    fuel_verified_count: z.number().int().nonnegative(),
    slice_active_count: z.number().int().nonnegative(),
    path_active_count: z.number().int().nonnegative(),
    evidence_active_count: z.number().int().nonnegative(),
    ...RecallH1FuelCoverageSchemaShape
  })
  .strict()
  .readonly();

const RecallDiagnosticPathExpansionSourceSchema = z
  .object({
    path_id: z.string().min(1),
    seed_id: z.string().min(1),
    seed_kind: z.enum(["memory", "time_concern"]),
    target_object_id: z.string().min(1),
    source_channel: z.enum(["path_expansion", "time_concern"]),
    relation_kind: z.string().min(1),
    facet_key: z.string().min(1).nullable()
  })
  .strict()
  .readonly();

export const RecallCandidateAnswerFeaturesSchema = z
  .object({
    content: z.string(),
    evidence_gist: z.string().nullable(),
    evidence_gist_truncated: z.boolean(),
    domain_tags: z.array(z.string()).readonly(),
    evidence_refs: z.array(z.string()).readonly(),
    facet_tags: z.array(z.object({
      facet: z.string(),
      value: z.string().optional()
    }).strict().readonly()).readonly(),
    canonical_entities: z.array(z.string()).readonly(),
    projection_schema_version: z.literal(1).nullable(),
    event_time_start: z.string().nullable(),
    event_time_end: z.string().nullable(),
    valid_from: z.string().nullable(),
    valid_to: z.string().nullable(),
    time_precision: z.enum(["day", "month", "year", "range", "relative", "unknown"]).nullable(),
    time_source: z.enum(["explicit", "session_timestamp", "relative_resolved"]).nullable(),
    preference_subject: z.string().nullable(),
    preference_predicate: z.string().nullable(),
    preference_object: z.string().nullable(),
    preference_category: z.string().nullable(),
    preference_polarity: z.enum(["positive", "negative", "neutral"]).nullable(),
    answer_support: RecallCandidateAnswerSupportSchema.nullable().optional(),
    answer_support_observations: z.array(
      RecallAnswerSupportObservationSchema
    ).readonly().optional()
  })
  .strict()
  .readonly();

const RecallCandidateDiagnosticSchema = z
  .object({
    candidate_key: z.string().min(1),
    object_id: z.string().min(1),
    object_kind: RecallDiagnosticObjectKindSchema,
    created_at: z.string().min(1).optional(),
    facet_overlap: z.number().int().nonnegative().optional(),
    dimension: z.string().min(1).optional(),
    origin_plane: RecallOriginPlaneSchema,
    admission_planes: z.array(z.string().min(1)).readonly(),
    plane_first_admitted: z.string().min(1),
    plane_winning_admission: z.string().min(1),
    pre_budget_rank: z.number().int().positive(),
    selection_order: z.number().int().positive(),
    admission_attempts: z.array(RecallAdmissionAttemptDiagnosticSchema).readonly().default([]),
    evidence_projection_matches: z.array(
      RecallEvidenceProjectionMatchReceiptSchema
    ).readonly().default([]),
    fused_rank: z.number().int().positive(),
    fused_score: z.number().min(0),
    answer_relevance_score: z.number().min(0).max(1).optional(),
    answer_relevance_rank: z.number().int().positive().optional(),
    per_stream_rank: RecallFusionStreamRankSchema,
    fused_rank_contribution_per_stream: RecallFusionStreamContributionSchema,
    per_axis_rank: RecallConformantAxisRankSchema.optional(),
    per_axis_contribution: RecallConformantAxisContributionSchema.optional(),
    flood_potential: RecallIntegratedFloodCandidateDiagnosticsSchema.optional(),
    flood_fuel_coverage: RecallFloodFuelCoverageSummarySchema.optional(),
    final_rank: z.number().int().positive().nullable(),
    post_rank: z.number().int().positive().nullable().optional(),
    in_final_packet: z.boolean().optional(),
    eviction_reason: z.string().min(1).nullable().optional(),
    dropped_reason: z.string().min(1).nullable(),
    within_budget: z.boolean(),
    relevance_score: z.number().min(0).max(1),
    additive_score: z.number().min(0).max(1).optional(),
    lexical_rank: z.number().min(0).max(1).nullable(),
    structural_score: z.number().min(0).max(1),
    score_factors: z.record(z.string(), z.unknown()).readonly(),
    source_channels: z.array(z.string().min(1)).readonly(),
    path_expansion_sources: z.array(RecallDiagnosticPathExpansionSourceSchema).readonly(),
    answer_features: RecallCandidateAnswerFeaturesSchema.nullable().default(null),
    deep_head_trace: RecallDeepHeadTraceSchema.nullable().default(null),
    coverage_marginal_gain: z.number().finite().nonnegative().nullable().default(null),
    selector_observation: RecallCandidateSelectorObservationSchema.nullable().default(null),
    path_suppression_score: z.number().nullable().default(null),
    rank_after_fusion: z.number().int().positive().optional(),
    rank_after_feature_rerank: z.number().int().positive().optional(),
    rank_after_lexical_priority: z.number().int().positive().optional(),
    rank_after_synthesis_reserve: z.number().int().positive().optional(),
    rank_after_structural_reserve: z.number().int().positive().optional(),
    rank_after_coverage_selector: z.number().int().positive().optional(),
    rank_after_session_coverage: z.number().int().positive().optional(),
    coverage_selector_action: z.enum(["noop", "kept", "promoted", "displaced"]).optional(),
    session_coverage_action: z.enum(["noop", "kept", "promoted", "displaced"]).optional(),
    session_key: z.string().min(1).optional(),
    source_cohort_key: z.string().min(1).nullable().optional(),
    reserved_by: z.enum(["none", "synthesis", "structural"]).optional()
  })
  .strict()
  .readonly();

const FineAssessmentPrunedCandidateDiagnosticSchema = z
  .object({
    candidate_key: z.string().min(1),
    origin_plane: RecallOriginPlaneSchema,
    object_kind: RecallDiagnosticObjectKindSchema,
    object_id: z.string().min(1),
    coarse_index: z.number().int().nonnegative(),
    drop_reason: z.literal("fine_assessment_cap")
  })
  .strict()
  .readonly();

// Mirrors core token-economy telemetry for measure-only run aggregation.
export const RecallTokenEconomySchema = z
  .object({
    delivered_context_tokens_estimate: z.number().int().nonnegative(),
    coarse_pool_size: z.number().int().nonnegative(),
    fine_evaluated: z.number().int().nonnegative(),
    fine_pruned_count: z.number().int().nonnegative(),
    fine_priority_overflow_count: z.number().int().nonnegative().default(0),
    fusion_families_with_hits: z.number().int().nonnegative(),
    embedding_inference_calls: z.number().int().nonnegative()
  })
  .strict()
  .readonly();

const RecallGraphExpansionPlaneCountPerHopSchema = z
  .tuple([
    z.number().int().nonnegative(),
    z.number().int().nonnegative()
  ])
  .readonly();

const RecallGraphExpansionPlaneCountPerEdgeTypeSchema = z
  .object({
    derives_from: z.number().int().nonnegative(),
    recalls: z.number().int().nonnegative(),
    supports: z.number().int().nonnegative()
  })
  .strict()
  .readonly();

const RecallDegradationReasonSchema = z.enum([
  "evidence_fts_failed",
  "evidence_candidate_embedding_failed",
  "synthesis_fts_failed",
  "embedding_coarse_injection_failed",
  "graph_expansion_failed",
  "path_expansion_failed",
  "packet_plan_trace_capture_failed"
]);

export const BenchRecallDiagnosticsSchema = z
  .object({
    query_probes: z
      .object({
        normalized_query: z.string().nullable().default(null),
        object_ids: z.array(z.string()).readonly(),
        subject_hints: z.array(z.string()).readonly(),
        evidence_refs: z.array(z.string()).readonly(),
        run_ids: z.array(z.string()).readonly(),
        surface_ids: z.array(z.string()).readonly(),
        file_paths: z.array(z.string()).readonly(),
        command_names: z.array(z.string()).readonly(),
        package_names: z.array(z.string()).readonly(),
        task_refs: z.array(z.string()).readonly(),
        dimensions: z.array(z.string()).readonly(),
        scope_classes: z.array(z.string()).readonly(),
        domain_tags: z.array(z.string()).readonly(),
        lexical_terms: z.array(z.string()).readonly(),
        expanded_terms: z.array(z.string()).readonly(),
        phrases: z.array(z.string()).readonly(),
        char_ngrams: z.array(z.string()).readonly(),
        date_terms: z.array(z.string()).readonly()
      })
      .strict()
      .readonly(),
    retrieval_field_captures: z.array(RecallFiniteFieldChannelCaptureSchema).readonly().optional(),
    retrieval_field_refinement_receipts:
      z.array(RecallRetrievalFieldRefinementReceiptSchema).readonly().optional(),
    field_refinement_stop_certificate:
      RecallFieldRefinementStopCertificateSchema.optional(),
    query_condition: RecallQueryConditionParitySchema.optional(),
    query_entity_extraction: RecallQueryEntityExtractionCaptureSchema.optional(),
    query_fact_frame_extraction:
      RecallQueryFactFrameExtractionCaptureSchema.optional(),
    query_open_semantic_factor_formation:
      OpenSemanticFactorFormationCaptureSchema.optional(),
    open_semantic_factor_compatibility_trace:
      OpenSemanticFactorCompatibilityTraceSchema.optional(),
    open_semantic_factor_composition:
      OpenSemanticFactorCompositionReceiptSchema.optional(),
    open_semantic_factor_activation:
      OpenSemanticFactorActivationReceiptSchema.optional(),
    answer_shape_plan: RecallAnswerShapePlanSchema.nullable().optional(),
    query_sought_facets: z.array(z.string()).readonly().default([]),
    total_scanned: z.number().int().nonnegative(),
    candidate_pool_count: z.number().int().nonnegative(),
    pre_budget_count: z.number().int().nonnegative(),
    delivered_count: z.number().int().nonnegative(),
    packet_plan_trace: RecallPacketPlanTraceSchema.optional(),
    field_projection_trace: FieldProjectionTraceSchema.optional(),
    embedding_provider_status: z.enum([
      "provider_returned",
      "provider_pending",
      "provider_failed",
      "provider_not_requested",
      "query_embedding_unusable"
    ]),
    embedding_supplement_status: z.enum([
      "disabled",
      "provider_missing",
      "query_missing",
      "empty_candidate_pool",
      "not_attempted",
      "requested"
    ]).optional(),
    ...EvidenceEmbeddingDiagnosticsSchemaShape,
    provider_degradation_reason: z.string().nullable(),
    answer_rerank_status: BenchAnswerRerankStatusSchema,
    answer_rerank_expected_count: z.number().int().nonnegative(),
    answer_rerank_scored_count: z.number().int().nonnegative(),
    answer_rerank_failure_class: BenchAnswerRerankFailureClassSchema.nullable(),
    degradation_reasons: z.array(RecallDegradationReasonSchema).readonly().optional(),
    embedding_workspace_scan_cap: z.number().int().nonnegative().optional(),
    embedding_workspace_scanned_count: z.number().int().nonnegative().optional(),
    embedding_workspace_truncated: z.boolean().optional(),
    embedding_workspace_provider_kind: z.string().min(1).optional(),
    embedding_workspace_model_id: z.string().min(1).optional(),
    embedding_workspace_schema_version: z.number().int().nonnegative().optional(),
    graph_expansion_plane_count_per_hop:
      RecallGraphExpansionPlaneCountPerHopSchema,
    graph_expansion_plane_count_per_edge_type:
      RecallGraphExpansionPlaneCountPerEdgeTypeSchema,
    multi_seed_graph_fan_in:
      RecallMultiSeedGraphFanInDiagnosticsSchema.optional(),
    fusion_breakdown: z
      .array(
        z
          .object({
            candidate_key: z.string().min(1),
            object_id: z.string().min(1),
            object_kind: RecallDiagnosticObjectKindSchema,
            origin_plane: RecallOriginPlaneSchema,
            facet_overlap: z.number().int().nonnegative().optional(),
            per_stream_rank: RecallFusionStreamRankSchema,
            fused_rank: z.number().int().positive(),
            fused_score: z.number().min(0),
            fused_rank_contribution_per_stream:
              RecallFusionStreamContributionSchema,
            per_axis_rank: RecallConformantAxisRankSchema.optional(),
            per_axis_contribution:
              RecallConformantAxisContributionSchema.optional(),
            flood_potential:
              RecallIntegratedFloodCandidateDiagnosticsSchema.optional(),
            flood_fuel_coverage:
              RecallFloodFuelCoverageSummarySchema.optional()
          })
          .strict()
          .readonly()
      )
      .readonly(),
    candidates: z.array(RecallCandidateDiagnosticSchema).readonly(),
    fine_assessment_pruned_candidates:
      z.array(FineAssessmentPrunedCandidateDiagnosticSchema).readonly(),
    // Optional for legacy diagnostics; absent telemetry is dropped from aggregates.
    token_economy: RecallTokenEconomySchema.optional(),
    // Phase names remain open while the enclosing diagnostics contract stays strict.
    phase_latency_ms: z.record(z.string(), z.number().nonnegative()).readonly().optional()
  })
  .strict()
  .readonly();

export type BenchRecallDiagnostics = z.infer<typeof BenchRecallDiagnosticsSchema>;
export type BenchRecallTokenEconomy = z.infer<typeof RecallTokenEconomySchema>;

export function parseBenchRecallDiagnosticsForRun(
  value: unknown,
  env: Readonly<Record<string, string | undefined>> = process.env
): BenchRecallDiagnostics {
  const diagnostics = BenchRecallDiagnosticsSchema.parse(value);
  assertBiEncoderRunActivation(diagnostics, env);
  refuseRetiredLocalCrossEncoderTreatment(env);
  assertCrossEncoderControlInactive(diagnostics);
  return diagnostics;
}

function assertCrossEncoderControlInactive(
  diagnostics: BenchRecallDiagnostics
): void {
  if (
    diagnostics.answer_rerank_status !== "not_requested" ||
    diagnostics.answer_rerank_expected_count !== 0 ||
    diagnostics.answer_rerank_scored_count !== 0 ||
    diagnostics.answer_rerank_failure_class !== null
  ) {
    throw new Error("retired cross-encoder reranking was observed");
  }
}
