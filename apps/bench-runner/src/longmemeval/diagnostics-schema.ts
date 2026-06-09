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
  .record(z.number().nullable())
  .readonly();

const DiagnosticStreamContributionsSchema = z
  .record(z.number())
  .readonly();

const DiagnosticScoreFactorsSchema = z.record(z.unknown()).readonly();

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

export const DiagnosticRecallResultSchema = z
  .object({
    object_id: z.string(),
    object_kind: z.string().optional(),
    dimension: z.string().nullable().default(null),
    rank: z.number(),
    relevance_score: z.number(),
    fused_rank: z.number().nullable(),
    fused_score: z.number().nullable(),
    per_stream_rank: DiagnosticStreamRanksSchema.nullable(),
    fused_rank_contribution_per_stream:
      DiagnosticStreamContributionsSchema.nullable(),
    plane_first_admitted: z.string().nullable(),
    plane_winning_admission: z.string().nullable(),
    score_factors: DiagnosticScoreFactorsSchema.nullable()
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
    plane_first_admitted: z.string().nullable(),
    plane_winning_admission: z.string().nullable(),
    source_planes: z.array(z.string()).readonly(),
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
    degradation_reason: z.string().nullable(),
    recall_diagnostics_present: z.boolean(),
    recall_diagnostics_keys: z.array(z.string()).readonly(),
    provider_state: BenchEmbeddingProviderStateSchema,
    provider_degradation_reason: z.string().nullable(),
    graph_expansion_plane_count_per_hop:
      GraphExpansionPlaneCountPerHopSchema,
    graph_expansion_plane_count_per_edge_type:
      GraphExpansionPlaneCountPerEdgeTypeSchema,
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
