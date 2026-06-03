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

// @anchor seed-extraction-path: which ingestion path produced the seed
// store. official_api_compile = real production garden extraction
// (OfficialApiGardenProvider.compile, 1 turn -> N typed signals);
// no_credentials_fallback = the degraded no-LLM path (1 turn -> 1 full-turn
// fact). A no-creds run re-seeds the keyword-rich full turn and can
// out-score the tight production distilled_fact, so the two paths must
// never be indistinguishable in the persisted report. cache_hits / llm_calls
// / offline_fallbacks / live_extraction_failures /
// cached_extraction_failures / facts_produced are the per-run extraction
// counters.
// signals_dropped is the TOTAL signals lost between the model envelope and
// a seeded memory_entry — a visible recall hole. parse_dropped and
// compile_overflow_dropped attribute the two extraction-time drop stages:
// parse_dropped counts malformed single entries and over-64-cap signals
// discarded inside parseOfficialApiSignals; compile_overflow_dropped counts
// parsed drafts dropped inside compile() for raw_payload past the 16 KB cap.
// A third, non-attributed source also rolls into signals_dropped: a whole
// turn's signals lost when the seed-materialization batch throws (e.g. a
// garden-task complete mismatch). So the invariant is
// signals_dropped >= parse_dropped + compile_overflow_dropped, not a clean
// equality. see also:
// apps/bench-runner/src/longmemeval/compile-seed.ts CompileSeedExtractionStats.
const SeedExtractionPathSchema = z
  .object({
    path: z.enum(["official_api_compile", "no_credentials_fallback"]),
    cache_hits: z.number().int().nonnegative(),
    llm_calls: z.number().int().nonnegative(),
    offline_fallbacks: z.number().int().nonnegative(),
    live_extraction_failures: z.number().int().nonnegative().default(0),
    cached_extraction_failures: z.number().int().nonnegative().default(0),
    facts_produced: z.number().int().nonnegative(),
    signals_dropped: z.number().int().nonnegative(),
    parse_dropped: z.number().int().nonnegative(),
    compile_overflow_dropped: z.number().int().nonnegative()
  })
  .strict();
export type SeedExtractionPath = z.infer<typeof SeedExtractionPathSchema>;

const RatioSchema = z.number().min(0).max(1);

const CountDistributionEntrySchema = z
  .object({
    count: z.number().int().nonnegative(),
    share: RatioSchema,
    denominator: z.number().int().nonnegative()
  })
  .strict();

// Per-plane recall coverage: for one candidate-generating plane, how many
// gold candidates carried that plane and how many of those landed in the
// delivered top-5. Plane keys are driven by the planes actually observed in
// gold candidates' source_planes, so a new plane (e.g. a future trigram
// plane) appears here without a schema change.
const PerPlaneRecallCoverageEntrySchema = z
  .object({
    gold_count: z.number().int().nonnegative(),
    hit_at_5_count: z.number().int().nonnegative(),
    hit_at_5_rate: RatioSchema
  })
  .strict();

