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

interface EmbeddingRecallPrecheckError extends Error {
  readonly reason: "local_vector_lookup_failed";
}

export class EmbeddingRecallService {
  private readonly generateQueryId: () => string;
  private readonly now: () => string;
  private readonly warn: (message: string, meta: Record<string, unknown>) => void;
  private readonly queryTimeoutMs: number;
  private readonly queryEmbeddingCacheSize: number;
  private readonly queryEmbeddingCache = new Map<string, Float32Array>();

  public constructor(private readonly dependencies: EmbeddingRecallServiceDependencies) {
    this.generateQueryId = dependencies.generateQueryId ?? (() => `recall-embedding-${randomUUID()}`);
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.warn = dependencies.warn ?? (() => undefined);
    this.queryTimeoutMs = clampQueryTimeout(dependencies.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS);
    this.queryEmbeddingCacheSize = clampQueryEmbeddingCacheSize(
      dependencies.queryEmbeddingCacheSize ?? DEFAULT_QUERY_EMBEDDING_CACHE_SIZE
    );
  }

  public prepareQueryEmbedding(params: {
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly queryText: string;
  }): PreparedEmbeddingQueryHandle {
    const queryId = this.generateQueryId();

    if (!this.dependencies.provider.isAvailable) {
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

    const settled = this.dependencies.provider
      .embedTexts([params.queryText], {
        timeoutMs: this.queryTimeoutMs
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
        provider_kind: this.dependencies.provider.providerKind,
        model_id: this.dependencies.provider.modelId
      });
    }
    if (!this.dependencies.provider.isAvailable) {
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
        const embeddings = await this.dependencies.provider.embedTexts(batch, {
          timeoutMs: this.queryTimeoutMs
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
      provider_kind: this.dependencies.provider.providerKind,
      model_id: this.dependencies.provider.modelId,
      ...(lastError === undefined ? {} : { last_error: lastError })
    });
  }

  public async hasStoredVectors(params: {
    readonly workspaceId: string;
    readonly eligibleMemories: readonly Readonly<MemoryEntry>[];
  }): Promise<boolean> {
    if (params.eligibleMemories.length === 0) {
      return false;
    }

    try {
      const storedVectors = await this.dependencies.embeddingRepo.listByObjectIds(
        params.workspaceId,
        params.eligibleMemories.map((memory) => memory.object_id)
      );
      return storedVectors.length > 0;
    } catch (error) {
      this.warn("embedding supplement precheck failed", {
        workspace_id: params.workspaceId,
        reason: "local_vector_lookup_failed",
        error: toErrorMessage(error)
      });
      throw Object.assign(new Error("embedding supplement precheck failed"), {
        reason: "local_vector_lookup_failed"
      } satisfies Pick<EmbeddingRecallPrecheckError, "reason">);
    }
  }

  public async prepareQuerySupplement(params: {
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
      storedVectors = await this.dependencies.embeddingRepo.listByObjectIds(
        params.workspaceId,
        params.eligibleMemories.map((memory) => memory.object_id)
      );
    } catch (error) {
      this.warn("embedding supplement precheck failed", {
        workspace_id: params.workspaceId,
        reason: "local_vector_lookup_failed",
        error: toErrorMessage(error)
      });
      await this.recordDegraded({
        workspaceId: params.workspaceId,
        runId: params.runId,
        queryId: this.generateQueryId(),
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
      preparedQuery: this.prepareQueryEmbedding({
        workspaceId: params.workspaceId,
        runId: params.runId,
        queryText: params.queryText
      }),
      storedVectors,
      degradedReason: null
    });
  }

  /**
   * Endpoint-coherence gate for the co-recall plasticity loop (ARC 3). Fetches
   * the stored embedding vectors for the delivered object ids, restricts to the
   * active (provider_kind, model_id, schema_version) cosine space and drops
   * self-inconsistent records (dimensions !== embedding length); cosineSimilarity's
   * length guard handles any residual width disagreement (returns 0). Returns the
   * canonical `${low}|${high}` keys (object_ids sorted ascending)
   * of every unordered pair whose cosine similarity is at or above `floor`.
   *
   * Gold-blind: only object-vs-object cosine, never gold/answer knowledge. A pair
   * with a missing or mismatched vector is simply absent from the result. Never
   * throws — a repo failure warns and returns an empty set, so the fire-and-forget
   * caller treats it as "no coherent pairs" (embedding-off behavior is unchanged).
   */
  public async coherentPairKeys(params: {
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
      storedVectors = await this.dependencies.embeddingRepo.listByObjectIds(
        params.workspaceId,
        params.objectIds
      );
    } catch (error) {
      this.warn("co-recall coherence gate degraded", {
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
        record.provider_kind === this.dependencies.provider.providerKind &&
        record.model_id === this.dependencies.provider.modelId &&
        record.schema_version === this.dependencies.provider.schemaVersion &&
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
    if (this.queryEmbeddingCacheSize <= 0) {
      return;
    }
    this.queryEmbeddingCache.delete(cacheKey);
    this.queryEmbeddingCache.set(cacheKey, new Float32Array(embedding));
    while (this.queryEmbeddingCache.size > this.queryEmbeddingCacheSize) {
      const oldestKey = this.queryEmbeddingCache.keys().next().value as string | undefined;
      if (oldestKey === undefined) {
        break;
      }
      this.queryEmbeddingCache.delete(oldestKey);
    }
  }

  public async recordPrecheckDegraded(params: {
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly reason: string;
    readonly baseCandidateCount: number;
    readonly fallbackCandidateCount: number;
  }): Promise<void> {
    await this.recordDegraded({
      workspaceId: params.workspaceId,
      runId: params.runId,
      queryId: this.generateQueryId(),
      reason: params.reason,
      baseCandidateCount: params.baseCandidateCount,
      fallbackCandidateCount: params.fallbackCandidateCount
    });
  }

  public async querySupplement(params: {
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

    const queryId = this.generateQueryId();
    if (!this.dependencies.provider.isAvailable) {
      await this.recordDegraded({
        workspaceId: params.workspaceId,
        runId: params.runId,
        queryId,
        reason: "provider_unavailable",
        baseCandidateCount: params.baseCandidateIds.length,
        fallbackCandidateCount: params.baseCandidateIds.length
      });
      return EMPTY_SUPPLEMENT_RESULT;
    }

    const storedVectors = await this.loadStoredVectors({
      workspaceId: params.workspaceId,
      runId: params.runId,
      queryId,
      eligibleMemories: params.eligibleMemories,
      baseCandidateCount: params.baseCandidateIds.length
    });

    if (storedVectors === null || storedVectors.length === 0) {
      return EMPTY_SUPPLEMENT_RESULT;
    }

    const queryEmbedding = await this.resolveQueryEmbeddingNow({
      workspaceId: params.workspaceId,
      runId: params.runId,
      queryId,
      queryText: params.queryText,
      baseCandidateCount: params.baseCandidateIds.length
    });

    if (queryEmbedding === null) {
      return EMPTY_SUPPLEMENT_RESULT;
    }

    return await this.buildSupplementFromQueryEmbedding({
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

  public async querySupplementIfReady(params: {
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly eligibleMemories: readonly Readonly<MemoryEntry>[];
    readonly baseCandidateIds: readonly string[];
    readonly maxSupplement: number;
    readonly preparedQuery: PreparedEmbeddingQueryHandle;
    readonly storedVectors?: readonly Readonly<EmbeddingVectorRecord>[];
  }): Promise<EmbeddingRecallSupplementResult> {
    if (params.maxSupplement <= 0 || params.eligibleMemories.length === 0) {
      return EMPTY_SUPPLEMENT_RESULT;
    }

    const storedVectors =
      params.storedVectors ??
      await this.loadStoredVectors({
        workspaceId: params.workspaceId,
        runId: params.runId,
        queryId: params.preparedQuery.queryId,
        eligibleMemories: params.eligibleMemories,
        baseCandidateCount: params.baseCandidateIds.length
      });

    if (storedVectors === null || storedVectors.length === 0) {
      return EMPTY_SUPPLEMENT_RESULT;
    }

    const initialSnapshot = params.preparedQuery.getSnapshot();
    const snapshot = initialSnapshot.status === "pending" && typeof params.preparedQuery.waitForSnapshot === "function"
      ? await params.preparedQuery.waitForSnapshot(this.queryTimeoutMs)
      : initialSnapshot;
    if (snapshot.status === "pending") {
      await this.recordDegraded({
        workspaceId: params.workspaceId,
        runId: params.runId,
        queryId: params.preparedQuery.queryId,
        reason: "query_embedding_pending",
        baseCandidateCount: params.baseCandidateIds.length,
        fallbackCandidateCount: params.baseCandidateIds.length
      });
      return EMPTY_SUPPLEMENT_RESULT;
    }

    if (snapshot.status !== "ready") {
      if (snapshot.status === "failed") {
        this.warn("embedding supplement degraded", {
          workspace_id: params.workspaceId,
          run_id: params.runId,
          reason: snapshot.reason,
          error_name: snapshot.error_name,
          error: snapshot.error_message ?? snapshot.reason
        });
      }
      await this.recordDegraded({
        workspaceId: params.workspaceId,
        runId: params.runId,
        queryId: params.preparedQuery.queryId,
        reason: snapshot.reason,
        baseCandidateCount: params.baseCandidateIds.length,
        fallbackCandidateCount: params.baseCandidateIds.length
      });
      return EMPTY_SUPPLEMENT_RESULT;
    }

    return await this.buildSupplementFromQueryEmbedding({
      workspaceId: params.workspaceId,
      runId: params.runId,
      queryId: params.preparedQuery.queryId,
      queryEmbedding: snapshot.embedding,
      storedVectors,
      eligibleMemories: params.eligibleMemories,
      baseCandidateIds: params.baseCandidateIds,
      maxSupplement: params.maxSupplement
    });
  }

  /**
   * Rank every stored workspace vector by cosine similarity against the query
   * and return the top-K neighbors. Unlike {@link querySupplement}, this is
   * not constrained to a caller-supplied eligible set: it is the embedding-on
   * coarse-injection path that surfaces memories lexical recall never admitted.
   * Vectors are filtered to the active provider + model + schema so cosine
   * comparison stays within one embedding space.
   */
  public async collectWorkspaceNeighbors(params: {
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly queryText: string;
    readonly excludeObjectIds: readonly string[];
    readonly maxNeighbors: number;
  }): Promise<readonly Readonly<EmbeddingNeighborHit>[]> {
    return (await this.collectWorkspaceNeighborsWithMetadata(params)).hits;
  }

  public async collectWorkspaceNeighborsWithMetadata(params: {
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly queryText: string;
    readonly excludeObjectIds: readonly string[];
    readonly maxNeighbors: number;
  }): Promise<Readonly<EmbeddingWorkspaceNeighborResult>> {
    if (
      params.maxNeighbors <= 0 ||
      !this.dependencies.provider.isAvailable ||
      typeof this.dependencies.embeddingRepo.listByWorkspace !== "function"
    ) {
      return emptyWorkspaceNeighborResult();
    }

    let storedVectors: readonly Readonly<EmbeddingVectorRecord>[];
    try {
      // invariant: the tier whitelist (default HOT+WARM, env-configurable) bounds
      // which vectors the coarse-injection scan considers. Cap the scan so a
      // workspace with very many vectors does not pay a worst-case
      // O(workspace_size) cost per recall.
      // invariant: SQL-side provider+model isolation keeps the cap populated
      // with cosine-comparable rows for the active provider only — without it
      // a workspace that has switched providers would burn the cap on
      // unusable vectors before the JS-side filter could drop them.
      // see also: packages/core/src/embedding-recall/tier-config.ts:resolveEmbeddingRecallTiers.
      const scanCap = resolveEmbeddingWorkspaceScanCap();
      // Fetch one past the cap so a truncated scan (more vectors than the cap)
      // is observable instead of silently dropping gold by object_id order.
      const scanned = await this.dependencies.embeddingRepo.listByWorkspace(
        params.workspaceId,
        {
          tierFilter: resolveEmbeddingRecallTiers(),
          limit: scanCap + 1,
          providerKind: this.dependencies.provider.providerKind,
          modelId: this.dependencies.provider.modelId
        }
      );
      if (scanned.length > scanCap) {
        this.warn("embedding workspace scan truncated by cap", {
          workspace_id: params.workspaceId,
          run_id: params.runId,
          scan_cap: scanCap,
          returned: scanned.length
        });
      }
      storedVectors = scanned.length > scanCap ? scanned.slice(0, scanCap) : scanned;
    } catch (error) {
      this.warn("embedding workspace neighbor scan failed", {
        workspace_id: params.workspaceId,
        run_id: params.runId,
        reason: "local_vector_lookup_failed",
        error: toErrorMessage(error)
      });
      return emptyWorkspaceNeighborResult();
    }
    if (storedVectors.length === 0) {
      return emptyWorkspaceNeighborResult();
    }

    let queryEmbedding: Float32Array;
    let queryEmbeddingCacheHit = true;
    let embeddingInferenceCalls = 0;
    try {
      const preparedQuery = this.prepareQueryEmbedding({
        workspaceId: params.workspaceId,
        runId: params.runId,
        queryText: params.queryText
      });
      queryEmbeddingCacheHit = preparedQuery.cacheHit;
      const initialSnapshot = preparedQuery.getSnapshot();
      const snapshot =
        initialSnapshot.status === "pending" && typeof preparedQuery.waitForSnapshot === "function"
          ? await preparedQuery.waitForSnapshot(this.queryTimeoutMs)
          : initialSnapshot;
      if (snapshot.status !== "ready") {
        if (snapshot.status === "failed") {
          throw new Error(snapshot.error_message ?? snapshot.reason);
        }
        throw new Error("query_embedding_pending");
      }
      queryEmbedding = snapshot.embedding;
      embeddingInferenceCalls = preparedQuery.cacheHit ? 0 : 1;
    } catch (error) {
      this.warn("embedding workspace neighbor scan failed", {
        workspace_id: params.workspaceId,
        run_id: params.runId,
        reason: "query_embedding_failed",
        error: toErrorMessage(error)
      });
      return Object.freeze({
        hits: Object.freeze([]) as readonly Readonly<EmbeddingNeighborHit>[],
        embedding_inference_calls: 0,
        query_embedding_cache_hit: queryEmbeddingCacheHit
      });
    }

    const excluded = new Set(params.excludeObjectIds);
    const hits = storedVectors
      .filter(
        (record) =>
          !excluded.has(record.object_id) &&
          record.provider_kind === this.dependencies.provider.providerKind &&
          record.model_id === this.dependencies.provider.modelId &&
          record.schema_version === this.dependencies.provider.schemaVersion &&
          record.dimensions === queryEmbedding.length
      )
      .flatMap((record) => {
        const normalizedSimilarity = clamp01(cosineSimilarity(queryEmbedding, record.embedding));
        if (normalizedSimilarity <= 0) {
          return [];
        }
        return [
          Object.freeze({
            object_id: record.object_id,
            normalized_similarity: normalizedSimilarity
          })
        ];
      })
      .sort((left, right) => {
        const delta = right.normalized_similarity - left.normalized_similarity;
        return delta !== 0 ? delta : left.object_id.localeCompare(right.object_id);
      })
      .slice(0, params.maxNeighbors);

    return Object.freeze({
      hits: Object.freeze(hits),
      embedding_inference_calls: embeddingInferenceCalls,
      query_embedding_cache_hit: queryEmbeddingCacheHit
    });
  }

  private async loadStoredVectors(params: {
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly queryId: string;
    readonly eligibleMemories: readonly Readonly<MemoryEntry>[];
    readonly baseCandidateCount: number;
  }): Promise<readonly Readonly<EmbeddingVectorRecord>[] | null> {
    try {
      return await this.dependencies.embeddingRepo.listByObjectIds(
        params.workspaceId,
        params.eligibleMemories.map((memory) => memory.object_id)
      );
    } catch (error) {
      const message = toErrorMessage(error);
      this.warn("embedding supplement degraded", {
        workspace_id: params.workspaceId,
        run_id: params.runId,
        reason: "local_vector_lookup_failed",
        error: message
      });
      await this.recordDegraded({
        workspaceId: params.workspaceId,
        runId: params.runId,
        queryId: params.queryId,
        reason: "local_vector_lookup_failed",
        baseCandidateCount: params.baseCandidateCount,
        fallbackCandidateCount: params.baseCandidateCount
      });
      return null;
    }
  }

  private async resolveQueryEmbeddingNow(params: {
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly queryId: string;
    readonly queryText: string;
    readonly baseCandidateCount: number;
  }): Promise<Float32Array | null> {
    try {
      const embeddings = await this.dependencies.provider.embedTexts([params.queryText], {
        timeoutMs: this.queryTimeoutMs
      });
      if (embeddings.length !== 1) {
        throw new Error(`Expected exactly one query embedding, received ${embeddings.length}.`);
      }

      return new Float32Array(embeddings[0]!);
    } catch (error) {
      const message = toErrorMessage(error);
      this.warn("embedding supplement degraded", {
        workspace_id: params.workspaceId,
        run_id: params.runId,
        reason: "query_embedding_failed",
        error: message
      });
      await this.recordDegraded({
        workspaceId: params.workspaceId,
        runId: params.runId,
        queryId: params.queryId,
        reason: "query_embedding_failed",
        baseCandidateCount: params.baseCandidateCount,
        fallbackCandidateCount: params.baseCandidateCount
      });
      return null;
    }
  }

  private async buildSupplementFromQueryEmbedding(params: {
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly queryId: string;
    readonly queryEmbedding: Float32Array;
    readonly storedVectors: readonly Readonly<EmbeddingVectorRecord>[];
    readonly eligibleMemories: readonly Readonly<MemoryEntry>[];
    readonly baseCandidateIds: readonly string[];
    readonly maxSupplement: number;
  }): Promise<EmbeddingRecallSupplementResult> {
    const startedAtEpochMs = Date.now();
    const eligibleMemoryMap = new Map(
      params.eligibleMemories.map((memory) => [memory.object_id, memory] as const)
    );
    const hints = params.storedVectors
      .filter(
        (record) =>
          record.provider_kind === this.dependencies.provider.providerKind &&
          record.model_id === this.dependencies.provider.modelId &&
          record.schema_version === this.dependencies.provider.schemaVersion &&
          record.dimensions === params.queryEmbedding.length
      )
      .flatMap((record) => {
        const memory = eligibleMemoryMap.get(record.object_id);
        if (memory === undefined) {
          return [];
        }

        if (record.content_hash !== hashMemoryContent(memory.content)) {
          return [];
        }

        const normalizedSimilarity = clamp01(
          cosineSimilarity(params.queryEmbedding, record.embedding)
        );
        if (normalizedSimilarity <= 0) {
          return [];
        }

        return [
          Object.freeze({
            object_id: record.object_id,
            normalized_similarity: normalizedSimilarity
          })
        ];
      })
      .sort((left, right) => {
        const similarityDelta = right.normalized_similarity - left.normalized_similarity;
        if (similarityDelta !== 0) {
          return similarityDelta;
        }

        return left.object_id.localeCompare(right.object_id);
      });

    const latencyMs = Math.max(0, Date.now() - startedAtEpochMs);
    await this.appendTelemetrySafely({
      stage: "queried",
      workspaceId: params.workspaceId,
      runId: params.runId,
      queryId: params.queryId,
      entry: {
        event_type: ComputeRecallGardenEventType.RECALL_EMBEDDING_SUPPLEMENT_QUERIED,
        entity_type: "recall_embedding_supplement",
        entity_id: params.queryId,
        workspace_id: params.workspaceId,
        run_id: params.runId,
        caused_by: "system",
        payload_json: RecallEmbeddingSupplementQueriedPayloadSchema.parse({
          workspace_id: params.workspaceId,
          run_id: params.runId,
          query_id: params.queryId,
          requested_limit: params.maxSupplement,
          returned_candidate_count: hints.length,
          latency_ms: latencyMs,
          queried_at: this.now()
        })
      }
    });

    const baseCandidateIdSet = new Set(params.baseCandidateIds);
    const supplementaryEntries = hints
      .filter((hint) => !baseCandidateIdSet.has(hint.object_id))
      .slice(0, params.maxSupplement)
      .flatMap((hint) => {
        const memory = eligibleMemoryMap.get(hint.object_id);
        return memory === undefined ? [] : [memory];
      });

    await this.appendTelemetrySafely({
      stage: "merged",
      workspaceId: params.workspaceId,
      runId: params.runId,
      queryId: params.queryId,
      entry: {
        event_type: ComputeRecallGardenEventType.RECALL_EMBEDDING_SUPPLEMENT_MERGED,
        entity_type: "recall_embedding_supplement",
        entity_id: params.queryId,
        workspace_id: params.workspaceId,
        run_id: params.runId,
        caused_by: "system",
        payload_json: RecallEmbeddingSupplementMergedPayloadSchema.parse({
          workspace_id: params.workspaceId,
          run_id: params.runId,
          query_id: params.queryId,
          base_candidate_count: params.baseCandidateIds.length,
          supplement_candidate_count: supplementaryEntries.length,
          merged_candidate_count: params.baseCandidateIds.length + supplementaryEntries.length,
          merged_at: this.now()
        })
      }
    });

    return Object.freeze({
      supplementaryEntries: Object.freeze([...supplementaryEntries]),
      similarityHintsByObjectId: Object.freeze(
        Object.fromEntries(hints.map((hint) => [hint.object_id, hint] as const))
      )
    });
  }

  private async recordDegraded(params: {
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly queryId: string;
    readonly reason: string;
    readonly baseCandidateCount: number;
    readonly fallbackCandidateCount: number;
  }): Promise<void> {
    try {
      await this.dependencies.eventLogRepo.append({
        event_type: ComputeRecallGardenEventType.RECALL_EMBEDDING_SUPPLEMENT_DEGRADED,
        entity_type: "recall_embedding_supplement",
        entity_id: params.queryId,
        workspace_id: params.workspaceId,
        run_id: params.runId,
        caused_by: "system",
        payload_json: RecallEmbeddingSupplementDegradedPayloadSchema.parse({
          workspace_id: params.workspaceId,
          run_id: params.runId,
          query_id: params.queryId,
          degradation_reason: params.reason,
          base_candidate_count: params.baseCandidateCount,
          fallback_candidate_count: params.fallbackCandidateCount,
          degraded_at: this.now()
        })
      });
    } catch (error) {
      this.warn("embedding supplement degraded telemetry failed", {
        workspace_id: params.workspaceId,
        run_id: params.runId,
        query_id: params.queryId,
        stage: "event_log",
        error: toErrorMessage(error)
      });
    }

    try {
      await this.dependencies.healthJournalRecorder?.record({
        event_kind: HealthEventKind.EMBEDDING_SUPPLEMENT,
        workspace_id: params.workspaceId,
        run_id: params.runId,
        summary: "Embedding supplement degraded to keyword-only recall.",
        detail_json: {
          query_id: params.queryId,
          reason: params.reason,
          base_candidate_count: params.baseCandidateCount,
          fallback_candidate_count: params.fallbackCandidateCount,
          provider_kind: this.dependencies.provider.providerKind,
          model_id: this.dependencies.provider.modelId,
          embedding_enabled: this.dependencies.provider.isAvailable
        }
      });
    } catch (error) {
      this.warn("embedding supplement degraded telemetry failed", {
        workspace_id: params.workspaceId,
        run_id: params.runId,
        query_id: params.queryId,
        stage: "health_journal",
        error: toErrorMessage(error)
      });
    }
  }

  private async appendTelemetrySafely(params: {
    readonly stage: "queried" | "merged";
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly queryId: string;
    readonly entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">;
  }): Promise<void> {
    try {
      await this.dependencies.eventLogRepo.append(params.entry);
    } catch (error) {
      this.warn("embedding supplement telemetry failed", {
        workspace_id: params.workspaceId,
        run_id: params.runId,
        query_id: params.queryId,
        stage: params.stage,
        error: toErrorMessage(error)
      });
    }
  }
}
