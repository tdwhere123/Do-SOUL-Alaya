import { z } from "zod";
import { assertBiEncoderRunActivation } from "./embedding-treatment-activation.js";
import { readOptionalTreatmentBoolean } from "./strict-treatment-config.js";

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
    facet_overlap: z.number().int().positive().nullable()
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
    facet_overlap: z.number().min(0)
  })
  .strict()
  .readonly();

const RecallConformantAxisRankSchema = z
  .record(z.string(), z.number().int().positive().nullable())
  .readonly();

const RecallConformantAxisContributionSchema = z
  .record(z.string(), z.number().min(0))
  .readonly();

const RecallFloodEdgeTraceV1Schema = z
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
    edge_trace_truncated_count: z.number().int().nonnegative().optional()
  })
  .strict()
  .readonly();

const RecallFloodFuelCoverageSummarySchema = z
  .object({
    candidates_total: z.number().int().nonnegative(),
    cold_start_count: z.number().int().nonnegative(),
    fuel_verified_count: z.number().int().nonnegative(),
    slice_active_count: z.number().int().nonnegative(),
    path_active_count: z.number().int().nonnegative(),
    evidence_active_count: z.number().int().nonnegative()
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
    preference_polarity: z.enum(["positive", "negative", "neutral"]).nullable()
  })
  .strict()
  .readonly();

const RecallCandidateDiagnosticSchema = z
  .object({
    candidate_key: z.string().min(1),
    object_id: z.string().min(1),
    object_kind: z.enum(["memory_entry", "synthesis_capsule"]),
    created_at: z.string().min(1).optional(),
    facet_overlap: z.number().int().nonnegative().optional(),
    dimension: z.string().min(1).optional(),
    origin_plane: z.enum(["workspace_local", "global"]),
    admission_planes: z.array(z.string().min(1)).readonly(),
    plane_first_admitted: z.string().min(1),
    plane_winning_admission: z.string().min(1),
    pre_budget_rank: z.number().int().positive(),
    selection_order: z.number().int().positive(),
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

// invariant: mirrors RecallTokenEconomy from
// packages/core/src/recall/recall-service-types.ts. The bench harness captures
// these per-recall figures so the longmemeval / locomo KPI summaries can
// aggregate p50 / p95 / mean across questions. Measure-only — no field
// gates ranking or admission.
// see also: packages/core/src/recall/diagnostics.ts:computeRecallTokenEconomy
const RecallTokenEconomySchema = z
  .object({
    delivered_context_tokens_estimate: z.number().int().nonnegative(),
    coarse_pool_size: z.number().int().nonnegative(),
    fine_evaluated: z.number().int().nonnegative(),
    fine_pruned_count: z.number().int().nonnegative(),
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
  "synthesis_fts_failed",
  "embedding_coarse_injection_failed",
  "graph_expansion_failed",
  "path_expansion_failed"
]);

export const BenchAnswerRerankStatusSchema = z.enum([
  "not_requested",
  "not_applicable",
  "returned",
  "failed"
]);

export const BenchAnswerRerankFailureClassSchema = z.enum([
  "invalid_score_count",
  "invalid_score_value",
  "service_error"
]);

// see also: packages/core/src/recall/recall-service-types.ts
//   RecallMultiSeedGraphFanInDiagnostics
const RecallMultiSeedGraphFanInDiagnosticsSchema = z
  .object({
    distinct_seeds: z.number().int().nonnegative(),
    candidates_per_seed_p50: z.number().nonnegative(),
    candidates_per_seed_p95: z.number().nonnegative(),
    dedup_collisions: z.number().int().nonnegative()
  })
  .strict()
  .readonly();

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
    query_sought_facets: z.array(z.string()).readonly().default([]),
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
    // Optional. Present when entity-derived seeds drove graph fan-in for
    // this recall. see also: packages/core/src/recall/recall-service-types.ts
    //   RecallMultiSeedGraphFanInDiagnostics
    multi_seed_graph_fan_in:
      RecallMultiSeedGraphFanInDiagnosticsSchema.optional(),
    fusion_breakdown: z
      .array(
        z
          .object({
            candidate_key: z.string().min(1),
            object_id: z.string().min(1),
            object_kind: z.enum(["memory_entry", "synthesis_capsule"]),
            origin_plane: z.enum(["workspace_local", "global"]),
            // Mirrors RecallFusionBreakdown.facet_overlap from core diagnostics.
            facet_overlap: z.number().int().nonnegative(),
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
    // Optional only for legacy/malformed diagnostics. Current RecallService
    // emits token_economy on normal and degraded recall paths, and the bench
    // aggregator drops absent blocks instead of admitting a `{0,0,0,0,0}`
    // record that biases run-level mean / p50 distributions downward.
    // see also: packages/core/src/recall/diagnostics.ts:computeRecallTokenEconomy,
    // packages/core/src/recall/recall-service.ts (call site), and packages/core/src/recall/recall-service-types.ts
    // (RecallDiagnostics.token_economy doc-comment).
    token_economy: RecallTokenEconomySchema.optional(),
    // Optional wall-clock per recall phase, mirrored from
    // packages/core/src/recall/recall-service-types.ts RecallDiagnostics.
    // Bench keeps it as opaque numeric telemetry for offline bottleneck
    // localization and must accept new phase keys without widening the rest of
    // the diagnostics contract.
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
  const crossEncoderEnabled = readOptionalTreatmentBoolean(
    env.ALAYA_ENABLE_LOCAL_CROSS_ENCODER_RERANK,
    "ALAYA_ENABLE_LOCAL_CROSS_ENCODER_RERANK"
  );
  if (crossEncoderEnabled === true) {
    assertCrossEncoderTreatmentActivation(diagnostics);
  } else if (crossEncoderEnabled === false) {
    assertCrossEncoderControlInactive(diagnostics);
  }
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
    throw new Error("cross-encoder control activation failed: reranking was observed");
  }
}

function assertCrossEncoderTreatmentActivation(
  diagnostics: BenchRecallDiagnostics
): void {
  if (diagnostics.answer_rerank_status === "not_applicable") {
    assertRerankNotApplicable(diagnostics);
    return;
  }
  if (diagnostics.answer_rerank_status !== "returned") {
    throw new Error(
      `cross-encoder treatment activation failed: status ${diagnostics.answer_rerank_status}`
    );
  }
  if (
    diagnostics.answer_rerank_expected_count <= 0 ||
    diagnostics.answer_rerank_scored_count !== diagnostics.answer_rerank_expected_count ||
    diagnostics.answer_rerank_failure_class !== null
  ) {
    throw new Error(
      `cross-encoder treatment activation failed: expected ${diagnostics.answer_rerank_expected_count} scores but received ${diagnostics.answer_rerank_scored_count}`
    );
  }
}

function assertRerankNotApplicable(diagnostics: BenchRecallDiagnostics): void {
  const normalizedQuery = diagnostics.query_probes.normalized_query;
  const emptyQuery = normalizedQuery === null || normalizedQuery.trim().length === 0;
  const emptyPool = diagnostics.candidate_pool_count === 0;
  if (
    (!emptyQuery && !emptyPool) ||
    diagnostics.answer_rerank_expected_count !== 0 ||
    diagnostics.answer_rerank_scored_count !== 0 ||
    diagnostics.answer_rerank_failure_class !== null
  ) {
    throw new Error(
      "cross-encoder treatment activation failed: not_applicable for a non-empty query and candidate pool"
    );
  }
}