// Cohort fan-in attribution split (codex I2). The session cohort plane surfaces
// the most gold of any plane but historically flat-dumped it; this block splits
// its contribution into the five classes codex defined so the fan-in promotion
// is readable in the gate archive:
//   - delivered_plane_count: delivered rows (any rank) carrying the cohort plane
//   - gold_source_plane_count: gold whose source_planes include the cohort plane
//   - gold_first_admitted_count: gold whose plane_first_admitted is the cohort plane
//   - gold_winning_admission_count: gold whose plane_winning_admission is the cohort plane
//   - hit_at_5_count / hit_at_5_rate: cohort-source gold that delivered in top-5
// gold_winning_admission converting to hit@5 is the load-bearing signal that the
// cohort representative promoted by merit rather than borrowing a co-admitted plane.
const CohortAttributionSchema = z
  .object({
    delivered_plane_count: z.number().int().nonnegative(),
    gold_source_plane_count: z.number().int().nonnegative(),
    gold_first_admitted_count: z.number().int().nonnegative(),
    gold_winning_admission_count: z.number().int().nonnegative(),
    hit_at_5_count: z.number().int().nonnegative(),
    hit_at_5_rate: RatioSchema
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
    // Optional so pre-per-plane-coverage kpi.json records stay valid; new
    // bench runs always populate it. Keyed by plane label; the key set is
    // whatever planes the run's gold candidates actually exposed.
    per_plane_recall_coverage: z
      .record(PerPlaneRecallCoverageEntrySchema)
      .default({}),
    // Cohort fan-in attribution (codex I2). Optional so pre-fan-in kpi.json
    // records stay valid; new LongMemEval runs always populate it.
    cohort_attribution: CohortAttributionSchema.optional(),
    // @anchor longmemeval-abstention: calibrated-confidence scoring of the
    // LongMemEval-S abstention questions (`question_id` ending `_abs`).
    // Optional so pre-abstention-scoring kpi.json records stay valid; new
    // LongMemEval runs always populate it. correct_at_k counts the `_abs`
    // questions whose top-k delivered results all stayed below
    // false_confident_threshold (recall stayed appropriately unconfident);
    // these are credited to the recall@k numerator without changing the
    // 500-question denominator.
    abstention: z
      .object({
        schema_version: z.literal("bench-abstention.v1"),
        total: z.number().int().nonnegative(),
        false_confident_threshold: z.number(),
        correct_at_1: z.number().int().nonnegative(),
        correct_at_5: z.number().int().nonnegative(),
        correct_at_10: z.number().int().nonnegative(),
        false_confident_at_1: z.number().int().nonnegative(),
        false_confident_at_5: z.number().int().nonnegative(),
        false_confident_at_10: z.number().int().nonnegative()
      })
      .strict()
      .optional(),
    miss_distribution: z.record(z.number().int().nonnegative())
  })
  .strict();
export type QualityMetrics = z.infer<typeof QualityMetricsSchema>;

// @anchor token-economy: event-sourced token-economy figures, all
// derived from the bench run's EventLog (SOUL_SIGNAL_EMITTED for the
// ingested/stored sides, SOUL_CONTEXT_LENS_ASSEMBLED for the recalled
// side — see apps/bench-runner/src/harness/daemon.ts queryTokenMetrics).
// The block is OPTIONAL so pre-S6 kpi.json records stay schema-valid;
// new LongMemEval runs always populate it. token_saved_ratio_vs_full_prompt
// (KpiCore) is the headline ratio derived from these raw counts.
// @anchor recall-token-economy: per-recall STRUCTURAL token instrument,
// aggregated across all questions in a run. Distinct from `token_economy`
// (which counts EventLog-derived raw / stored / delivered tokens for the
// whole run). recall_token_economy quantifies what each individual recall
// call cost in token-shaped work — delivered tokens, pool sizes, evaluated
// candidates, fusion-stream coverage, and embedding provider invocations.
//
// Wave 2 / Phase 7 (D5 decision): measure-only. The figures publish what
// the recall pipeline ACTUALLY did, on every call, without setting a "must
// pass" threshold. They feed honest release notes, not a marketing target;
// the v0.3.10 "对标 95% data-driven design" anti-pattern is intentionally
// avoided.
//
// @anchor recall-token-economy-token-units: every *_tokens / *_token_*
// figure under this block is the chars/4 approximation produced by
// makeTokenEstimator (resolveCharsPerToken in
// packages/core/src/recall-service-types.ts). The default 4 chars/token
// is an OpenAI-style English heuristic; CJK content is underestimated
// by roughly 3-4x because Chinese/Japanese/Korean characters average
// closer to 1-1.5 chars/token under cl100k/o200k. Release notes citing
// mean / p95 figures from this block must carry the same caveat.
// see also:
//   packages/core/src/recall-service-types.ts RecallTokenEconomy
//   packages/core/src/recall-service.ts computeRecallTokenEconomy
//   apps/bench-runner/src/harness/recall-diagnostics-schema.ts
const PerCallStatSchema = z
  .object({
    mean: z.number().nonnegative(),
    p50: z.number().nonnegative(),
    p95: z.number().nonnegative(),
    max: z.number().nonnegative()
  })
  .strict();

