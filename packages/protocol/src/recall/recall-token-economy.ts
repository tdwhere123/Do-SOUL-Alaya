import { z } from "zod";

export const RECALL_TOKEN_ECONOMY_SAMPLE_SCHEMA_VERSION = "bench-recall-token-economy.v1" as const;

// Per-recall sample fields. Aggregates (mean/p50/…) are owned by eval KPI
// contracts and must derive from this shape rather than redeclare it.
export const RecallTokenEconomySampleSchema = z
  .object({
    delivered_context_tokens_estimate: z.number().int().nonnegative(),
    coarse_pool_size: z.number().int().nonnegative(),
    fine_evaluated: z.number().int().nonnegative(),
    fine_pruned_count: z.number().int().nonnegative(),
    fine_priority_overflow_count: z.number().int().nonnegative().default(0),
    fusion_families_with_hits: z.number().int().nonnegative(),
    embedding_inference_calls: z.number().int().nonnegative()
  })
  .strict()
  .readonly();

export type RecallTokenEconomySample = z.infer<typeof RecallTokenEconomySampleSchema>;
