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

export const KpiPayloadSchema = z.object({
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
  kpi: KpiCoreSchema,
  diff_vs_previous: DiffVsPreviousSchema.nullable().optional()
});
export type KpiPayload = z.infer<typeof KpiPayloadSchema>;
