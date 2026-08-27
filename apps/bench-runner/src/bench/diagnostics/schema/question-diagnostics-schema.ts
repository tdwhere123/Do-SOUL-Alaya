import { z } from "zod";
import { RecallOriginPlaneSchema } from "@do-soul/alaya-protocol";
import {
  BenchAnswerRerankFailureClassSchema,
  BenchAnswerRerankStatusSchema
} from "../../../harness/recall/recall-diagnostics-schema.js";
import {
  RecallAnswerShapePlanSchema,
  RecallDeepHeadTraceSchema
} from "../../../harness/recall/answer-trace-schema.js";
import { RecallPacketPlanTraceSchema } from
  "../../../harness/recall/recall-diagnostics-support-schema.js";
import { RecallCandidateSelectorObservationSchema } from
  "../../../harness/recall/candidate-selector-observation-schema.js";
import { CandidateActivationReceiptSchema } from
  "../../../harness/recall/answer-trace/semantic-activation-schema.js";
import { LongMemEvalQuestionMeasurementAxesSchema } from "../schema/measurement-axes-schema.js";
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
  BenchEmbeddingProviderStateSchema,
  DeliveryMissDropReasonSchema,
  DiagnosticAdmissionAttemptsSchema,
  DiagnosticSelectGammaDecisionSchema,
  DiagnosticAxisContributionsSchema,
  DiagnosticAxisRanksSchema,
  DiagnosticCandidateAnswerFeaturesSchema,
  DiagnosticEvidenceProjectionMatchesSchema,
  DiagnosticFloodFuelCoverageSchema,
  DiagnosticFloodPotentialSchema,
  DiagnosticQueryProbesSchema,
  DiagnosticScoreFactorsSchema,
  DiagnosticStreamContributionsSchema,
  DiagnosticStreamRanksSchema,
  LongMemEvalMissTaxonomySchema
} from "./diagnostics-schema-base.js";
import { OpenSemanticFactorCandidateActivationsSchema } from
  "./field/open-semantic-candidate-activation-schema.js";
import { CanonicalSelectionReceiptSchema } from
  "../../../harness/recall/capture/capture-receipt-schema.js";
import {
  CandidatePropositionProvenanceDiagnosticsSchema,
  LexicalBoundProofsDiagnosticsSchema
} from "../../../harness/recall/capture/capture-proof-diagnostics-schema.js";
import { archiveStaleOpenSemanticFactorFields } from
  "./field/open-semantic-factor-archive.js";

const DeliveryStageActionSchema = z.enum([
  "noop",
  "kept",
  "promoted",
  "displaced"
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
    select_gamma_decision: DiagnosticSelectGammaDecisionSchema.optional(),
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
    coverage_marginal_gain: z.number().finite().nonnegative().nullable().default(null),
    selector_observation: RecallCandidateSelectorObservationSchema.nullable().default(null),
    path_suppression_score: z.number().nullable().default(null),
    semantic_activation: CandidateActivationReceiptSchema.nullable().optional(),
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
    select_gamma_decision: DiagnosticSelectGammaDecisionSchema.optional(),
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

export const LongMemEvalQuestionDiagnosticSchema = z.preprocess(
  archiveStaleOpenSemanticFactorFields,
  z.object({
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
    ranking_authority: z.enum(["prefix_sk", "select_gamma"]).nullable().default(null),
    capture_receipt: CanonicalSelectionReceiptSchema.nullable().default(null),
    lexical_bound_proofs: LexicalBoundProofsDiagnosticsSchema.nullable().optional(),
    candidate_proposition_provenance:
      CandidatePropositionProvenanceDiagnosticsSchema.nullable().optional(),
    candidate_pool_count: z.number().int().nonnegative().nullable().default(null),
    fine_pruned_count: z.number().int().nonnegative().nullable().default(null),
    fine_assessment_pruned_candidates: z
      .array(FineAssessmentPrunedCandidateDiagnosticSchema)
      .readonly()
      .default([]),
    query_probes: DiagnosticQueryProbesSchema.nullable().optional(),
    ...LongMemEvalFieldDiagnosticSchemaShape,
    open_semantic_factor_archive: z.object({
      replayable: z.literal(false),
      reason: z.literal("stale_schema")
    }).strict().readonly().nullable().optional(),
    open_semantic_factor_candidate_activations:
      OpenSemanticFactorCandidateActivationsSchema.optional(),
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
  .readonly()
);