const RecallTokenEconomySchema = z
  .object({
    schema_version: z.literal("bench-recall-token-economy.v1"),
    // Number of per-recall samples (one per recall call observed across
    // all questions in the run). Zero when no recall produced diagnostics
    // (e.g. shard with no questions); a run with this at zero will skip
    // the rest of the block on the consumer side.
    sample_count: z.number().int().nonnegative(),
    // Delivered tokens per recall — `sum(candidate.token_estimate)` over
    // the candidates actually returned. Mirrors the chars/token heuristic
    // used by makeTokenEstimator in core.
    delivered_context_tokens_estimate: PerCallStatSchema,
    // Coarse-pool size — the candidate count flowing into fineAssess.
    coarse_pool_size: PerCallStatSchema,
    // Fine-assess evaluated count — for now equals coarse pool size, so
    // distributions match; the field exists separately for forward
    // compatibility when fineAssess gains early-out paths.
    fine_evaluated: PerCallStatSchema,
    // Distinct fusion streams that contributed at least one non-null
    // per-stream rank across the pre-budget candidate set, per recall.
    fusion_streams_with_hits: PerCallStatSchema,
    // Embedding provider inference calls attributable to one recall: 1
    // when the recall issued a fresh provider invocation, 0 otherwise.
    // The mean across all recalls in the run is the call-weighted rate
    // of fresh inferences.
    embedding_inference_calls: PerCallStatSchema
  })
  .strict();
export type RecallTokenEconomy = z.infer<typeof RecallTokenEconomySchema>;

const TokenEconomySchema = z
  .object({
    schema_version: z.literal("bench-token-economy.v1"),
    // Token size of the full ingested haystack — what an agent would
    // otherwise carry as raw conversation context. Each source turn is
    // counted exactly once (a turn that the production extractor fans out
    // into N fact signals is not multiplied by N).
    raw_history_tokens: z.number().int().nonnegative(),
    // Tokens held in the materialized durable memory after ingestion,
    // summed over every seeded fact.
    stored_memory_tokens: z.number().int().nonnegative(),
    // Tokens delivered, summed over every recall in the run.
    recalled_context_tokens_total: z.number().int().nonnegative(),
    // Number of recalls (SOUL_CONTEXT_LENS_ASSEMBLED events) observed.
    recall_event_count: z.number().int().nonnegative(),
    // Mean tokens delivered per recall: what an agent receives to answer
    // one question instead of re-reading the whole history.
    recalled_context_tokens_mean: z.number().nonnegative(),
    // Count of SOUL_SIGNAL_EMITTED events the figures were derived from.
    seed_event_count: z.number().int().nonnegative()
  })
  .strict();
export type TokenEconomy = z.infer<typeof TokenEconomySchema>;

// @anchor edge-proposal-rate: K3.2 KPI — edge proposals produced per
// workspace-day across a bench run. Per-workspace-per-day stats let the
// release gate detect the "edge auto-build rate 40-80 proposals /
// workspace / day" target without re-aggregating from EventLog rows.
// Optional so older kpi.json records stay schema-valid; new bench runs
// always populate it when the bench-runner harness sources the edge
// proposal aggregator. per_trigger_source maps the trigger_source enum
// values to integer counts of SOUL_GRAPH_EDGE_PROPOSAL_CREATED events;
// keys are strings so a future enum value flows through without a
// schema migration.
//
// @anchor edge-proposal-rate-per-question: under the LongMemEval bench
// harness every question runs against the same workspaceId
// ("bench-workspace-1"), so per_workspace_per_day_* collapses to the
// run total — K3.2's "40-80 proposals / workspace / day" target cannot
// be interpreted directly off those fields under bench shape. The
// optional per_question_* fields surface the row-level distribution
// (one bucket per question) so the same KPI intent stays measurable
// under the bench harness. Both blocks describe the same EventLog rows;
// they differ only in how the rows are bucketed for the percentile.
// see also: packages/eval/src/edge-proposal-kpi.ts
// aggregateEdgeProposalRatePerQuestion.
const EdgeProposalRateSchema = z
  .object({
    schema_version: z.literal("bench-edge-proposal-rate.v1"),
    total_proposals: z.number().int().nonnegative(),
    per_workspace_per_day_min: z.number().nonnegative(),
    per_workspace_per_day_max: z.number().nonnegative(),
    per_workspace_per_day_median: z.number().nonnegative(),
    per_trigger_source: z.record(z.string(), z.number().int().nonnegative()),
    // Optional per-question distribution: one bucket = one bench
    // question's SOUL_GRAPH_EDGE_PROPOSAL_CREATED count. Absent when the
    // aggregator caller does not pass per-question chunks (e.g. pre-Phase
    // B archives, or non-bench runtime aggregations where "per question"
    // is undefined). Populated by the bench-runner harness so K3.2's
    // 40-80/workspace/day intent stays interpretable under the bench's
    // single-workspaceId shape.
    proposals_per_question: z
      .object({
        question_count: z.number().int().nonnegative(),
        total_proposals: z.number().int().nonnegative(),
        mean: z.number().nonnegative(),
        p50: z.number().nonnegative(),
        p95: z.number().nonnegative(),
        max: z.number().nonnegative()
      })
      .strict()
      .optional()
  })
  .strict();
