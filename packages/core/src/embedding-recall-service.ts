import { createHash, randomUUID } from "node:crypto";
import {
  HealthEventKind,
  ComputeRecallGardenEventType,
  RecallEmbeddingSupplementDegradedPayloadSchema,
  RecallEmbeddingSupplementMergedPayloadSchema,
  RecallEmbeddingSupplementQueriedPayloadSchema,
  type EventLogEntry,
  type HealthJournalRecordPort,
  type MemoryEntry
} from "@do-soul/alaya-protocol";

export interface EmbeddingVectorRecord {
  readonly object_id: string;
  readonly workspace_id: string;
  readonly content_hash: string;
  readonly provider_kind: string;
  readonly model_id: string;
  readonly schema_version: number;
  readonly dimensions: number;
  readonly embedding: Float32Array;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface EmbeddingProviderPort {
  readonly providerKind: string;
  readonly modelId: string;
  readonly schemaVersion: number;
  readonly isAvailable: boolean;
  embedTexts(
    texts: readonly string[],
    options: {
      readonly timeoutMs: number;
    }
  ): Promise<readonly Float32Array[]>;
}

export interface EmbeddingRecallRepoPort {
  listByObjectIds(
    workspaceId: string,
    objectIds: readonly string[]
  ): Promise<readonly Readonly<EmbeddingVectorRecord>[]>;
  // Optional: full workspace vector scan, used by the embedding-on coarse
  // injection path to find semantically near memories that lexical recall
  // never admitted into the candidate pool. The optional `tierFilter` admits
  // only memories at the requested storage tier (HOT by default in the recall
  // hot path; WARM / COLD stay out of the embedding candidate pool, matching
  // the cascade design). `limit` caps the scan so a workspace with millions
  // of memories does not pay an O(workspace_size) cost per recall.
  listByWorkspace?(
    workspaceId: string,
    options?: EmbeddingWorkspaceScanOptions
  ): Promise<readonly Readonly<EmbeddingVectorRecord>[]>;
}

export interface EmbeddingWorkspaceScanOptions {
  // Optional storage-tier whitelist. When set, callers receive only embeddings
  // whose backing memory_entry sits in one of the listed tiers.
  readonly tierFilter?: readonly ("hot" | "warm" | "cold")[];
  // Hard cap on the number of records returned. Applied after tier filtering.
  readonly limit?: number;
  // invariant: cosine space is valid only within one (provider_kind, model_id);
  // SQL-side restriction prevents the scan cap from being consumed by vectors
  // the JS-side filter would discard.
  readonly providerKind?: string;
  readonly modelId?: string;
}

export interface EmbeddingNeighborHit {
  readonly object_id: string;
  readonly normalized_similarity: number;
}

export interface EmbeddingRecallEventLogPort {
  append(entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">): EventLogEntry | Promise<EventLogEntry>;
  queryByEntity(entityType: string, entityId: string): Promise<readonly EventLogEntry[]>;
}

export interface EmbeddingSimilarityHint {
  readonly object_id: string;
  readonly normalized_similarity: number;
}

export interface EmbeddingRecallSupplementResult {
  readonly supplementaryEntries: readonly Readonly<MemoryEntry>[];
  readonly similarityHintsByObjectId: Readonly<Record<string, Readonly<EmbeddingSimilarityHint>>>;
}

export interface EmbeddingRecallServiceDependencies {
  readonly embeddingRepo: EmbeddingRecallRepoPort;
  readonly provider: EmbeddingProviderPort;
  readonly eventLogRepo: EmbeddingRecallEventLogPort;
  readonly healthJournalRecorder?: HealthJournalRecordPort;
  readonly generateQueryId?: () => string;
  readonly now?: () => string;
  readonly warn?: (message: string, meta: Record<string, unknown>) => void;
  /**
   * Per-query embedding provider timeout for the recall prefetch / supplement
   * paths. Defaults to {@link DEFAULT_QUERY_TIMEOUT_MS}. The default of 250 ms
   * was empirically too tight (long-run test 2026-05-08 observed 100% of
   * queries finishing as `query_embedding_pending`); 2500 ms gives OpenAI /
   * compatible providers room to land within the recall window while still bounded.
   */
  readonly queryTimeoutMs?: number;
  readonly queryEmbeddingCacheSize?: number;
}

export type PreparedEmbeddingQuerySnapshot =
  | {
      readonly status: "pending";
    }
  | {
      readonly status: "ready";
      readonly embedding: Float32Array;
    }
  | {
      readonly status: "failed";
      readonly reason: string;
    };

export interface PreparedEmbeddingQueryHandle {
  readonly queryId: string;
  getSnapshot(): PreparedEmbeddingQuerySnapshot;
  waitForSnapshot?(timeoutMs: number): Promise<PreparedEmbeddingQuerySnapshot>;
}

export interface PreparedEmbeddingSupplement {
  readonly preparedQuery: PreparedEmbeddingQueryHandle | null;
  readonly storedVectors: readonly Readonly<EmbeddingVectorRecord>[];
  readonly degradedReason: string | null;
}

export interface EmbeddingQueryWarmupSummary {
  readonly status: "not_requested" | "ready";
  readonly requested_count: number;
  readonly ready_count: number;
  readonly cache_hit_count: number;
  readonly provider_requested_count: number;
  readonly missing_count: number;
  readonly provider_kind: string | null;
  readonly model_id: string | null;
  readonly last_error?: string;
}

interface EmbeddingRecallPrecheckError extends Error {
  readonly reason: "local_vector_lookup_failed";
}

export const DEFAULT_QUERY_TIMEOUT_MS = 2500;
export const MAX_QUERY_TIMEOUT_MS = 5000;
export const MIN_QUERY_TIMEOUT_MS = 50;
const DEFAULT_QUERY_EMBEDDING_CACHE_SIZE = 512;
const MAX_QUERY_EMBEDDING_CACHE_SIZE = 4096;
const DEFAULT_EMBEDDING_REQUEST_MAX_ATTEMPTS = 5;
const MAX_EMBEDDING_REQUEST_ATTEMPTS = 5;
const DEFAULT_EMBEDDING_REQUEST_RETRY_DELAY_MS = 250;
const MAX_EMBEDDING_REQUEST_RETRY_DELAY_MS = 2_000;
const QUERY_EMBEDDING_WARMUP_BATCH_SIZE = 16;
// Hard cap on the workspace neighbor scan. The recall path drives this every
// query; without a cap the cost grows linearly with HOT memory count. Tuned
// large enough that benches keep deterministic coverage and small enough that
// the per-recall O(scan) cost stays bounded.
export const EMBEDDING_WORKSPACE_SCAN_CAP = 5_000;

function clampQueryTimeout(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_QUERY_TIMEOUT_MS;
  }
  return Math.min(MAX_QUERY_TIMEOUT_MS, Math.max(MIN_QUERY_TIMEOUT_MS, value));
}

function clampQueryEmbeddingCacheSize(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return DEFAULT_QUERY_EMBEDDING_CACHE_SIZE;
  }
  return Math.min(MAX_QUERY_EMBEDDING_CACHE_SIZE, Math.floor(value));
}

