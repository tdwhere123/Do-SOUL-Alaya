import { z } from "zod";
import { QualityMetricsSchema } from "./kpi-quality-schema.js";
import { validateMeasurementDenominatorContract } from "./kpi-measurement-contract.js";
import { BenchmarkMeasurementAttributionSchema } from "./kpi-measurement-schema.js";
export {
  BenchmarkMeasurementAttributionSchema,
  type BenchmarkMeasurementAttribution
} from "./kpi-measurement-schema.js";
export { RecallEvalAttributionSchema } from "./kpi-auxiliary-schema.js";
import {
  EdgeProposalAutoAcceptSchema,
  EdgeProposalRateSchema,
  QaMetricsSchema,
  RecallEvalAttributionSchema,
  RecallTokenEconomySchema,
  TokenEconomySchema
} from "./kpi-auxiliary-schema.js";

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
    fusion_weights: z.record(z.string(), z.number().finite().nonnegative()).optional()
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
  // Additive migration field. Missing means legacy denominator semantics;
  // consumers must never infer scorable from hit_at_5.
  scorable: z.boolean().optional(),
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
// The remaining drops happen at the materialization seam and are now
// attributed in signals_dropped_by_reason: candidate_absent (routed to
// evidence_only / deferred, no memory_entry) and materialization_drop (the
// signal threw before memory_entry creation and was isolated PER SIGNAL, so one
// bad pre-materialization signal no longer drops its whole turn batch — the fix
// for the silent 1963-signal whole-batch swallow). Post-memory-entry accept /
// review failures fail the bench closed instead of entering this ledger. So the
// invariant is
// signals_dropped >= parse_dropped + compile_overflow_dropped
//   + signals_dropped_by_reason.candidate_absent
//   + signals_dropped_by_reason.materialization_drop,
// not a clean equality (the >= absorbs any defensive whole-batch backstop drop,
// which is also attributed to materialization_drop only when no materialized
// memory_entry could contaminate scoring). see also:
// apps/bench-runner/src/longmemeval/compile-seed.ts CompileSeedExtractionStats.

function normalizeSeedDropReasons(value: unknown): {
  candidate_absent: number;
  materialization_drop: number;
} {
  if (typeof value !== "object" || value === null) {
    return { candidate_absent: 0, materialization_drop: 0 };
  }
  const record = value as Record<string, unknown>;
  const candidateAbsent =
    typeof record.candidate_absent === "number" ? record.candidate_absent : 0;
  const materializationDrop =
    typeof record.materialization_drop === "number"
      ? record.materialization_drop
      : typeof record.materialization_error === "number"
        ? record.materialization_error
        : 0;
  return { candidate_absent: candidateAbsent, materialization_drop: materializationDrop };
}

const SeedDropReasonsSchema = z
  .preprocess(
    normalizeSeedDropReasons,
    z
      .object({
        candidate_absent: z.number().int().nonnegative(),
        materialization_drop: z.number().int().nonnegative()
      })
      .strict()
  )
  .default({ candidate_absent: 0, materialization_drop: 0 });

const SeedFuelInventorySchema = z
  .object({
    objects_total: z.number().int().nonnegative(),
    evidence_refs_total: z.number().int().nonnegative(),
    facet_anchors_total: z.number().int().nonnegative(),
    path_candidates_total: z.number().int().nonnegative(),
    support_bearing_candidates: z.number().int().nonnegative()
  })
  .strict();
export type SeedFuelInventory = z.infer<typeof SeedFuelInventorySchema>;

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
    compile_overflow_dropped: z.number().int().nonnegative(),
    // Materialization-seam drops by reason (a SUBSET of signals_dropped):
    //   - candidate_absent: routed to evidence_only / deferred (no
    //     memory_entry materialized) — the seed-quality hole the bench surfaces.
    //   - materialization_drop: the signal threw before memory_entry creation
    //     and was isolated per-signal, so one bad pre-materialization signal
    //     never drops its batch-mates.
    // Archives may still carry the legacy materialization_error key; parsing
    // normalizes it to materialization_drop.
    // Post-memory-entry accept / review failures fail closed before scoring.
    // Optional with a zero default so archives written before this field shipped
    // still parse; new runs always populate it.
    // see also:
    // apps/bench-runner/src/longmemeval/compile-seed.ts CompileSeedExtractionStats
    signals_dropped_by_reason: SeedDropReasonsSchema
  })
  .strict();
export type SeedExtractionPath = z.infer<typeof SeedExtractionPathSchema>;

const RatioSchema = z.number().min(0).max(1);

const FullGoldDeliveryContributionSchema = z
  .object({
    gold_bearing_questions: z.number().int().nonnegative(),
    full_gold_at_5: RatioSchema,
    core_full_gold_at_5: RatioSchema,
    delivery_lift_questions: z.number().int().nonnegative(),
    delivery_drop_questions: z.number().int().nonnegative(),
    gold_coverage_at_5: RatioSchema,
    core_gold_coverage_at_5: RatioSchema,
    delivery_lift_golds: z.number().int().nonnegative(),
    delivery_drop_golds: z.number().int().nonnegative()
  })
  .strict();
