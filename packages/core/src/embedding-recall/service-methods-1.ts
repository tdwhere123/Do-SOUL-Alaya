import { createHash, randomUUID } from "node:crypto";

import {
  ComputeRecallGardenEventType,
  HealthEventKind,
  RecallEmbeddingSupplementDegradedPayloadSchema,
  RecallEmbeddingSupplementMergedPayloadSchema,
  RecallEmbeddingSupplementQueriedPayloadSchema,
  type EventLogEntry,
  type MemoryEntry
} from "@do-soul/alaya-protocol";

import {
  DEFAULT_QUERY_EMBEDDING_CACHE_SIZE,
  DEFAULT_QUERY_TIMEOUT_MS,
  QUERY_EMBEDDING_WARMUP_BATCH_SIZE,
  resolveEmbeddingWorkspaceScanCap
} from "./constants.js";

import { resolveEmbeddingRecallTiers } from "./tier-config.js";

import {
  EMPTY_SUPPLEMENT_RESULT,
  clamp01,
  clampQueryEmbeddingCacheSize,
  clampQueryTimeout,
  cosineSimilarity,
  createPreparedEmbeddingQueryHandle,
  emptyWorkspaceNeighborResult,
  hashMemoryContent,
  toErrorMessage,
  waitForPreparedQuery
} from "./helpers.js";

import type {
  EmbeddingNeighborHit,
  EmbeddingQueryWarmupSummary,
  EmbeddingRecallServiceDependencies,
  EmbeddingRecallSupplementResult,
  EmbeddingVectorRecord,
  EmbeddingWorkspaceNeighborResult,
  PreparedEmbeddingQueryHandle,
  PreparedEmbeddingQuerySnapshot,
  PreparedEmbeddingSupplement
} from "./types.js";
type EmbeddingRecallServiceMethodOwner = {
  generateQueryId: () => string;
  now: () => string;
  warn: (message: string, meta: Record<string, unknown>) => void;
  queryTimeoutMs: number;
  queryEmbeddingCacheSize: number;
  queryEmbeddingCache: any;
  dependencies: EmbeddingRecallServiceDependencies;
  [key: string]: any;
};


interface EmbeddingRecallPrecheckError extends Error {
  readonly reason: "local_vector_lookup_failed";
}