function clampEmbeddingRequestAttempts(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_EMBEDDING_REQUEST_MAX_ATTEMPTS;
  }
  return Math.min(MAX_EMBEDDING_REQUEST_ATTEMPTS, Math.max(1, Math.floor(value)));
}

function clampEmbeddingRequestRetryDelayMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return DEFAULT_EMBEDDING_REQUEST_RETRY_DELAY_MS;
  }
  return Math.min(MAX_EMBEDDING_REQUEST_RETRY_DELAY_MS, Math.floor(value));
}

const EMPTY_SUPPLEMENT_RESULT: EmbeddingRecallSupplementResult = Object.freeze({
  supplementaryEntries: Object.freeze([]),
  similarityHintsByObjectId: Object.freeze({})
});

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
      return createPreparedEmbeddingQueryHandle(
        queryId,
        Object.freeze({
          status: "failed",
          reason: "provider_unavailable"
        })
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
        })
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
      .catch(() => {
        snapshot = Object.freeze({
          status: "failed",
          reason: "query_embedding_failed"
        });
      });

    return createPreparedEmbeddingQueryHandle(queryId, () => snapshot, async (timeoutMs) => {
      if (snapshot.status !== "pending") {
        return snapshot;
      }

      await waitForPreparedQuery(settled, timeoutMs);
      return snapshot;
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
    if (
      params.maxNeighbors <= 0 ||
      !this.dependencies.provider.isAvailable ||
      typeof this.dependencies.embeddingRepo.listByWorkspace !== "function"
    ) {
      return Object.freeze([]);
    }

    let storedVectors: readonly Readonly<EmbeddingVectorRecord>[];
    try {
      // invariant: WARM / COLD memories sit behind the tier cascade gate; the
      // embedding coarse-injection path must not pre-empt that. Cap the scan
      // so a workspace with very many HOT vectors does not pay a worst-case
      // O(workspace_size) cost per recall. see also: EmbeddingWorkspaceScanOptions.
      // invariant: SQL-side provider+model isolation keeps the cap populated
      // with cosine-comparable rows for the active provider only — without it
      // a workspace that has switched providers would burn the cap on
      // unusable vectors before the JS-side filter could drop them.
      storedVectors = await this.dependencies.embeddingRepo.listByWorkspace(
        params.workspaceId,
        {
          tierFilter: ["hot"],
          limit: EMBEDDING_WORKSPACE_SCAN_CAP,
          providerKind: this.dependencies.provider.providerKind,
          modelId: this.dependencies.provider.modelId
        }
      );
    } catch (error) {
      this.warn("embedding workspace neighbor scan failed", {
        workspace_id: params.workspaceId,
        run_id: params.runId,
        reason: "local_vector_lookup_failed",
        error: toErrorMessage(error)
      });
      return Object.freeze([]);
    }
    if (storedVectors.length === 0) {
      return Object.freeze([]);
    }

    let queryEmbedding: Float32Array;
    try {
      const embeddings = await this.dependencies.provider.embedTexts([params.queryText], {
        timeoutMs: this.queryTimeoutMs
      });
      if (embeddings.length !== 1) {
        throw new Error(`Expected exactly one query embedding, received ${embeddings.length}.`);
      }
      queryEmbedding = new Float32Array(embeddings[0]!);
    } catch (error) {
      this.warn("embedding workspace neighbor scan failed", {
        workspace_id: params.workspaceId,
        run_id: params.runId,
        reason: "query_embedding_failed",
        error: toErrorMessage(error)
      });
      return Object.freeze([]);
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

    return Object.freeze(hits);
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

export interface OpenAIEmbeddingClientOptions {
  readonly apiKey: string | null;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly maxAttempts?: number;
  readonly retryDelayMs?: number;
}

export class OpenAIEmbeddingClient implements EmbeddingProviderPort {
  public readonly providerKind = "openai";
  public readonly modelId: string;
  public readonly schemaVersion = 1;
  public readonly isAvailable: boolean;

  private readonly apiKey: string | null;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;

  public constructor(options: OpenAIEmbeddingClientOptions) {
    this.apiKey = options.apiKey;
    this.modelId = options.model?.trim() || "text-embedding-3-small";
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? "https://api.openai.com/v1");
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.maxAttempts = clampEmbeddingRequestAttempts(options.maxAttempts);
    this.retryDelayMs = clampEmbeddingRequestRetryDelayMs(options.retryDelayMs);
    this.isAvailable = typeof this.apiKey === "string" && this.apiKey.length > 0;
  }

  public async embedTexts(
    texts: readonly string[],
    options: {
      readonly timeoutMs: number;
    }
  ): Promise<readonly Float32Array[]> {
    if (!this.isAvailable) {
      throw new Error("OPENAI_API_KEY is not configured for embeddings.");
    }

    if (texts.length === 0) {
      return Object.freeze([]);
    }

    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => abortController.abort("embedding-timeout"), options.timeoutMs);
    timeoutHandle.unref?.();

    try {
      const response = await this.fetchEmbeddingWithRetry(texts, abortController.signal);

      if (!response.ok) {
        throw new Error(
          `Embedding request failed with status ${response.status} for host ${formatEmbeddingHost(this.baseUrl)}.`
        );
      }

      const payload = (await response.json()) as {
        readonly data?: ReadonlyArray<{
          readonly embedding?: readonly number[];
          readonly index?: number;
        }>;
      };
      const data = [...(payload.data ?? [])].sort(
        (left, right) => (left.index ?? 0) - (right.index ?? 0)
      );

      if (data.length !== texts.length) {
        throw new Error(`Embedding request returned ${data.length} vectors for ${texts.length} inputs.`);
      }

      return Object.freeze(
        data.map((entry, index) => {
          if (!Array.isArray(entry.embedding) || entry.embedding.length === 0) {
            throw new Error(`Embedding response ${index} did not include a valid vector.`);
          }

          return new Float32Array(entry.embedding);
        })
      );
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  private async fetchEmbeddingWithRetry(
    texts: readonly string[],
    signal: AbortSignal
  ): Promise<Response> {
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        const response = await this.fetchImpl(`${this.baseUrl}/embeddings`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.apiKey}`
          },
          body: JSON.stringify({
            model: this.modelId,
            input: texts
          }),
          signal
        });
        if (attempt < this.maxAttempts && isRetryableEmbeddingStatus(response.status)) {
          await sleepEmbeddingRetry(this.retryDelayMs * attempt, signal);
          continue;
        }
        return response;
      } catch (error) {
        if (attempt >= this.maxAttempts || signal.aborted) {
          throw new Error(formatEmbeddingTransportError(this.baseUrl, error));
        }
        await sleepEmbeddingRetry(this.retryDelayMs * attempt, signal);
      }
    }

    throw new Error(`Embedding request retry loop exhausted for host ${formatEmbeddingHost(this.baseUrl)}.`);
  }
}

function isRetryableEmbeddingStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

async function sleepEmbeddingRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (delayMs <= 0 || signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, delayMs);
    timeout.unref?.();
  });
}

function formatEmbeddingTransportError(baseUrl: string, error: unknown): string {
  const causeCode =
    typeof error === "object" &&
    error !== null &&
    "cause" in error &&
    typeof (error as { readonly cause?: { readonly code?: unknown } }).cause?.code === "string"
      ? ` cause=${(error as { readonly cause: { readonly code: string } }).cause.code}`
      : "";
  return `Embedding request transport failed for host ${formatEmbeddingHost(baseUrl)}.${causeCode}`;
}

function formatEmbeddingHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return "unknown";
  }
}

function createPreparedEmbeddingQueryHandle(
  queryId: string,
  snapshotOrGetter:
    | PreparedEmbeddingQuerySnapshot
    | (() => PreparedEmbeddingQuerySnapshot),
  waitForSnapshot?: (timeoutMs: number) => Promise<PreparedEmbeddingQuerySnapshot>
): PreparedEmbeddingQueryHandle {
  return {
    queryId,
    getSnapshot:
      typeof snapshotOrGetter === "function"
        ? snapshotOrGetter
        : () => snapshotOrGetter,
    ...(waitForSnapshot === undefined ? {} : { waitForSnapshot })
  };
}

async function waitForPreparedQuery(settled: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      settled,
      new Promise<void>((resolve) => {
        timeoutHandle = setTimeout(resolve, timeoutMs);
        timeoutHandle.unref?.();
      })
    ]);
  } finally {
    if (timeoutHandle !== null) {
      clearTimeout(timeoutHandle);
    }
  }
}

function normalizeBaseUrl(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function hashMemoryContent(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function cosineSimilarity(left: Float32Array, right: Float32Array): number {
  if (left.length !== right.length || left.length === 0) {
    return 0;
  }

  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;

  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }

  if (leftMagnitude === 0 || rightMagnitude === 0) {
    return 0;
  }

  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.min(1, Math.max(0, value));
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
