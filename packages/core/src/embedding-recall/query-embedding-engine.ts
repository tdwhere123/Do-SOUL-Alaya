import { createHash } from "node:crypto";

import { QUERY_EMBEDDING_WARMUP_BATCH_SIZE } from "./constants.js";
import {
  createPreparedEmbeddingQueryHandle,
  toErrorMessage,
  waitForPreparedQuery
} from "./helpers.js";
import type {
  EmbeddingProviderPort,
  EmbeddingQueryWarmupSummary,
  PreparedEmbeddingQueryHandle,
  PreparedEmbeddingQuerySnapshot
} from "./types.js";

export interface QueryEmbeddingEngineDependencies {
  readonly provider: EmbeddingProviderPort;
  readonly generateQueryId: () => string;
  readonly queryTimeoutMs: number;
  readonly queryEmbeddingCacheSize: number;
}

// LRU-cached query-embedding inference shared by the supplement and
// workspace-neighbor recall paths.
export class QueryEmbeddingEngine {
  private readonly queryEmbeddingCache = new Map<string, Float32Array>();

  public constructor(private readonly deps: QueryEmbeddingEngineDependencies) {}

  public prepareQueryEmbedding(params: {
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly queryText: string;
  }): PreparedEmbeddingQueryHandle {
    const queryId = this.deps.generateQueryId();

    if (!this.deps.provider.isAvailable) {
      // Provider unavailable means we never even attempted an inference;
      // count this as a cache hit (== zero inference calls) so the recall
      // token-economy figure is not inflated by failure-only paths.
      return createPreparedEmbeddingQueryHandle(
        queryId,
        Object.freeze({
          status: "failed",
          reason: "provider_unavailable"
        }),
        { cacheHit: true }
      );
    }

    const queryCacheKey = this.queryCacheKey(params.queryText);
    const cachedEmbedding = this.getCachedQueryEmbedding(queryCacheKey);
    if (cachedEmbedding !== null) {
      return createPreparedEmbeddingQueryHandle(
        queryId,
        Object.freeze({
          status: "ready",
          embedding: cachedEmbedding
        }),
        { cacheHit: true }
      );
    }

    let snapshot: PreparedEmbeddingQuerySnapshot = Object.freeze({
      status: "pending"
    });

    const settled = this.deps.provider
      .embedTexts([params.queryText], {
        timeoutMs: this.deps.queryTimeoutMs
      })
      .then((embeddings) => {
        if (embeddings.length !== 1) {
          throw new Error(`Expected exactly one query embedding, received ${embeddings.length}.`);
        }

        snapshot = Object.freeze({
          status: "ready",
          embedding: new Float32Array(embeddings[0]!)
        });
        this.putCachedQueryEmbedding(queryCacheKey, snapshot.embedding);
      })
      .catch((error) => {
        snapshot = Object.freeze({
          status: "failed",
          reason: "query_embedding_failed",
          error_name: error instanceof Error ? error.name : undefined,
          error_message: toErrorMessage(error)
        });
      });

    return createPreparedEmbeddingQueryHandle(queryId, () => snapshot, {
      cacheHit: false,
      waitForSnapshot: async (timeoutMs) => {
        if (snapshot.status !== "pending") {
          return snapshot;
        }
        await waitForPreparedQuery(settled, timeoutMs);
        return snapshot;
      }
    });
  }

