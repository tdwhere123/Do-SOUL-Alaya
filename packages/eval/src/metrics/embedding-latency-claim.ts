import type { KpiPayload } from "../contracts/kpi-schema.js";

export type EmbeddingLatencyClaim =
  | { readonly status: "absent" }
  | { readonly status: "warm_cache_only"; readonly mean: number }
  | { readonly status: "in_timer"; readonly mean: number };

/**
 * The p95 embedding-on gate is claimable only when an explicit mean
 * `embedding_inference_calls` reaches one per recall. An absent measurement
 * proves neither an in-timer encode nor a warm-cache-only run.
 */
export function readEmbeddingLatencyClaim(
  current: KpiPayload
): EmbeddingLatencyClaim {
  const mean = current.kpi.recall_token_economy?.embedding_inference_calls.mean;
  if (mean === undefined) return { status: "absent" };
  return mean < 1
    ? { status: "warm_cache_only", mean }
    : { status: "in_timer", mean };
}
