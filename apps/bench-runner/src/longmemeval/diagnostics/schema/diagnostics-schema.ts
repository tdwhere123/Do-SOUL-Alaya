import { z } from "zod";
import { RecallOriginPlaneSchema } from "@do-soul/alaya-protocol";
import {
  BenchAnswerRerankFailureClassSchema,
  BenchAnswerRerankStatusSchema,
  RecallCandidateAnswerFeaturesSchema,
  RecallEvidenceProjectionMatchReceiptSchema
} from "../../../harness/recall/recall-diagnostics-schema.js";
import {
  RecallAnswerShapePlanSchema,
  RecallDeepHeadTraceSchema
} from "../../../harness/recall/answer-trace-schema.js";
import { RecallPacketPlanTraceSchema } from
  "../../../harness/recall/recall-diagnostics-support-schema.js";
import { RecallCandidateSelectorObservationSchema } from
  "../../../harness/recall/candidate-selector-observation-schema.js";
import { LongMemEvalQuestionMeasurementAxesSchema } from "../schema/measurement-axes-schema.js";
import { DELIVERY_MISS_DROP_REASONS } from "../miss/delivery-miss-taxonomy.js";
import { LongMemEvalMissClassificationSchema } from
  "../miss/miss-classification-schema.js";
import {
  DiagnosticRecallObjectKindSchema,
  LongMemEvalGoldObjectKindSchema,
  validatePersistedQuestionMeasurement
} from "./gold-identity-schema.js";
import { LongMemEvalFieldDiagnosticSchemaShape } from
  "./field-diagnostics-schema.js";
import {
  RecallFloodEdgeTraceV1Schema as DiagnosticFloodEdgeTraceV1Schema,
  RecallH1FuelCoverageSchemaShape as DiagnosticH1FuelCoverageSchemaShape,
  RecallH1MaxProductSchema as DiagnosticH1MaxProductSchema,
  RecallH1OverlaySchema as DiagnosticH1OverlaySchema,
  validateRecallH1FloodOverlayRelationship
} from "../../../harness/recall/h1/recall-h1-diagnostics-schema.js";
export { LongMemEvalQuestionMeasurementAxesSchema } from "../schema/measurement-axes-schema.js";

export const BenchEmbeddingProviderStateSchema = z.enum([
  "provider_returned",
  "provider_pending",
  "provider_failed",
  "provider_not_requested",
  "query_embedding_unusable",
  "unknown"
]);

export const DeliveryMissDropReasonSchema = z.enum(DELIVERY_MISS_DROP_REASONS);

const DiagnosticAdmissionAttemptSchema = z.object({
  pass: z.literal("final_selector"),
  selection_order: z.number().int().positive(),
  admitted: z.boolean(),
  dropped_reason: z.string().min(1).nullable()
}).strict().readonly();

export const DiagnosticAdmissionAttemptsSchema = z.array(
  DiagnosticAdmissionAttemptSchema
).readonly();

export const DiagnosticEvidenceProjectionMatchesSchema = z.array(
  RecallEvidenceProjectionMatchReceiptSchema
).readonly();

const DiagnosticStreamRanksSchema = z
  .record(z.string(), z.number().nullable())
  .readonly();

const DiagnosticStreamContributionsSchema = z
  .record(z.string(), z.number())
  .readonly();

const DiagnosticAxisRanksSchema = z
  .record(z.string(), z.number().nullable())
  .readonly();

const DiagnosticAxisContributionsSchema = z
  .record(z.string(), z.number())
  .readonly();

export {
  RecallFloodEdgeTraceV1Schema as DiagnosticFloodEdgeTraceV1Schema
} from "../../../harness/recall/h1/recall-h1-diagnostics-schema.js";

export const DiagnosticFloodPotentialSchema = z
  .object({
    R_obj: z.number(),
    Slice: z.number(),
    A_path: z.number(),
    B_evidence: z.number(),
    E_direct: z.number(),
    omega: z.number(),
    Flood: z.number(),
    lambda: z.number(),
    beta: z.number(),
    final_score: z.number(),
    slice_status: z.string(),
    path_status: z.string(),
    evidence_status: z.string(),
    e_direct_status: z.string(),
    fuel_verified: z.boolean(),
    edge_traces: z.array(DiagnosticFloodEdgeTraceV1Schema).max(16).readonly().optional(),
    edge_trace_truncated_count: z.number().int().nonnegative().optional(),
    score_mode: z.literal("rrf_seeded_h1_max_product").optional(),
    h1_max_product: DiagnosticH1MaxProductSchema.optional(),
    h1_overlay: DiagnosticH1OverlaySchema.optional()
  })
  .strict()
  .superRefine(validateRecallH1FloodOverlayRelationship)
  .readonly();