  public async warmQueryEmbeddings(params: {
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly queryTexts: readonly string[];
  }): Promise<EmbeddingQueryWarmupSummary> {
    const uniqueQueryTexts = [...new Set(params.queryTexts.map((text) => text.trim()))]
      .filter((text) => text.length > 0);
    if (uniqueQueryTexts.length === 0) {
      return Object.freeze({
        status: "ready",
        requested_count: 0,
        ready_count: 0,
        cache_hit_count: 0,
        provider_requested_count: 0,
        missing_count: 0,
        provider_kind: this.deps.provider.providerKind,
        model_id: this.deps.provider.modelId
      });
    }
    if (!this.deps.provider.isAvailable) {
      return Object.freeze({
        status: "not_requested",
        requested_count: uniqueQueryTexts.length,
        ready_count: 0,
        cache_hit_count: 0,
        provider_requested_count: 0,
        missing_count: uniqueQueryTexts.length,
        provider_kind: null,
        model_id: null
      });
    }

    const missingQueryTexts = uniqueQueryTexts.filter(
      (queryText) => this.getCachedQueryEmbedding(this.queryCacheKey(queryText)) === null
    );
    let lastError: string | undefined;
    for (
      let offset = 0;
      offset < missingQueryTexts.length;
      offset += QUERY_EMBEDDING_WARMUP_BATCH_SIZE
    ) {
      const batch = missingQueryTexts.slice(offset, offset + QUERY_EMBEDDING_WARMUP_BATCH_SIZE);
      try {
        const embeddings = await this.deps.provider.embedTexts(batch, {
          timeoutMs: this.deps.queryTimeoutMs
        });
        if (embeddings.length !== batch.length) {
          throw new Error(`Expected ${batch.length} warmed query embeddings, received ${embeddings.length}.`);
        }
        for (let i = 0; i < batch.length; i++) {
          const queryText = batch[i]!;
          this.putCachedQueryEmbedding(
            this.queryCacheKey(queryText),
            new Float32Array(embeddings[i]!)
          );
        }
      } catch (error) {
        lastError = toErrorMessage(error);
      }
    }

    const readyCount = uniqueQueryTexts.filter(
      (queryText) => this.getCachedQueryEmbedding(this.queryCacheKey(queryText)) !== null
    ).length;
    return Object.freeze({
      status: "ready",
      requested_count: uniqueQueryTexts.length,
      ready_count: readyCount,
      cache_hit_count: uniqueQueryTexts.length - missingQueryTexts.length,
      provider_requested_count: missingQueryTexts.length,
      missing_count: Math.max(0, uniqueQueryTexts.length - readyCount),
      provider_kind: this.deps.provider.providerKind,
      model_id: this.deps.provider.modelId,
      ...(lastError === undefined ? {} : { last_error: lastError })
    });
  }

  // Degradation recording stays in the caller so this stays a pure resolver.
  public async resolveQueryEmbeddingNow(queryText: string): Promise<Float32Array> {
    const embeddings = await this.deps.provider.embedTexts([queryText], {
      timeoutMs: this.deps.queryTimeoutMs
    });
    if (embeddings.length !== 1) {
      throw new Error(`Expected exactly one query embedding, received ${embeddings.length}.`);
    }
    return new Float32Array(embeddings[0]!);
  }

  private queryCacheKey(queryText: string): string {
    return `sha256:${createHash("sha256").update(queryText.trim()).digest("hex")}`;
  }

  private getCachedQueryEmbedding(cacheKey: string): Float32Array | null {
    const cached = this.queryEmbeddingCache.get(cacheKey);
    if (cached === undefined) {
      return null;
    }
    this.queryEmbeddingCache.delete(cacheKey);
    this.queryEmbeddingCache.set(cacheKey, cached);
    return new Float32Array(cached);
  }

  private putCachedQueryEmbedding(cacheKey: string, embedding: Float32Array): void {
    if (this.deps.queryEmbeddingCacheSize <= 0) {
      return;
    }
    this.queryEmbeddingCache.delete(cacheKey);
    this.queryEmbeddingCache.set(cacheKey, new Float32Array(embedding));
    while (this.queryEmbeddingCache.size > this.deps.queryEmbeddingCacheSize) {
      const oldestKey = this.queryEmbeddingCache.keys().next().value as string | undefined;
      if (oldestKey === undefined) {
        break;
      }
      this.queryEmbeddingCache.delete(oldestKey);
    }
  }
}
