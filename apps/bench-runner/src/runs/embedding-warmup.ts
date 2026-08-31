import type {
  BenchEmbeddingMode,
  BenchEmbeddingWarmupSummary,
  BenchQueryEmbeddingWarmupSummary,
  BenchWorkspaceHandle
} from "../harness/daemon.js";

export interface BenchEmbeddingCacheWarmup {
  readonly embeddingWarmup: BenchEmbeddingWarmupSummary | null;
  readonly queryEmbeddingWarmup: BenchQueryEmbeddingWarmupSummary | null;
  readonly documentWarmupLatencyMs: number | null;
}

/**
 * Warm document vectors only. Query encode stays inside scored recall so
 * latency_ms / embedding_inference_calls reflect a product-request SLI.
 */
export async function warmDocumentEmbeddingCaches(input: {
  readonly embeddingMode: BenchEmbeddingMode;
  readonly workspace: Pick<
    BenchWorkspaceHandle,
    "warmEmbeddingCache" | "warmQueryEmbeddingCache"
  >;
  readonly objectIds: readonly string[];
  readonly backfillMode?: "cache_only";
  readonly now?: () => number;
}): Promise<BenchEmbeddingCacheWarmup> {
  if (input.embeddingMode !== "env") {
    return {
      embeddingWarmup: null,
      queryEmbeddingWarmup: null,
      documentWarmupLatencyMs: null
    };
  }
  const now = input.now ?? performance.now.bind(performance);
  const startedAt = now();
  const embeddingWarmup = await warmDocumentVectors(input);
  return {
    embeddingWarmup,
    queryEmbeddingWarmup: null,
    documentWarmupLatencyMs: Math.max(0, now() - startedAt)
  };
}

function warmDocumentVectors(
  input: Parameters<typeof warmDocumentEmbeddingCaches>[0]
): Promise<BenchEmbeddingWarmupSummary> {
  if (input.backfillMode === undefined) {
    return input.workspace.warmEmbeddingCache(input.objectIds);
  }
  return input.workspace.warmEmbeddingCache(input.objectIds, {
    backfillMode: input.backfillMode
  });
}