const DiagnosticFloodFuelCoverageSchema = z
  .object({
    candidates_total: z.number().int().nonnegative(),
    cold_start_count: z.number().int().nonnegative(),
    fuel_verified_count: z.number().int().nonnegative(),
    slice_active_count: z.number().int().nonnegative(),
    path_active_count: z.number().int().nonnegative(),
    evidence_active_count: z.number().int().nonnegative(),
    ...DiagnosticH1FuelCoverageSchemaShape
  })
  .readonly();

const DiagnosticScoreFactorsSchema = z.record(z.string(), z.unknown()).readonly();

export const DiagnosticQueryProbesSchema = z
  .object({
    normalized_query: z.string().nullable().optional(),
    subject_hints: z.array(z.string()).readonly().optional(),
    object_ids: z.array(z.string()).readonly().optional(),
    evidence_refs: z.array(z.string()).readonly().optional(),
    run_ids: z.array(z.string()).readonly().optional(),
    surface_ids: z.array(z.string()).readonly().optional(),
    file_paths: z.array(z.string()).readonly().optional(),
    command_names: z.array(z.string()).readonly().optional(),
    package_names: z.array(z.string()).readonly().optional(),
    task_refs: z.array(z.string()).readonly().optional(),
    dimensions: z.array(z.string()).readonly().optional(),
    scope_classes: z.array(z.string()).readonly().optional(),
    domain_tags: z.array(z.string()).readonly().optional(),
    lexical_terms: z.array(z.string()).readonly().optional(),
    expanded_terms: z.array(z.string()).readonly().optional(),
    phrases: z.array(z.string()).readonly().optional(),
    char_ngrams: z.array(z.string()).readonly().optional(),
    date_terms: z.array(z.string()).readonly().optional()
  })
  .strict()
  .readonly();

export const DiagnosticCandidateAnswerFeaturesSchema =
  RecallCandidateAnswerFeaturesSchema;

const DeliveryStageActionSchema = z.enum([
  "noop",
  "kept",
  "promoted",
  "displaced"
]);

export const LongMemEvalMissTaxonomySchema = z.enum([
  "candidate_absent",
  "materialization_drop",
  "fine_assessment_drop",
  "budget_drop",
  "delivery_order_drop",
  "answer_set_coverage_drop",
  "evaluation_or_gold_issue"
]);

const LongMemEvalSeedDropReasonsSchema = z
  .object({
    candidate_absent: z.number().int().nonnegative(),
    materialization_drop: z.number().int().nonnegative()
  })
  .readonly();

const GraphExpansionPlaneCountPerHopSchema = z
  .tuple([
    z.number().int().nonnegative(),
    z.number().int().nonnegative()
  ])
  .readonly();

const GraphExpansionPlaneCountPerEdgeTypeSchema = z
  .object({
    derives_from: z.number().int().nonnegative(),
    recalls: z.number().int().nonnegative(),
    supports: z.number().int().nonnegative()
  })
  .readonly();

const PhaseLatencyMsSchema = z.record(z.string(), z.number().nonnegative()).readonly();

export const DiagnosticRecallResultSchema = z
  .object({
    object_id: z.string(),
    object_kind: z.string().optional(),
    dimension: z.string().nullable().default(null),
    rank: z.number(),
    relevance_score: z.number(),
    fused_rank: z.number().nullable(),
    fused_score: z.number().nullable(),
    // Fused-margin answerability confidence; optional so older sidecars parse.
    // Never derived from relevance_score (saturated effectiveScore).
    abstention_confidence_score: z.number().min(0).max(1).nullable().optional(),
    per_stream_rank: DiagnosticStreamRanksSchema.nullable(),
    fused_rank_contribution_per_stream:
      DiagnosticStreamContributionsSchema.nullable(),
    per_axis_rank: DiagnosticAxisRanksSchema.nullable().default(null),
    per_axis_contribution:
      DiagnosticAxisContributionsSchema.nullable().default(null),
    flood_potential: DiagnosticFloodPotentialSchema.nullable().default(null),
    flood_fuel_coverage:
      DiagnosticFloodFuelCoverageSchema.nullable().default(null),
    plane_first_admitted: z.string().nullable(),
    plane_winning_admission: z.string().nullable(),
    score_factors: DiagnosticScoreFactorsSchema.nullable()
  })
  .readonly();

