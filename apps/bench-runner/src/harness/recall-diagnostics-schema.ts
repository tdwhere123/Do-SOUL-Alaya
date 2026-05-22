import { z } from "zod";

const RecallFusionStreamRankSchema = z
  .object({
    lexical_fts: z.number().int().positive().nullable(),
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
    path_expansion: z.number().int().positive().nullable(),
    temporal_recency: z.number().int().positive().nullable(),
    workspace_activation: z.number().int().positive().nullable()
  })
  .strict()
  .readonly();

const RecallFusionStreamContributionSchema = z
  .object({
    lexical_fts: z.number().min(0),
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
    path_expansion: z.number().min(0),
    temporal_recency: z.number().min(0),
    workspace_activation: z.number().min(0)
  })
  .strict()
  .readonly();

const RecallDiagnosticPathExpansionSourceSchema = z
  .object({
    path_id: z.string().min(1),
    seed_id: z.string().min(1),
    seed_kind: z.enum(["memory", "time_concern"]),
    target_object_id: z.string().min(1),
    source_channel: z.enum(["path_expansion", "time_concern"])
  })
  .strict()
  .readonly();

const RecallCandidateDiagnosticSchema = z
  .object({
    candidate_key: z.string().min(1),
    object_id: z.string().min(1),
    object_kind: z.enum(["memory_entry", "synthesis_capsule"]),
    origin_plane: z.enum(["workspace_local", "global"]),
    admission_planes: z.array(z.string().min(1)).readonly(),
    plane_first_admitted: z.string().min(1),
    plane_winning_admission: z.string().min(1),
    pre_budget_rank: z.number().int().positive(),
    selection_order: z.number().int().positive(),
    fused_rank: z.number().int().positive(),
    fused_score: z.number().min(0),
    per_stream_rank: RecallFusionStreamRankSchema,
    fused_rank_contribution_per_stream: RecallFusionStreamContributionSchema,
    final_rank: z.number().int().positive().nullable(),
    dropped_reason: z.string().min(1).nullable(),
    within_budget: z.boolean(),
    relevance_score: z.number().min(0).max(1),
    lexical_rank: z.number().min(0).max(1).nullable(),
    structural_score: z.number().min(0).max(1),
    score_factors: z.record(z.unknown()).readonly(),
    source_channels: z.array(z.string().min(1)).readonly(),
    path_expansion_sources: z.array(RecallDiagnosticPathExpansionSourceSchema).readonly()
  })
  .strict()
  .readonly();

export const BenchRecallDiagnosticsSchema = z
  .object({
    query_probes: z
      .object({
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
        phrases: z.array(z.string()).readonly(),
        char_ngrams: z.array(z.string()).readonly(),
        date_terms: z.array(z.string()).readonly()
      })
      .strict()
      .readonly(),
    total_scanned: z.number().int().nonnegative(),
    candidate_pool_count: z.number().int().nonnegative(),
    pre_budget_count: z.number().int().nonnegative(),
    delivered_count: z.number().int().nonnegative(),
    embedding_provider_status: z.enum([
      "provider_returned",
      "provider_pending",
      "provider_failed",
      "provider_not_requested"
    ]),
    provider_degradation_reason: z.string().nullable(),
    fusion_breakdown: z
      .array(
        z
          .object({
            candidate_key: z.string().min(1),
            object_id: z.string().min(1),
            object_kind: z.enum(["memory_entry", "synthesis_capsule"]),
            origin_plane: z.enum(["workspace_local", "global"]),
            per_stream_rank: RecallFusionStreamRankSchema,
            fused_rank: z.number().int().positive(),
            fused_score: z.number().min(0),
            fused_rank_contribution_per_stream: RecallFusionStreamContributionSchema
          })
          .strict()
          .readonly()
      )
      .readonly(),
    candidates: z.array(RecallCandidateDiagnosticSchema).readonly()
  })
  .strict()
  .readonly();

export type BenchRecallDiagnostics = z.infer<typeof BenchRecallDiagnosticsSchema>;
