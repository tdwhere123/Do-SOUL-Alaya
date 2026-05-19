import { z } from "zod";

export const BenchSplit = z.enum([
  "golden",
  "synthetic",
  "longmemeval-s",
  "longmemeval-oracle",
  "longmemeval-m",
  "locomo10",
  "strict-real"
]);
export type BenchSplit = z.infer<typeof BenchSplit>;

export const BenchName = z.enum([
  "self",
  "public",
  "public-multiturn",
  "public-crossquestion",
  "public-locomo",
  "live"
]);
export type BenchName = z.infer<typeof BenchName>;

export const BenchPolicyShapeSchema = z.enum(["stress", "chat"]);
export type BenchPolicyShape = z.infer<typeof BenchPolicyShapeSchema>;

export const BenchSimulateReportModeSchema = z.enum([
  "none",
  "always-used",
  "gold-only",
  "mixed"
]);
export type BenchSimulateReportMode = z.infer<typeof BenchSimulateReportModeSchema>;

const ActivationWeightsSummarySchema = z
  .object({
    scope_match: z.number().min(0).max(1),
    domain_match: z.number().min(0).max(1),
    retention: z.number().min(0).max(1),
    freshness: z.number().min(0).max(1),
    relevance: z.number().min(0).max(1),
    graph_support: z.number().min(0).max(1),
    budget_penalty: z.number().min(0).max(1),
    conflict_penalty: z.number().min(0).max(1)
  })
  .strict();

const AdditiveScoringWeightsSummarySchema = z
  .object({
    NO_EMBEDDING_RELEVANCE_DIRECT_WEIGHT: z.number().finite().nonnegative().optional(),
    CONFIDENCE_DIRECT_WEIGHT: z.number().finite().nonnegative().optional(),
    PATH_PLASTICITY_WEIGHT: z.number().finite().nonnegative().optional()
  })
  .strict();

export const RecallWeightOverridesSummarySchema = z
  .object({
    source: z.enum(["cli", "env"]),
    activation_weights_phase4b: ActivationWeightsSummarySchema.optional(),
    additive: AdditiveScoringWeightsSummarySchema.optional(),
    fusion_weights: z.record(z.number().finite().nonnegative()).optional()
  })
  .strict();
export type RecallWeightOverridesSummary = z.infer<typeof RecallWeightOverridesSummarySchema>;

export const Verdict = z.enum(["ok", "warn", "fail"]);
export type Verdict = z.infer<typeof Verdict>;

const TierDistributionSchema = z.object({
  hot: z.number().int().nonnegative(),
  warm: z.number().int().nonnegative(),
  cold: z.number().int().nonnegative()
});
export type TierDistribution = z.infer<typeof TierDistributionSchema>;

// @anchor degradation-reasons-mirror: kept in 1:1 correspondence with
// protocol §SoulMemorySearchDegradationReasonSchema. recall_explainability_partial
// defaults to 0 (optional) so older kpi.json records remain schema-valid.
const DegradationReasonsSchema = z.object({
  none: z.number().int().nonnegative(),
  warm_cascade_engaged: z.number().int().nonnegative(),
  cold_cascade_engaged: z.number().int().nonnegative(),
  recall_explainability_partial: z.number().int().nonnegative().default(0)
});
export type DegradationReasons = z.infer<typeof DegradationReasonsSchema>;

const PerScenarioRowSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  hit_at_5: z.boolean(),
  tier: z.enum(["hot", "warm", "cold"]),
  latency_ms: z.number().nonnegative().optional()
});
export type PerScenarioRow = z.infer<typeof PerScenarioRowSchema>;

// @anchor latency-source: "exact" when latencies are union percentiles
// of a single run or merged from per-scenario latency rows;
// "worst_shard_bound" when merged from legacy shards as max(shard_p)
// (upper-bound only). see also: apps/bench-runner/src/cli.ts
// @merge-longmemeval.
const LatencySourceSchema = z
  .enum(["exact", "worst_shard_bound"])
  .default("exact");

