import { warmDocumentEmbeddingCaches } from "../bench/embedding-warmup.js";
import type {
  BenchEmbeddingMode,
  BenchEmbeddingWarmupSummary,
  BenchQueryEmbeddingWarmupSummary,
  BenchWorkspaceHandle
} from "../harness/daemon.js";

export interface LocomoEmbeddingCacheWarmup {
  readonly embeddingWarmup: BenchEmbeddingWarmupSummary | null;
  readonly queryEmbeddingWarmup: BenchQueryEmbeddingWarmupSummary | null;
}

/**
 * Warm document vectors only. Query encode stays inside scored recall so
 * latency_ms / embedding_inference_calls reflect a product-request SLI, not a
 * warm-cache ranking SLI. Gate claims must not use pre-warmed query numbers.
 */
export async function warmLocomoEmbeddingCaches(input: {
  readonly embeddingMode: BenchEmbeddingMode;
  readonly workspace: Pick<
    BenchWorkspaceHandle,
    "warmEmbeddingCache" | "warmQueryEmbeddingCache"
  >;
  readonly objectIds: readonly string[];
  readonly queryTexts: readonly string[];
}): Promise<LocomoEmbeddingCacheWarmup> {
  void input.queryTexts;
  const warmed = await warmDocumentEmbeddingCaches({
    embeddingMode: input.embeddingMode,
    workspace: input.workspace,
    objectIds: input.objectIds
  });
  return {
    embeddingWarmup: warmed.embeddingWarmup,
    queryEmbeddingWarmup: warmed.queryEmbeddingWarmup
  };
}
