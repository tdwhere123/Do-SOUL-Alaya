import { warmDocumentEmbeddingCaches } from "../../../bench/embedding-warmup.js";
import type {
  BenchEmbeddingMode,
  BenchEmbeddingWarmupSummary,
  BenchQueryEmbeddingWarmupSummary,
  BenchWorkspaceHandle
} from "../../../harness/daemon.js";

export interface LongMemEvalEmbeddingCacheWarmup {
  readonly embeddingWarmup: BenchEmbeddingWarmupSummary | null;
  // Always null: query encode belongs inside the timed recall window.
  readonly queryEmbeddingWarmup: BenchQueryEmbeddingWarmupSummary | null;
  readonly documentWarmupLatencyMs: number | null;
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
  readonly now?: () => number;
}): Promise<LongMemEvalEmbeddingCacheWarmup> {
  void input.queryText;
  void input.env;
  return warmDocumentEmbeddingCaches({
    embeddingMode: input.embeddingMode,
    workspace: input.workspace,
    objectIds: input.objectIds,
    backfillMode: "cache_only",
    ...(input.now === undefined ? {} : { now: input.now })
  });
}