export { FullGoldDeliveryContributionSchema };
export type FullGoldDeliveryContribution = z.infer<
  typeof FullGoldDeliveryContributionSchema
>;

const FullGoldCoverageSchema = z
  .object({
    gold_bearing_questions: z.number().int().nonnegative(),
    full_gold_at_5: RatioSchema,
    full_gold_at_10: RatioSchema,
    gold_coverage_at_5: RatioSchema,
    gold_coverage_at_10: RatioSchema,
    // Pool reach (pre-budget pool rank), distinct from the delivery-rank
    // coverage above: how many golds sit in the candidate pool within rank
    // 50/100 at all — separates retrieval/fusion reach from delivery budget.
    pool_recall_at_50: RatioSchema,
    pool_recall_at_100: RatioSchema,
    // Optional so older kpi.json records stay schema-valid; new LongMemEval
    // runs populate it from bench-runner delivery diagnostics.
    delivery_contribution: FullGoldDeliveryContributionSchema.optional()
  })
  .strict();
export type FullGoldCoverage = z.infer<typeof FullGoldCoverageSchema>;

export type { QualityMetrics } from "./kpi-quality-schema.js";

export type {
  EdgeProposalAutoAccept,
  EdgeProposalRate,
  QaMetrics,
  RecallEvalAttribution,
  RecallTokenEconomy,
  TokenEconomy
} from "./kpi-auxiliary-schema.js";



const KpiCoreSchema = z.object({
  r_at_1: RatioSchema,
  r_at_5: RatioSchema,
  r_at_10: RatioSchema,
  r_at_5_overall: RatioSchema.optional(),
  r_at_5_with_embedding_returned: RatioSchema.optional(),
  // Optional so older kpi.json records stay schema-valid; LongMemEval runs
  // populate it. The honest multi-fact口径 vs the official-hit r_at_5.
  full_gold_coverage: FullGoldCoverageSchema.optional(),
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
  // Optional so kpi.json records written before this block existed stay
  // schema-valid. When present, token_saved_ratio_vs_full_prompt is derived
  // from this block.
  token_economy: TokenEconomySchema.optional(),
  // Optional so kpi.json records written before per-recall diagnostics
  // existed stay schema-valid; runs that collect them populate it.
  // see also: @anchor recall-token-economy
  recall_token_economy: RecallTokenEconomySchema.optional(),
  tier_distribution: TierDistributionSchema,
  degradation_reasons: DegradationReasonsSchema,
  seed_truncation: SeedTruncationSchema,
  // Optional so older kpi.json records (pre seed-extraction disclosure)
  // stay schema-valid; new LongMemEval runs always populate it.
  seed_extraction_path: SeedExtractionPathSchema.optional(),
  seed_fuel_inventory: SeedFuelInventorySchema.optional(),
  quality_metrics: QualityMetricsSchema.optional(),
  // Edge Proposal KPI blocks (K3.2 + K3.4). Optional so older kpi.json
  // records stay schema-valid; new bench runs always populate them when
  // the bench-runner sources the edge proposal aggregator.
  edge_proposal_rate: EdgeProposalRateSchema.optional(),
  edge_proposal_auto_accept: EdgeProposalAutoAcceptSchema.optional(),
  // Optional: only present on --qa runs (end-to-end LLM-judge QA accuracy).
  qa_metrics: QaMetricsSchema.optional(),
  per_scenario: z.array(PerScenarioRowSchema)
});
export type KpiCore = z.infer<typeof KpiCoreSchema>;

const DiffVsPreviousSchema = z.object({
  previous_run: z.string(),
  r_at_5_delta_pp: z.number(),
  verdict_per_kpi: z.record(z.string(), Verdict)
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
    recall_eval_attribution: RecallEvalAttributionSchema.optional(),
    measurement_attribution: BenchmarkMeasurementAttributionSchema.optional(),
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
    // New producers populate the answerable/scorable metric denominator.
    // Optional preserves reads of historical artifacts.
    answerable_evaluated_count: z.number().int().nonnegative().optional(),
    harness_mode: HarnessMode,
    kpi: KpiCoreSchema,
    diff_vs_previous: DiffVsPreviousSchema.nullable().optional()
  })
  .refine((payload) => payload.evaluated_count <= payload.sample_size, {
    message: "evaluated_count must be <= sample_size",
    path: ["evaluated_count"]
  })
  .refine(
    (payload) => payload.answerable_evaluated_count === undefined ||
      payload.answerable_evaluated_count <= payload.evaluated_count,
    {
      message: "answerable_evaluated_count must be <= evaluated_count",
      path: ["answerable_evaluated_count"]
    }
  )
  .superRefine(validateMeasurementDenominatorContract);
export type KpiPayload = z.infer<typeof KpiPayloadSchema>;
