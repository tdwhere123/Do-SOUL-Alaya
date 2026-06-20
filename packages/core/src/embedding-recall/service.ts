import { randomUUID } from "node:crypto";
import {
  type EventLogEntry,
  type MemoryEntry
} from "@do-soul/alaya-protocol";
import {
  DEFAULT_QUERY_EMBEDDING_CACHE_SIZE,
  DEFAULT_QUERY_TIMEOUT_MS} from "./constants.js";
import {
  clampQueryEmbeddingCacheSize,
  clampQueryTimeout} from "./helpers.js";
import type {
  EmbeddingNeighborHit,
  EmbeddingQueryWarmupSummary,
  EmbeddingRecallServiceDependencies,
  EmbeddingRecallSupplementResult,
  EmbeddingVectorRecord,
  EmbeddingWorkspaceNeighborResult,
  PreparedEmbeddingQueryHandle,
  PreparedEmbeddingSupplement
} from "./types.js";

import { embeddingRecallServicePrepareQueryEmbedding, embeddingRecallServiceWarmQueryEmbeddings, embeddingRecallServiceHasStoredVectors, embeddingRecallServicePrepareQuerySupplement, embeddingRecallServiceCoherentPairKeys, embeddingRecallServiceQueryCacheKey, embeddingRecallServiceGetCachedQueryEmbedding, embeddingRecallServicePutCachedQueryEmbedding, embeddingRecallServiceRecordPrecheckDegraded, embeddingRecallServiceQuerySupplement } from "./service-methods-1.js";
import { embeddingRecallServiceQuerySupplementIfReady, embeddingRecallServiceCollectWorkspaceNeighbors, embeddingRecallServiceCollectWorkspaceNeighborsWithMetadata, embeddingRecallServiceLoadStoredVectors, embeddingRecallServiceResolveQueryEmbeddingNow } from "./service-methods-2.js";
import { embeddingRecallServiceBuildSupplementFromQueryEmbedding, embeddingRecallServiceRecordDegraded, embeddingRecallServiceAppendTelemetrySafely } from "./service-methods-3.js";

interface EmbeddingRecallPrecheckError extends Error {
  readonly reason: "local_vector_lookup_failed";
}

export class EmbeddingRecallService {
public readonly generateQueryId: () => string;

public readonly now: () => string;

public readonly warn: (message: string, meta: Record<string, unknown>) => void;

public readonly queryTimeoutMs: number;

public readonly queryEmbeddingCacheSize: number;

public readonly queryEmbeddingCache = new Map<string, Float32Array>();

public constructor(public readonly dependencies: EmbeddingRecallServiceDependencies) {
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
    return embeddingRecallServicePrepareQueryEmbedding(this, params);
  }

  public async warmQueryEmbeddings(params: {
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly queryTexts: readonly string[];
  }): Promise<EmbeddingQueryWarmupSummary> {
    return embeddingRecallServiceWarmQueryEmbeddings(this, params);
  }

  public async hasStoredVectors(params: {
    readonly workspaceId: string;
    readonly eligibleMemories: readonly Readonly<MemoryEntry>[];
  }): Promise<boolean> {
    return embeddingRecallServiceHasStoredVectors(this, params);
  }

  public async prepareQuerySupplement(params: {
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly queryText: string;
    readonly eligibleMemories: readonly Readonly<MemoryEntry>[];
    readonly baseCandidateCount: number;
  }): Promise<PreparedEmbeddingSupplement> {
    return embeddingRecallServicePrepareQuerySupplement(this, params);
  }

  public async coherentPairKeys(params: {
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly objectIds: readonly string[];
    readonly floor: number;
  }): Promise<ReadonlySet<string>> {
    return embeddingRecallServiceCoherentPairKeys(this, params);
  }

  private queryCacheKey(queryText: string): string {
    return embeddingRecallServiceQueryCacheKey(this, queryText);
  }

  private getCachedQueryEmbedding(cacheKey: string): Float32Array | null {
    return embeddingRecallServiceGetCachedQueryEmbedding(this, cacheKey);
  }

  private putCachedQueryEmbedding(cacheKey: string, embedding: Float32Array): void {
    return embeddingRecallServicePutCachedQueryEmbedding(this, cacheKey, embedding);
  }

  public async recordPrecheckDegraded(params: {
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly reason: string;
    readonly baseCandidateCount: number;
    readonly fallbackCandidateCount: number;
  }): Promise<void> {
    return embeddingRecallServiceRecordPrecheckDegraded(this, params);
  }

  public async querySupplement(params: {
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly queryText: string;
    readonly eligibleMemories: readonly Readonly<MemoryEntry>[];
    readonly baseCandidateIds: readonly string[];
    readonly maxSupplement: number;
  }): Promise<EmbeddingRecallSupplementResult> {
    return embeddingRecallServiceQuerySupplement(this, params);
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
    return embeddingRecallServiceQuerySupplementIfReady(this, params);
  }

  public async collectWorkspaceNeighbors(params: {
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly queryText: string;
    readonly excludeObjectIds: readonly string[];
    readonly maxNeighbors: number;
  }): Promise<readonly Readonly<EmbeddingNeighborHit>[]> {
    return embeddingRecallServiceCollectWorkspaceNeighbors(this, params);
  }

  public async collectWorkspaceNeighborsWithMetadata(params: {
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly queryText: string;
    readonly excludeObjectIds: readonly string[];
    readonly maxNeighbors: number;
  }): Promise<Readonly<EmbeddingWorkspaceNeighborResult>> {
    return embeddingRecallServiceCollectWorkspaceNeighborsWithMetadata(this, params);
  }

  private async loadStoredVectors(params: {
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly queryId: string;
    readonly eligibleMemories: readonly Readonly<MemoryEntry>[];
    readonly baseCandidateCount: number;
  }): Promise<readonly Readonly<EmbeddingVectorRecord>[] | null> {
    return embeddingRecallServiceLoadStoredVectors(this, params);
  }

  private async resolveQueryEmbeddingNow(params: {
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly queryId: string;
    readonly queryText: string;
    readonly baseCandidateCount: number;
  }): Promise<Float32Array | null> {
    return embeddingRecallServiceResolveQueryEmbeddingNow(this, params);
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
    return embeddingRecallServiceBuildSupplementFromQueryEmbedding(this, params);
  }

  private async recordDegraded(params: {
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly queryId: string;
    readonly reason: string;
    readonly baseCandidateCount: number;
    readonly fallbackCandidateCount: number;
  }): Promise<void> {
    return embeddingRecallServiceRecordDegraded(this, params);
  }

  private async appendTelemetrySafely(params: {
    readonly stage: "queried" | "merged";
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly queryId: string;
    readonly entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">;
  }): Promise<void> {
    return embeddingRecallServiceAppendTelemetrySafely(this, params);
  }
}