const LongMemEvalReplayCandidateSchema = z
  .object({
    object_id: z.string(),
    object_kind: DiagnosticRecallObjectKindSchema,
    candidate_key: z.string(),
    origin_plane: RecallOriginPlaneSchema,
    dimension: z.string().nullable().default(null),
    final_rank: z.number().nullable(),
    pre_budget_rank: z.number().nullable(),
    selection_order: z.number().nullable(),
    admission_attempts: DiagnosticAdmissionAttemptsSchema.default([]),
    evidence_projection_matches: DiagnosticEvidenceProjectionMatchesSchema.default([]),
    fused_rank: z.number().nullable(),
    fused_score: z.number().nullable(),
    answer_relevance_score: z.number().min(0).max(1).nullable().default(null),
    answer_relevance_rank: z.number().int().positive().nullable().default(null),
    per_stream_rank: DiagnosticStreamRanksSchema.nullable(),
    fused_rank_contribution_per_stream:
      DiagnosticStreamContributionsSchema.nullable(),
    per_axis_rank: DiagnosticAxisRanksSchema.nullable().default(null),
    per_axis_contribution: DiagnosticAxisContributionsSchema.nullable().default(null),
    flood_potential: DiagnosticFloodPotentialSchema.nullable().default(null),
    flood_fuel_coverage: DiagnosticFloodFuelCoverageSchema.nullable().default(null),
    plane_first_admitted: z.string().nullable().default(null),
    plane_winning_admission: z.string().nullable().default(null),
    source_planes: z.array(z.string()).readonly().default([]),
    source_channels: z.array(z.string()).readonly().default([]),
    lexical_rank: z.number().nullable().default(null),
    structural_score: z.number().nullable().default(null),
    budget_drop_reason: DeliveryMissDropReasonSchema.nullable().default(null),
    rank_after_fusion: z.number().nullable().default(null),
    rank_after_feature_rerank: z.number().nullable().default(null),
    rank_after_lexical_priority: z.number().nullable().default(null),
    rank_after_synthesis_reserve: z.number().nullable().default(null),
    rank_after_structural_reserve: z.number().nullable().default(null),
    rank_after_coverage_selector: z.number().nullable().default(null),
    rank_after_session_coverage: z.number().nullable().default(null),
    coverage_selector_action: DeliveryStageActionSchema.nullable().default(null),
    session_coverage_action: DeliveryStageActionSchema.nullable().default(null),
    session_key: z.string().nullable().default(null),
    source_cohort_key: z.string().nullable().default(null),
    reserved_by: z.string().nullable().default(null),
    answer_features: DiagnosticCandidateAnswerFeaturesSchema.nullable().default(null),
    deep_head_trace: RecallDeepHeadTraceSchema.nullable().default(null),
    coverage_marginal_gain: z.number().min(0).max(1).nullable().default(null),
    selector_observation: RecallCandidateSelectorObservationSchema.nullable().default(null),
    path_suppression_score: z.number().nullable().default(null),
    score_factors: DiagnosticScoreFactorsSchema
  })
  .readonly();

const FineAssessmentPrunedCandidateDiagnosticSchema = z
  .object({
    candidate_key: z.string().min(1),
    origin_plane: RecallOriginPlaneSchema,
    object_kind: DiagnosticRecallObjectKindSchema,
    object_id: z.string().min(1),
    coarse_index: z.number().int().nonnegative(),
    drop_reason: z.literal("fine_assessment_cap")
  })
  .strict()
  .readonly();

