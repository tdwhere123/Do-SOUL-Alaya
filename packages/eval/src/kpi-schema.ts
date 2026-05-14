import { z } from "zod";

export const BenchSplit = z.enum(["golden", "synthetic", "longmemeval-s"]);
export type BenchSplit = z.infer<typeof BenchSplit>;

export const BenchName = z.enum(["self", "public"]);
export type BenchName = z.infer<typeof BenchName>;

export const Verdict = z.enum(["ok", "warn", "fail"]);
export type Verdict = z.infer<typeof Verdict>;

const TierDistributionSchema = z.object({
  hot: z.number().int().nonnegative(),
  warm: z.number().int().nonnegative(),
  cold: z.number().int().nonnegative()
});
export type TierDistribution = z.infer<typeof TierDistributionSchema>;

const DegradationReasonsSchema = z.object({
  none: z.number().int().nonnegative(),
  warm_cascade_engaged: z.number().int().nonnegative(),
  cold_cascade_engaged: z.number().int().nonnegative()
});
export type DegradationReasons = z.infer<typeof DegradationReasonsSchema>;

const PerScenarioRowSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  hit_at_5: z.boolean(),
  tier: z.enum(["hot", "warm", "cold"])
});
export type PerScenarioRow = z.infer<typeof PerScenarioRowSchema>;

const KpiCoreSchema = z.object({
  r_at_1: z.number().min(0).max(1),
  r_at_5: z.number().min(0).max(1),
  r_at_10: z.number().min(0).max(1),
  latency_ms_p50: z.number().nonnegative(),
  latency_ms_p95: z.number().nonnegative(),
  token_saved_ratio_vs_full_prompt: z.number(),
  tier_distribution: TierDistributionSchema,
  degradation_reasons: DegradationReasonsSchema,
  per_scenario: z.array(PerScenarioRowSchema)
});
export type KpiCore = z.infer<typeof KpiCoreSchema>;

const DiffVsPreviousSchema = z.object({
  previous_run: z.string(),
  r_at_5_delta_pp: z.number(),
  verdict_per_kpi: z.record(Verdict)
});
export type DiffVsPrevious = z.infer<typeof DiffVsPreviousSchema>;

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
 */
export const HarnessMode = z.enum([
  "direct_db_seed",
  "mcp_propose_review",
  "external_replay"
]);
export type HarnessMode = z.infer<typeof HarnessMode>;

export const KpiPayloadSchema = z
  .object({
    bench_name: BenchName,
    split: BenchSplit,
    run_at: z.string(),
    alaya_commit: z.string().min(7),
    alaya_version: z.string().min(1),
    embedding_provider: z.string(),
    chat_provider: z.string(),
    dataset: z.object({
      name: z.string(),
      size: z.number().int().nonnegative(),
      source: z.string()
    }),
    // sample_size = the total questions / scenarios the dataset offers.
    //   LongMemEval Oracle full set = 50; self synthetic = 8.
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