export type EdgeProposalRate = z.infer<typeof EdgeProposalRateSchema>;

// @anchor edge-proposal-auto-accept: K3.4 KPI — fraction of reviewed
// proposals decided by system-policy auto-accept. total_decided counts
// SOUL_GRAPH_EDGE_PROPOSAL_REVIEWED rows whose payload.status is one of
// accepted / auto_accepted / rejected; auto_accepted is the numerator.
// rate is auto_accepted / total_decided (0 when total_decided is 0).
// per_trigger_source_rate is keyed by the originating proposal's
// trigger_source — the aggregator joins reviewed events back to their
// created counterparts; missing joins are dropped (the rate is
// computed on the joined subset). Optional so pre-Phase-B kpi.json
// records stay schema-valid.
const EdgeProposalAutoAcceptSchema = z
  .object({
    schema_version: z.literal("bench-edge-proposal-auto-accept.v1"),
    total_decided: z.number().int().nonnegative(),
    auto_accepted: z.number().int().nonnegative(),
    rate: RatioSchema,
    per_trigger_source_rate: z.record(z.string(), RatioSchema)
  })
  .strict();
export type EdgeProposalAutoAccept = z.infer<typeof EdgeProposalAutoAcceptSchema>;

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
  provider_not_requested_rate: RatioSchema.optional(),
  embedding_vector_cache_ready_rate: RatioSchema.optional(),
  query_embedding_cache_ready_rate: RatioSchema.optional(),
  latency_ms_p50: z.number().nonnegative(),
  latency_ms_p95: z.number().nonnegative(),
  latency_source: LatencySourceSchema,
  token_saved_ratio_vs_full_prompt: z.number(),
  // Optional so pre-S6 kpi.json records stay schema-valid. When present,
  // token_saved_ratio_vs_full_prompt is derived from this block.
  token_economy: TokenEconomySchema.optional(),
  // Optional so pre-phase-7 kpi.json records stay schema-valid; runs that
  // collect per-recall diagnostics populate it.
  // see also: @anchor recall-token-economy
  recall_token_economy: RecallTokenEconomySchema.optional(),
  tier_distribution: TierDistributionSchema,
  degradation_reasons: DegradationReasonsSchema,
  seed_truncation: SeedTruncationSchema,
  // Optional so older kpi.json records (pre seed-extraction disclosure)
  // stay schema-valid; new LongMemEval runs always populate it.
  seed_extraction_path: SeedExtractionPathSchema.optional(),
  quality_metrics: QualityMetricsSchema.optional(),
  // Edge Proposal KPI blocks (K3.2 + K3.4). Optional so older kpi.json
  // records stay schema-valid; new bench runs always populate them when
  // the bench-runner sources the edge proposal aggregator.
  edge_proposal_rate: EdgeProposalRateSchema.optional(),
  edge_proposal_auto_accept: EdgeProposalAutoAcceptSchema.optional(),
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