const LongMemEvalQuestionCohortLedgerSchema = z
  .object({
    measurement_evidence_mode: z.literal("legacy_synthesized").optional(),
    measurement_status: z.enum([
      "scorable",
      "abstention_unscorable",
      "evaluator_identity_unscorable"
    ]).optional(),
    dataset_cohort: z.enum(["answerable", "abstention", "adjudicated_invalid"]),
    extraction_materialization: z.object({
      status: z.enum([
        "memory_emitted",
        "evidence_preserved",
        "drop",
        "unknown"
      ]),
      emitted_memory_count: z.number().int().nonnegative(),
      reason: z.enum(["candidate_absent", "materialization_drop"]).nullable()
    }).strict().readonly(),
    evaluator_gold_identity: z.object({
      status: z.enum(["present", "absent", "ambiguous"]),
      object_ids: z.array(z.string()).readonly()
    }).strict().readonly(),
    retrieval_status: z.enum(["hit_at_5", "miss_at_5", "not_applicable"]),
    evidence_status: z.enum(["complete", "partial", "missing"]),
    evaluation_issue_reason: z.enum([
      "missing_diagnostics",
      "empty_gold_identity",
      "extraction_materialization_drop",
      "gold_taxonomy_fallthrough",
      "identity_join_error",
      "evaluator_data_identity_inconsistency",
      "evaluator_data_identity_indeterminate",
      "adjudicated_dataset_issue"
    ]).nullable(),
    candidate_pool_complete: z.boolean(),
    quality_axes: LongMemEvalQuestionMeasurementAxesSchema.optional(),
    stage_ranks: z.array(z.object({
      object_id: z.string(),
      object_kind: LongMemEvalGoldObjectKindSchema.default("memory_entry"),
      fused_rank: z.number().nullable(),
      rank_after_feature_rerank: z.number().nullable(),
      rank_after_lexical_priority: z.number().nullable(),
      rank_after_synthesis_reserve: z.number().nullable(),
      rank_after_structural_reserve: z.number().nullable(),
      rank_after_coverage_selector: z.number().nullable(),
      rank_after_session_coverage: z.number().nullable(),
      selection_order: z.number().nullable(),
      final_rank: z.number().nullable()
    }).strict().readonly()).readonly(),
    final_verdict: z.enum([
      "hit_at_5",
      "miss_at_5",
      "abstained_correctly",
      "abstain_false_confident",
      "abstention_uncalibrated",
      "evaluation_unscorable",
      "evaluator_data_identity_inconsistency",
      "evaluator_data_identity_indeterminate",
      "adjudicated_invalid"
    ])
  })
  .strict()
  .readonly();

export const DiagnosticActiveConstraintResultSchema = z
  .object({
    object_id: z.string(),
    rank: z.number()
  })
  .readonly();

// invariant: source_planes is the load-bearing field for per-plane recall
// coverage and for classifyMiss's lexical_gap / structural_gap verdicts; it
// is an explicit string array here, never an optional or loosely-typed slot.
export const LongMemEvalGoldDiagnosticSchema = z
  .object({
    object_id: z.string(),
    object_kind: LongMemEvalGoldObjectKindSchema.default("memory_entry"),
    candidate_status: z.enum([
      "delivered",
      "active_constraint_delivered",
      "candidate_not_delivered",
      "candidate_absent",
      "unknown"
    ]),
    dimension: z.string().nullable().default(null),
    final_rank: z.number().nullable(),
    active_constraint_rank: z.number().nullable(),
    pre_budget_rank: z.number().nullable(),
    selection_order: z.number().nullable(),
    fused_rank: z.number().nullable(),
    fused_score: z.number().nullable(),
    answer_relevance_score: z.number().min(0).max(1).nullable().default(null),
    answer_relevance_rank: z.number().int().positive().nullable().default(null),
    per_stream_rank: DiagnosticStreamRanksSchema.nullable(),
    fused_rank_contribution_per_stream:
      DiagnosticStreamContributionsSchema.nullable(),
    per_axis_rank: DiagnosticAxisRanksSchema.nullable().default(null),
    per_axis_contribution:
      DiagnosticAxisContributionsSchema.nullable().default(null),
    flood_potential: DiagnosticFloodPotentialSchema.nullable().default(null),
    flood_fuel_coverage:
      DiagnosticFloodFuelCoverageSchema.nullable().default(null),
    plane_first_admitted: z.string().nullable(),
    plane_winning_admission: z.string().nullable(),
    source_planes: z.array(z.string()).readonly(),
    miss_taxonomy: LongMemEvalMissTaxonomySchema.nullable().default(null),
    lexical_rank: z.number().nullable(),
    structural_score: z.number().nullable(),
    score_factors: DiagnosticScoreFactorsSchema.nullable(),
    source_channels: z.array(z.string()).readonly(),
    budget_drop_reason: DeliveryMissDropReasonSchema.nullable(),
    rank_after_fusion: z.number().nullable().default(null),
    rank_after_feature_rerank: z.number().nullable().default(null),
    rank_after_lexical_priority: z.number().nullable().default(null),
    rank_after_synthesis_reserve: z.number().nullable().default(null),
    rank_after_structural_reserve: z.number().nullable().default(null),
    rank_after_coverage_selector: z.number().nullable().default(null),
    rank_after_session_coverage: z.number().nullable().default(null),
    coverage_selector_action: DeliveryStageActionSchema.nullable().default(null),
    session_coverage_action: DeliveryStageActionSchema.nullable().default(null),
    session_key: z.string().nullable().default(null),
    source_cohort_key: z.string().nullable().default(null),
    reserved_by: z.string().nullable().default(null)
  })
  .readonly();

