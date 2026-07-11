import { z } from "zod";

// Explicit zod schema for the bench-side diagnostic records produced by
// buildQuestionDiagnostic. The raw recall-pipeline diagnostics input has its
// own schema (harness/recall-diagnostics-schema.ts); this one covers the
// post-classification records that land in the longmemeval/locomo sidecars.
// The diagnostic record types in diagnostics.ts are z.infer aliases of these
// schemas so the persisted shape has a single source of truth.

export const BenchEmbeddingProviderStateSchema = z.enum([
  "provider_returned",
  "provider_pending",
  "provider_failed",
  "provider_not_requested",
  "unknown"
]);

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

export const DiagnosticFloodEdgeTraceV1Schema = z
  .object({
    schema_version: z.literal(1),
    path_id: z.string().min(1),
    relation_kind: z.string().min(1),
    seed_object_id: z.string().min(1),
    target_object_id: z.string().min(1),
    input_potential: z.number().min(0),
    edge_conductance: z.number(),
    slice_compatibility: z.enum([
      "not_evaluated",
      "no_query_key",
      "missing_source_key",
      "missing_target_key",
      "missing_source_and_target_key",
      "no_slice_match",
      "slice_match"
    ]),
    raw_transfer: z.number(),
    capped_transfer: z.number().min(0),
    decision: z.enum(["transferred", "rejected"]),
    reason: z.enum([
      "transferred",
      "capped",
      "self_loop",
      "missing_edge_provenance",
      "missing_or_zero_input",
      "non_positive_conductance",
      "no_slice_match"
    ])
  })
  .strict()
  .readonly();

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
    edge_trace_truncated_count: z.number().int().nonnegative().optional()
  })
  .strict()
  .readonly();

const DiagnosticFloodFuelCoverageSchema = z
  .object({
    candidates_total: z.number().int().nonnegative(),
    cold_start_count: z.number().int().nonnegative(),
    fuel_verified_count: z.number().int().nonnegative(),
    slice_active_count: z.number().int().nonnegative(),
    path_active_count: z.number().int().nonnegative(),
    evidence_active_count: z.number().int().nonnegative()
  })
  .readonly();

const DiagnosticScoreFactorsSchema = z.record(z.string(), z.unknown()).readonly();

const DeliveryStageActionSchema = z.enum([
  "noop",
  "kept",
  "promoted",
  "displaced"
]);

export const LongMemEvalMissTaxonomySchema = z.enum([
  "candidate_absent",
  "materialization_drop",
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
    object_kind: z.string().optional(),
    candidate_key: z.string(),
    dimension: z.string().nullable().default(null),
    final_rank: z.number().nullable(),
    pre_budget_rank: z.number().nullable(),
    selection_order: z.number().nullable(),
    fused_rank: z.number().nullable(),
    fused_score: z.number().nullable(),
    per_stream_rank: DiagnosticStreamRanksSchema.nullable(),
    fused_rank_contribution_per_stream:
      DiagnosticStreamContributionsSchema.nullable(),
    score_factors: DiagnosticScoreFactorsSchema
  })
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
    budget_drop_reason: z.string().nullable(),
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

export const LongMemEvalMissClassificationSchema = z.enum([
  "hit_at_5",
  "budget_dropped",
  "under_ranked",
  "active_constraint_only",
  "structural_gap",
  "lexical_gap",
  "candidate_absent",
  "no_gold",
  "abstained_correctly",
  "abstain_false_confident",
  "diagnostics_unavailable"
]);

export const LongMemEvalQuestionDiagnosticSchema = z
  .object({
    question_id: z.string(),
    question_type: z.string().nullable().default(null),
    is_abstention: z.boolean().default(false),
    premise_invalid: z.boolean().default(false),
    round_index: z.number().nullable(),
    gold_memory_ids: z.array(z.string()).readonly(),
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
    phase_latency_ms: PhaseLatencyMsSchema.optional(),
    provider_state: BenchEmbeddingProviderStateSchema,
    provider_degradation_reason: z.string().nullable(),
    graph_expansion_plane_count_per_hop:
      GraphExpansionPlaneCountPerHopSchema,
    graph_expansion_plane_count_per_edge_type:
      GraphExpansionPlaneCountPerEdgeTypeSchema,
    candidate_pool_complete: z.boolean().default(false),
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
    gold: z.array(LongMemEvalGoldDiagnosticSchema).readonly()
  })
  .readonly();