export function embeddingRecallServicePrepareQueryEmbedding(owner: EmbeddingRecallServiceMethodOwner, params: {
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly queryText: string;
  }): PreparedEmbeddingQueryHandle {
    const queryId = owner.generateQueryId();

    if (!owner.dependencies.provider.isAvailable) {
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

    const queryCacheKey = owner.queryCacheKey(params.queryText);
    const cachedEmbedding = owner.getCachedQueryEmbedding(queryCacheKey);
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

    const settled = owner.dependencies.provider
      .embedTexts([params.queryText], {
        timeoutMs: owner.queryTimeoutMs
      })
      .then((embeddings) => {
        if (embeddings.length !== 1) {
          throw new Error(`Expected exactly one query embedding, received ${embeddings.length}.`);
        }

        snapshot = Object.freeze({
          status: "ready",
          embedding: new Float32Array(embeddings[0]!)
        });
        owner.putCachedQueryEmbedding(queryCacheKey, snapshot.embedding);
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

export async function embeddingRecallServiceWarmQueryEmbeddings(owner: EmbeddingRecallServiceMethodOwner, params: {
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
        provider_kind: owner.dependencies.provider.providerKind,
        model_id: owner.dependencies.provider.modelId
      });
    }
    if (!owner.dependencies.provider.isAvailable) {
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
      (queryText) => owner.getCachedQueryEmbedding(owner.queryCacheKey(queryText)) === null
    );
    let lastError: string | undefined;
    for (
      let offset = 0;
      offset < missingQueryTexts.length;
      offset += QUERY_EMBEDDING_WARMUP_BATCH_SIZE
    ) {
      const batch = missingQueryTexts.slice(offset, offset + QUERY_EMBEDDING_WARMUP_BATCH_SIZE);
      try {
        const embeddings = await owner.dependencies.provider.embedTexts(batch, {
          timeoutMs: owner.queryTimeoutMs
        });
        if (embeddings.length !== batch.length) {
          throw new Error(`Expected ${batch.length} warmed query embeddings, received ${embeddings.length}.`);
        }
        for (let i = 0; i < batch.length; i++) {
          const queryText = batch[i]!;
          owner.putCachedQueryEmbedding(
            owner.queryCacheKey(queryText),
            new Float32Array(embeddings[i]!)
          );
        }
      } catch (error) {
        lastError = toErrorMessage(error);
      }
    }

    const readyCount = uniqueQueryTexts.filter(
      (queryText) => owner.getCachedQueryEmbedding(owner.queryCacheKey(queryText)) !== null
    ).length;
    return Object.freeze({
      status: "ready",
      requested_count: uniqueQueryTexts.length,
      ready_count: readyCount,
      cache_hit_count: uniqueQueryTexts.length - missingQueryTexts.length,
      provider_requested_count: missingQueryTexts.length,
      missing_count: Math.max(0, uniqueQueryTexts.length - readyCount),
      provider_kind: owner.dependencies.provider.providerKind,
      model_id: owner.dependencies.provider.modelId,
      ...(lastError === undefined ? {} : { last_error: lastError })
    });
  }

export async function embeddingRecallServiceHasStoredVectors(owner: EmbeddingRecallServiceMethodOwner, params: {
    readonly workspaceId: string;
    readonly eligibleMemories: readonly Readonly<MemoryEntry>[];
  }): Promise<boolean> {
    if (params.eligibleMemories.length === 0) {
      return false;
    }

    try {
      const storedVectors = await owner.dependencies.embeddingRepo.listByObjectIds(
        params.workspaceId,
        params.eligibleMemories.map((memory) => memory.object_id)
      );
      return storedVectors.length > 0;
    } catch (error) {
      owner.warn("embedding supplement precheck failed", {
        workspace_id: params.workspaceId,
        reason: "local_vector_lookup_failed",
        error: toErrorMessage(error)
      });
      throw Object.assign(new Error("embedding supplement precheck failed"), {
        reason: "local_vector_lookup_failed"
      } satisfies Pick<EmbeddingRecallPrecheckError, "reason">);
    }
  }

export async function embeddingRecallServicePrepareQuerySupplement(owner: EmbeddingRecallServiceMethodOwner, params: {
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly queryText: string;
    readonly eligibleMemories: readonly Readonly<MemoryEntry>[];
    readonly baseCandidateCount: number;
  }): Promise<PreparedEmbeddingSupplement> {
    if (params.eligibleMemories.length === 0) {
      return Object.freeze({
        preparedQuery: null,
        storedVectors: Object.freeze([]),
        degradedReason: null
      });
    }

    let storedVectors: readonly Readonly<EmbeddingVectorRecord>[];
    try {
      storedVectors = await owner.dependencies.embeddingRepo.listByObjectIds(
        params.workspaceId,
        params.eligibleMemories.map((memory) => memory.object_id)
      );
    } catch (error) {
      owner.warn("embedding supplement precheck failed", {
        workspace_id: params.workspaceId,
        reason: "local_vector_lookup_failed",
        error: toErrorMessage(error)
      });
      await owner.recordDegraded({
        workspaceId: params.workspaceId,
        runId: params.runId,
        queryId: owner.generateQueryId(),
        reason: "local_vector_lookup_failed",
        baseCandidateCount: params.baseCandidateCount,
        fallbackCandidateCount: params.baseCandidateCount
      });
      return Object.freeze({
        preparedQuery: null,
        storedVectors: Object.freeze([]),
        degradedReason: "local_vector_lookup_failed"
      });
    }

    if (storedVectors.length === 0) {
      return Object.freeze({
        preparedQuery: null,
        storedVectors: Object.freeze([]),
        degradedReason: null
      });
    }

    return Object.freeze({
      preparedQuery: owner.prepareQueryEmbedding({
        workspaceId: params.workspaceId,
        runId: params.runId,
        queryText: params.queryText
      }),
      storedVectors,
      degradedReason: null
    });
  }

export async function embeddingRecallServiceCoherentPairKeys(owner: EmbeddingRecallServiceMethodOwner, params: {
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly objectIds: readonly string[];
    readonly floor: number;
  }): Promise<ReadonlySet<string>> {
    const empty: ReadonlySet<string> = new Set<string>();
    if (params.objectIds.length < 2) {
      return empty;
    }

    let storedVectors: readonly Readonly<EmbeddingVectorRecord>[];
    try {
      storedVectors = await owner.dependencies.embeddingRepo.listByObjectIds(
        params.workspaceId,
        params.objectIds
      );
    } catch (error) {
      owner.warn("co-recall coherence gate degraded", {
        workspace_id: params.workspaceId,
        run_id: params.runId,
        reason: "local_vector_lookup_failed",
        error: toErrorMessage(error)
      });
      return empty;
    }

    // Restrict to the active (provider_kind, model_id, schema_version) cosine
    // space and drop self-inconsistent records (dimensions !== embedding length);
    // cosineSimilarity's length guard handles any residual width disagreement
    // (returns 0), so a mismatched pair is simply not coherent.
    const vectorsByObjectId = new Map<string, Float32Array>();
    for (const record of storedVectors) {
      if (
        record.provider_kind === owner.dependencies.provider.providerKind &&
        record.model_id === owner.dependencies.provider.modelId &&
        record.schema_version === owner.dependencies.provider.schemaVersion &&
        record.dimensions === record.embedding.length
      ) {
        vectorsByObjectId.set(record.object_id, record.embedding);
      }
    }

    const coherent = new Set<string>();
    const ids = params.objectIds;
    for (let i = 0; i < ids.length; i += 1) {
      const vecA = vectorsByObjectId.get(ids[i]!);
      if (vecA === undefined) {
        continue;
      }
      for (let j = i + 1; j < ids.length; j += 1) {
        const vecB = vectorsByObjectId.get(ids[j]!);
        if (vecB === undefined) {
          continue;
        }
        if (cosineSimilarity(vecA, vecB) >= params.floor) {
          const [low, high] = ids[i]! < ids[j]! ? [ids[i]!, ids[j]!] : [ids[j]!, ids[i]!];
          coherent.add(`${low}|${high}`);
        }
      }
    }

    return coherent;
  }

export function embeddingRecallServiceQueryCacheKey(owner: EmbeddingRecallServiceMethodOwner, queryText: string): string {
    return `sha256:${createHash("sha256").update(queryText.trim()).digest("hex")}`;
  }

export function embeddingRecallServiceGetCachedQueryEmbedding(owner: EmbeddingRecallServiceMethodOwner, cacheKey: string): Float32Array | null {
    const cached = owner.queryEmbeddingCache.get(cacheKey);
    if (cached === undefined) {
      return null;
    }
    owner.queryEmbeddingCache.delete(cacheKey);
    owner.queryEmbeddingCache.set(cacheKey, cached);
    return new Float32Array(cached);
  }

export function embeddingRecallServicePutCachedQueryEmbedding(owner: EmbeddingRecallServiceMethodOwner, cacheKey: string, embedding: Float32Array): void {
    if (owner.queryEmbeddingCacheSize <= 0) {
      return;
    }
    owner.queryEmbeddingCache.delete(cacheKey);
    owner.queryEmbeddingCache.set(cacheKey, new Float32Array(embedding));
    while (owner.queryEmbeddingCache.size > owner.queryEmbeddingCacheSize) {
      const oldestKey = owner.queryEmbeddingCache.keys().next().value as string | undefined;
      if (oldestKey === undefined) {
        break;
      }
      owner.queryEmbeddingCache.delete(oldestKey);
    }
  }

export async function embeddingRecallServiceRecordPrecheckDegraded(owner: EmbeddingRecallServiceMethodOwner, params: {
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly reason: string;
    readonly baseCandidateCount: number;
    readonly fallbackCandidateCount: number;
  }): Promise<void> {
    await owner.recordDegraded({
      workspaceId: params.workspaceId,
      runId: params.runId,
      queryId: owner.generateQueryId(),
      reason: params.reason,
      baseCandidateCount: params.baseCandidateCount,
      fallbackCandidateCount: params.fallbackCandidateCount
    });
  }

export async function embeddingRecallServiceQuerySupplement(owner: EmbeddingRecallServiceMethodOwner, params: {
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly queryText: string;
    readonly eligibleMemories: readonly Readonly<MemoryEntry>[];
    readonly baseCandidateIds: readonly string[];
    readonly maxSupplement: number;
  }): Promise<EmbeddingRecallSupplementResult> {
    if (params.maxSupplement <= 0 || params.eligibleMemories.length === 0) {
      return EMPTY_SUPPLEMENT_RESULT;
    }

    const queryId = owner.generateQueryId();
    if (!owner.dependencies.provider.isAvailable) {
      await owner.recordDegraded({
        workspaceId: params.workspaceId,
        runId: params.runId,
        queryId,
        reason: "provider_unavailable",
        baseCandidateCount: params.baseCandidateIds.length,
        fallbackCandidateCount: params.baseCandidateIds.length
      });
      return EMPTY_SUPPLEMENT_RESULT;
    }

    const storedVectors = await owner.loadStoredVectors({
      workspaceId: params.workspaceId,
      runId: params.runId,
      queryId,
      eligibleMemories: params.eligibleMemories,
      baseCandidateCount: params.baseCandidateIds.length
    });

    if (storedVectors === null || storedVectors.length === 0) {
      return EMPTY_SUPPLEMENT_RESULT;
    }

    const queryEmbedding = await owner.resolveQueryEmbeddingNow({
      workspaceId: params.workspaceId,
      runId: params.runId,
      queryId,
      queryText: params.queryText,
      baseCandidateCount: params.baseCandidateIds.length
    });

    if (queryEmbedding === null) {
      return EMPTY_SUPPLEMENT_RESULT;
    }

    return await owner.buildSupplementFromQueryEmbedding({
      workspaceId: params.workspaceId,
      runId: params.runId,
      queryId,
      queryEmbedding,
      storedVectors,
      eligibleMemories: params.eligibleMemories,
      baseCandidateIds: params.baseCandidateIds,
      maxSupplement: params.maxSupplement
    });
  }