export const LongMemEvalQuestionDiagnosticSchema = z
  .object({
    question_id: z.string(),
    question_type: z.string().nullable().default(null),
    is_abstention: z.boolean().default(false),
    premise_invalid: z.boolean().default(false),
    round_index: z.number().nullable(),
    gold_memory_ids: z.array(z.string()).readonly(),
    gold_evidence_ids: z.array(z.string()).readonly().default([]),
    gold_object_ids: z.array(z.string()).readonly().optional(),
    answer_session_ids: z.array(z.string()).readonly(),
    delivered_results: z.array(DiagnosticRecallResultSchema).readonly(),
    active_constraint_results: z
      .array(DiagnosticActiveConstraintResultSchema)
      .readonly(),
    hit_at_1: z.boolean(),
    hit_at_5: z.boolean(),
    hit_at_10: z.boolean(),
    miss_classification: LongMemEvalMissClassificationSchema,
    miss_taxonomy: LongMemEvalMissTaxonomySchema.nullable().default(null),
    seed_drop_reasons: LongMemEvalSeedDropReasonsSchema.optional(),
    degradation_reason: z.string().nullable(),
    recall_diagnostics_present: z.boolean(),
    recall_diagnostics_keys: z.array(z.string()).readonly(),
    packet_plan_trace: RecallPacketPlanTraceSchema.nullable().default(null),
    phase_latency_ms: PhaseLatencyMsSchema.optional(),
    provider_state: BenchEmbeddingProviderStateSchema,
    provider_degradation_reason: z.string().nullable(),
    embedding_workspace_scanned_count: z.number().int().nonnegative().optional(),
    embedding_workspace_truncated: z.boolean().optional(),
    embedding_workspace_provider_kind: z.string().min(1).optional(),
    embedding_workspace_model_id: z.string().min(1).optional(),
    embedding_workspace_schema_version: z.number().int().positive().optional(),
    answer_rerank_status: BenchAnswerRerankStatusSchema.nullable().default(null),
    answer_rerank_expected_count: z.number().int().nonnegative().nullable().default(null),
    answer_rerank_scored_count: z.number().int().nonnegative().nullable().default(null),
    answer_rerank_failure_class:
      BenchAnswerRerankFailureClassSchema.nullable().default(null),
    evidence_embedding_status: z.enum([
      "not_requested",
      "not_applicable",
      "returned",
      "failed"
    ]).nullable().default(null),
    evidence_embedding_expected_count:
      z.number().int().nonnegative().nullable().default(null),
    evidence_embedding_scored_count:
      z.number().int().nonnegative().nullable().default(null),
    evidence_embedding_inference_calls:
      z.number().int().nonnegative().nullable().default(null),
    evidence_embedding_latency_ms: z.number().nonnegative().nullable().default(null),
    evidence_embedding_failure_class: z.enum([
      "provider_unavailable",
      "query_embedding_failed",
      "candidate_embedding_failed",
      "service_error"
    ]).nullable().default(null),
    graph_expansion_plane_count_per_hop:
      GraphExpansionPlaneCountPerHopSchema,
    graph_expansion_plane_count_per_edge_type:
      GraphExpansionPlaneCountPerEdgeTypeSchema,
    candidate_pool_complete: z.boolean().default(false),
    candidate_pool_count: z.number().int().nonnegative().nullable().default(null),
    fine_pruned_count: z.number().int().nonnegative().nullable().default(null),
    fine_assessment_pruned_candidates: z
      .array(FineAssessmentPrunedCandidateDiagnosticSchema)
      .readonly()
      .default([]),
    query_probes: DiagnosticQueryProbesSchema.nullable().optional(),
    ...LongMemEvalFieldDiagnosticSchemaShape,
    answer_shape_plan: RecallAnswerShapePlanSchema.nullable().default(null),
    query_sought_facets: z.array(z.string()).readonly().nullable().default(null),
    candidates: z.array(LongMemEvalReplayCandidateSchema).readonly().default([]),
    candidate_key_collisions: z
      .array(
        z
          .object({
            object_id: z.string(),
            candidate_keys: z.array(z.string()).readonly()
          })
          .readonly()
      )
      .readonly(),
    quality_axes: LongMemEvalQuestionMeasurementAxesSchema.optional(),
    cohort_ledger: LongMemEvalQuestionCohortLedgerSchema.optional(),
    gold: z.array(LongMemEvalGoldDiagnosticSchema).readonly()
  })
  .superRefine((diagnostic, context) => {
    validatePersistedQuestionMeasurement(diagnostic, context);
  })
  .readonly();
