import { randomUUID } from "node:crypto";
import { type MemoryEntry } from "@do-soul/alaya-protocol";

import {
  DEFAULT_QUERY_EMBEDDING_CACHE_SIZE,
  DEFAULT_QUERY_TIMEOUT_MS
} from "./constants.js";
import { EmbeddingRecallTelemetry } from "./embedding-recall-telemetry.js";
import {
  EMPTY_SUPPLEMENT_RESULT,
  clampQueryEmbeddingCacheSize,
  clampQueryTimeout,
  toErrorMessage
} from "./helpers.js";
import {
  computeCoherentPairKeys,
  scoreEmbeddingPoolCandidates
} from "./pool-scoring.js";
import { QueryEmbeddingEngine } from "./query-embedding-engine.js";
import { EmbeddingSupplementBuilder } from "./supplement-builder.js";
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
import { WorkspaceNeighborScanner } from "./workspace-neighbor-scanner.js";

interface EmbeddingRecallPrecheckError extends Error {
  readonly reason: "local_vector_lookup_failed";
}

export class EmbeddingRecallService {
  public readonly generateQueryId: () => string;

  public readonly now: () => string;

  public readonly warn: (message: string, meta: Record<string, unknown>) => void;

  public readonly queryTimeoutMs: number;

  public readonly queryEmbeddingCacheSize: number;

  private readonly queryEngine: QueryEmbeddingEngine;

  private readonly telemetry: EmbeddingRecallTelemetry;

  private readonly supplementBuilder: EmbeddingSupplementBuilder;

  private readonly workspaceScanner: WorkspaceNeighborScanner;

  public constructor(public readonly dependencies: EmbeddingRecallServiceDependencies) {
    this.generateQueryId = dependencies.generateQueryId ?? (() => `recall-embedding-${randomUUID()}`);
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.warn = dependencies.warn ?? (() => undefined);
    this.queryTimeoutMs = clampQueryTimeout(dependencies.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS);
    this.queryEmbeddingCacheSize = clampQueryEmbeddingCacheSize(
      dependencies.queryEmbeddingCacheSize ?? DEFAULT_QUERY_EMBEDDING_CACHE_SIZE
    );
    this.queryEngine = new QueryEmbeddingEngine({
      provider: dependencies.provider,
      generateQueryId: this.generateQueryId,
      queryTimeoutMs: this.queryTimeoutMs,
      queryEmbeddingCacheSize: this.queryEmbeddingCacheSize
    });
    this.telemetry = new EmbeddingRecallTelemetry({
      eventLogRepo: dependencies.eventLogRepo,
      healthJournalRecorder: dependencies.healthJournalRecorder,
      provider: dependencies.provider,
      now: this.now,
      warn: this.warn
    });
    this.supplementBuilder = new EmbeddingSupplementBuilder({
      provider: dependencies.provider,
      now: this.now,
      telemetry: this.telemetry
    });
    this.workspaceScanner = new WorkspaceNeighborScanner({
      provider: dependencies.provider,
      embeddingRepo: dependencies.embeddingRepo,
      queryEngine: this.queryEngine,
      queryTimeoutMs: this.queryTimeoutMs,
      warn: this.warn
    });
  }

  public prepareQueryEmbedding(params: {
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly queryText: string;
  }): PreparedEmbeddingQueryHandle {
    return this.queryEngine.prepareQueryEmbedding(params);
  }

  public async warmQueryEmbeddings(params: {
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly queryTexts: readonly string[];
  }): Promise<EmbeddingQueryWarmupSummary> {
    return this.queryEngine.warmQueryEmbeddings(params);
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
      await this.telemetry.recordDegraded({
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

    return computeCoherentPairKeys(storedVectors, params.objectIds, params.floor, this.dependencies.provider);
  }

  // cosine(query, stored-vector) for already-pooled candidates (inverse of injection,
  // which excludes them). Provider-matched per (kind, model, schema); returns sim>0 only.
  public async scorePoolCandidates(params: {
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly queryText: string;
    readonly objectIds: readonly string[];
  }): Promise<ReadonlyMap<string, number>> {
    return await scoreEmbeddingPoolCandidates({
      ...params,
      embeddingRepo: this.dependencies.embeddingRepo,
      provider: this.dependencies.provider,
      queryEngine: this.queryEngine,
      queryTimeoutMs: this.queryTimeoutMs,
      warn: this.warn
    });
  }

  public async recordPrecheckDegraded(params: {
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly reason: string;
    readonly baseCandidateCount: number;
    readonly fallbackCandidateCount: number;
  }): Promise<void> {
    await this.telemetry.recordDegraded({
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
      await this.telemetry.recordDegraded({
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

    return await this.supplementBuilder.buildSupplementFromQueryEmbedding({
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
      await this.telemetry.recordDegraded({
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
      await this.telemetry.recordDegraded({
        workspaceId: params.workspaceId,
        runId: params.runId,
        queryId: params.preparedQuery.queryId,
        reason: snapshot.reason,
        baseCandidateCount: params.baseCandidateIds.length,
        fallbackCandidateCount: params.baseCandidateIds.length
      });
      return EMPTY_SUPPLEMENT_RESULT;
    }

    return await this.supplementBuilder.buildSupplementFromQueryEmbedding({
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
    return this.workspaceScanner.collectWorkspaceNeighborsWithMetadata(params);
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
      await this.telemetry.recordDegraded({
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
      return await this.queryEngine.resolveQueryEmbeddingNow(params.queryText);
    } catch (error) {
      const message = toErrorMessage(error);
      this.warn("embedding supplement degraded", {
        workspace_id: params.workspaceId,
        run_id: params.runId,
        reason: "query_embedding_failed",
        error: message
      });
      await this.telemetry.recordDegraded({
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
}