// @anchor seed-truncation: count of bench-seeded turns whose content
// exceeded the protocol raw_payload cap and was clipped before propose.
// answer_truncated counts only the subset that carried has_answer=true
// (the worry case for honest retrieval). see also: harness/daemon.ts
// @bench-seed-content-cap.
const SeedTruncationSchema = z
  .object({
    seed_turns_truncated: z.number().int().nonnegative().default(0),
    answer_turns_truncated: z.number().int().nonnegative().default(0),
    seed_chars_clipped: z.number().int().nonnegative().default(0)
  })
  .default({
    seed_turns_truncated: 0,
    answer_turns_truncated: 0,
    seed_chars_clipped: 0
  });

const RatioSchema = z.number().min(0).max(1);

const CountDistributionEntrySchema = z
  .object({
    count: z.number().int().nonnegative(),
    share: RatioSchema,
    denominator: z.number().int().nonnegative()
  })
  .strict();

const QualityMetricsSchema = z
  .object({
    schema_version: z.literal("bench-quality-metrics.v1"),
    non_monotonic_rate: RatioSchema,
    non_monotonic_count: z.number().int().nonnegative(),
    non_monotonic_denominator: z.number().int().nonnegative(),
    budget_drop_distribution: z
      .object({
        max_entries: CountDistributionEntrySchema.optional()
      })
      .catchall(CountDistributionEntrySchema),
    high_lexical_demoted_rate: RatioSchema,
    high_lexical_demoted_count: z.number().int().nonnegative(),
    high_lexical_demoted_denominator: z.number().int().nonnegative(),
    candidate_absent_count: z.number().int().nonnegative(),
    candidate_absent_denominator: z.number().int().nonnegative(),
    no_gold_count: z.number().int().nonnegative(),
    no_gold_denominator: z.number().int().nonnegative(),
    evidence_stream_gold_delivery_rate: RatioSchema.default(0),
    evidence_stream_gold_delivery_count: z.number().int().nonnegative().default(0),
    evidence_stream_gold_delivery_denominator: z.number().int().nonnegative().default(0),
    path_stream_top10_rate: RatioSchema.default(0),
    path_stream_top10_count: z.number().int().nonnegative().default(0),
    path_stream_top10_denominator: z.number().int().nonnegative().default(0),
    miss_distribution: z.record(z.number().int().nonnegative())
  })
  .strict();
export type QualityMetrics = z.infer<typeof QualityMetricsSchema>;

const KpiCoreSchema = z.object({
  r_at_1: RatioSchema,
  r_at_5: RatioSchema,
  r_at_10: RatioSchema,
  r_at_5_overall: RatioSchema.optional(),
  r_at_5_with_embedding_returned: RatioSchema.optional(),
  r_at_5_round_1: RatioSchema.optional(),
  r_at_5_round_2: RatioSchema.optional(),
  r_at_5_round_n: RatioSchema.optional(),
  multiturn_rounds: z.number().int().positive().optional(),
  // public-crossquestion: split R@5 by position in the question sequence.
  // first_half = first floor(N/2) questions; last_half = the rest. If
  // shared-workspace accumulation actually helps, last_half should beat
  // first_half. Optional so other bench surfaces are unaffected.
  r_at_5_first_half: RatioSchema.optional(),
  r_at_5_last_half: RatioSchema.optional(),
  crossquestion_questions: z.number().int().positive().optional(),
  provider_returned_rate: RatioSchema.optional(),
  provider_pending_rate: RatioSchema.optional(),
  provider_failed_rate: RatioSchema.optional(),
  latency_ms_p50: z.number().nonnegative(),
  latency_ms_p95: z.number().nonnegative(),
  latency_source: LatencySourceSchema,
  token_saved_ratio_vs_full_prompt: z.number(),
  tier_distribution: TierDistributionSchema,
  degradation_reasons: DegradationReasonsSchema,
  seed_truncation: SeedTruncationSchema,
  quality_metrics: QualityMetricsSchema.optional(),
  per_scenario: z.array(PerScenarioRowSchema)
});
export type KpiCore = z.infer<typeof KpiCoreSchema>;

