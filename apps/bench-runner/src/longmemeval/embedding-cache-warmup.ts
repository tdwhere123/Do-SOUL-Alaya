import type {
  BenchEmbeddingMode,
  BenchEmbeddingWarmupSummary,
  BenchQueryEmbeddingWarmupSummary,
  BenchWorkspaceHandle
} from "../harness/daemon.js";

export interface LongMemEvalEmbeddingCacheWarmup {
  readonly embeddingWarmup: BenchEmbeddingWarmupSummary | null;
  // Always null: query encode belongs inside the timed recall window.
  readonly queryEmbeddingWarmup: BenchQueryEmbeddingWarmupSummary | null;
}

/**
 * Warm document vectors only. Query encode stays inside scored recall so
 * latency_ms / embedding_inference_calls reflect a product-request SLI, not a
 * warm-cache ranking SLI. Gate claims must not use pre-warmed query numbers.
 */
export async function warmLongMemEvalEmbeddingCaches(input: {
  readonly embeddingMode: BenchEmbeddingMode;
  readonly workspace: Pick<
    BenchWorkspaceHandle,
    "warmEmbeddingCache" | "warmQueryEmbeddingCache"
  >;
  readonly objectIds: readonly string[];
  readonly queryText: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): Promise<LongMemEvalEmbeddingCacheWarmup> {
  void input.queryText;
  void input.env;
  if (input.embeddingMode !== "env") {
    return { embeddingWarmup: null, queryEmbeddingWarmup: null };
  }
  const embeddingWarmup = await input.workspace.warmEmbeddingCache(input.objectIds);
  // Do not call warmQueryEmbeddingCache: encode must land in the timed recall.
  return { embeddingWarmup, queryEmbeddingWarmup: null };
}
