import {
  computePercentile as computeOwnedPercentile,
  summarizeEmbeddingVectorCache as summarizeOwnedEmbeddingVectorCache,
  summarizeQueryEmbeddingCache as summarizeOwnedQueryEmbeddingCache
} from "../datasets/longmemeval/runner/runner-helpers.js";
import type {
  BenchEmbeddingWarmupSummary,
  BenchQueryEmbeddingWarmupSummary
} from "../harness/daemon.js";
import type {
  BenchEmbeddingVectorCacheSummary,
  BenchQueryEmbeddingCacheSummary
} from "./types.js";

export function computePercentile(values: readonly number[], p: number): number {
  return computeOwnedPercentile([...values], p);
}

export function summarizeEmbeddingVectorCache(
  summaries: readonly BenchEmbeddingWarmupSummary[]
): BenchEmbeddingVectorCacheSummary | null {
  return summarizeOwnedEmbeddingVectorCache(summaries);
}

export function summarizeQueryEmbeddingCache(
  summaries: readonly BenchQueryEmbeddingWarmupSummary[]
): BenchQueryEmbeddingCacheSummary | null {
  return summarizeOwnedQueryEmbeddingCache(summaries);
}