const DiffVsPreviousSchema = z.object({
  previous_run: z.string(),
  r_at_5_delta_pp: z.number(),
  verdict_per_kpi: z.record(Verdict)
});
export type DiffVsPrevious = z.infer<typeof DiffVsPreviousSchema>;

export const SeedPolicySchema = z
  .object({
    mode: z.string().min(1),
    label_independent: z.boolean(),
    object_kind: z.string().min(1).optional(),
    description: z.string().min(1).optional()
  })
  .strict()
  .readonly();
export type SeedPolicy = z.infer<typeof SeedPolicySchema>;

/**
 * @anchor harness_mode — bench data-ingestion path; an audit-distinguishable label.
 *
 * - direct_db_seed: harness wrote directly to storage repos / EventLog (no MCP).
 *   Used only when the harness is a unit-style test that bypasses the propose
 *   → review → accept governance loop. Numbers from this mode are NOT a claim
 *   about live agent behavior.
 * - mcp_propose_review: harness drove the in-process daemon via the real MCP
 *   tools soul.propose_memory_update + soul.review_memory_proposal. This is
 *   the production-equivalent ingestion path and the only mode in which KPI
 *   numbers may be cited as "what an attached agent would observe".
 * - external_replay: harness replayed a recorded stdio transcript against the
 *   real daemon. Reserved for cross-version regression replays.
 * - live_strict_real: archive of a strict-real live check generated from an
 *   isolated run DB with real provider health, MCP security gates, semantic
 *   supplement metrics, and Garden review-loop audit. It imports existing
 *   live evidence into bench-history; it does not rescore per-question rows.
 */
export const HarnessMode = z.enum([
  "direct_db_seed",
  "mcp_propose_review",
  "external_replay",
  "live_strict_real"
]);
export type HarnessMode = z.infer<typeof HarnessMode>;

export const KpiPayloadSchema = z
  .object({
    bench_name: BenchName,
    split: BenchSplit,
    run_at: z.string(),
    alaya_commit: z.string().min(7),
    alaya_version: z.string().min(1),
    recall_pipeline_version: z.string().min(1).optional(),
    embedding_provider: z.string(),
    chat_provider: z.string(),
    policy_shape: BenchPolicyShapeSchema.default("stress"),
    simulate_report: BenchSimulateReportModeSchema.default("none"),
    recall_weight_overrides: RecallWeightOverridesSummarySchema.optional(),
    seed_policy: SeedPolicySchema.optional(),
    dataset: z.object({
      name: z.string(),
      size: z.number().int().nonnegative(),
      source: z.string(),
      checksum_sha256: z.string().min(1).optional(),
      checksum_source: z.string().min(1).optional()
    }),
    // sample_size = the total questions / scenarios the dataset offers.
    //   LongMemEval Oracle full set = 500 (HuggingFace
    //   xiaowu0162/longmemeval-cleaned); self synthetic = 8.
    // evaluated_count = the number actually executed by this run (smoke run
    //   may use --limit N; full run must equal sample_size).
    // refinement: evaluated_count <= sample_size.
    sample_size: z.number().int().nonnegative(),
    evaluated_count: z.number().int().nonnegative(),
    harness_mode: HarnessMode,
    kpi: KpiCoreSchema,
    diff_vs_previous: DiffVsPreviousSchema.nullable().optional()
  })
  .refine((payload) => payload.evaluated_count <= payload.sample_size, {
    message: "evaluated_count must be <= sample_size",
    path: ["evaluated_count"]
  });
export type KpiPayload = z.infer<typeof KpiPayloadSchema>;
