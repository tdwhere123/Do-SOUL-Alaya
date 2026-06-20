
import {
  type MemoryEntry
} from "@do-soul/alaya-protocol";

import {
  resolveEmbeddingWorkspaceScanCap
} from "./constants.js";

import { resolveEmbeddingRecallTiers } from "./tier-config.js";

import {
  EMPTY_SUPPLEMENT_RESULT,
  clamp01,
  cosineSimilarity,
  emptyWorkspaceNeighborResult,
  toErrorMessage} from "./helpers.js";

import type {
  EmbeddingNeighborHit,
  EmbeddingRecallServiceDependencies,
  EmbeddingRecallSupplementResult,
  EmbeddingVectorRecord,
  EmbeddingWorkspaceNeighborResult,
  PreparedEmbeddingQueryHandle,
  PreparedEmbeddingQuerySnapshot} from "./types.js";
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

interface WorkspaceNeighborParams {
  readonly workspaceId: string;
  readonly runId: string | null;
  readonly queryText: string;
  readonly excludeObjectIds: readonly string[];
  readonly maxNeighbors: number;
}

interface WorkspaceVectorScan {
  readonly storedVectors: readonly Readonly<EmbeddingVectorRecord>[];
  readonly workspaceScanCap: number;
  readonly workspaceScannedCount: number;
  readonly workspaceScanTruncated: boolean;
}

interface WorkspaceQueryEmbeddingResolution {
  readonly queryEmbedding: Float32Array | null;
  readonly queryEmbeddingCacheHit: boolean;
  readonly embeddingInferenceCalls: number;
  readonly queryEmbeddingStatus: NonNullable<EmbeddingWorkspaceNeighborResult["query_embedding_status"]>;
  readonly queryEmbeddingDegradationReason: string | null;
  readonly queryEmbeddingError: string | null;
}

export async function embeddingRecallServiceQuerySupplementIfReady(owner: EmbeddingRecallServiceMethodOwner, params: {
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
      await owner.loadStoredVectors({
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
      ? await params.preparedQuery.waitForSnapshot(owner.queryTimeoutMs)
      : initialSnapshot;
    if (snapshot.status === "pending") {
      await owner.recordDegraded({
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
        owner.warn("embedding supplement degraded", {
          workspace_id: params.workspaceId,
          run_id: params.runId,
          reason: snapshot.reason,
          error_name: snapshot.error_name,
          error: snapshot.error_message ?? snapshot.reason
        });
      }
      await owner.recordDegraded({
        workspaceId: params.workspaceId,
        runId: params.runId,
        queryId: params.preparedQuery.queryId,
        reason: snapshot.reason,
        baseCandidateCount: params.baseCandidateIds.length,
        fallbackCandidateCount: params.baseCandidateIds.length
      });
      return EMPTY_SUPPLEMENT_RESULT;
    }

    return await owner.buildSupplementFromQueryEmbedding({
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

export async function embeddingRecallServiceCollectWorkspaceNeighbors(owner: EmbeddingRecallServiceMethodOwner, params: WorkspaceNeighborParams): Promise<readonly Readonly<EmbeddingNeighborHit>[]> {
    return (await owner.collectWorkspaceNeighborsWithMetadata(params)).hits;
  }

export async function embeddingRecallServiceCollectWorkspaceNeighborsWithMetadata(owner: EmbeddingRecallServiceMethodOwner, params: WorkspaceNeighborParams): Promise<Readonly<EmbeddingWorkspaceNeighborResult>> {
    if (
      params.maxNeighbors <= 0 ||
      !owner.dependencies.provider.isAvailable ||
      typeof owner.dependencies.embeddingRepo.listByWorkspace !== "function"
    ) {
      return emptyWorkspaceNeighborResult();
    }

    const scan = await loadWorkspaceVectorScan(owner, params);
    if (scan === null) {
      return emptyWorkspaceNeighborResult();
    }
    if (scan.storedVectors.length === 0) {
      return workspaceNeighborResult(owner, scan, emptyWorkspaceNeighborResult());
    }

    const query = await resolveWorkspaceNeighborQueryEmbedding(owner, params);
    if (query.queryEmbedding === null) {
      owner.warn("embedding workspace neighbor scan failed", {
        workspace_id: params.workspaceId,
        run_id: params.runId,
        reason: query.queryEmbeddingDegradationReason ?? "query_embedding_failed",
        error: query.queryEmbeddingError ?? query.queryEmbeddingDegradationReason ?? "query_embedding_failed"
      });
      return workspaceNeighborResult(owner, scan, {
        hits: Object.freeze([]) as readonly Readonly<EmbeddingNeighborHit>[],
        embedding_inference_calls: 0,
        query_embedding_cache_hit: query.queryEmbeddingCacheHit,
        query_embedding_status: query.queryEmbeddingStatus,
        query_embedding_degradation_reason: query.queryEmbeddingDegradationReason
      });
    }

    return workspaceNeighborResult(owner, scan, {
      hits: Object.freeze(rankWorkspaceNeighborHits(owner, scan.storedVectors, query.queryEmbedding, params)),
      embedding_inference_calls: query.embeddingInferenceCalls,
      query_embedding_cache_hit: query.queryEmbeddingCacheHit,
      query_embedding_status: query.queryEmbeddingStatus,
      query_embedding_degradation_reason: query.queryEmbeddingDegradationReason
    });
  }

async function loadWorkspaceVectorScan(owner: EmbeddingRecallServiceMethodOwner, params: WorkspaceNeighborParams): Promise<WorkspaceVectorScan | null> {
    const workspaceScanCap = resolveEmbeddingWorkspaceScanCap();
    const listByWorkspace = owner.dependencies.embeddingRepo.listByWorkspace;
    if (typeof listByWorkspace !== "function") {
      return null;
    }
    try {
      const scanned = await listByWorkspace(params.workspaceId, {
        tierFilter: resolveEmbeddingRecallTiers(),
        limit: workspaceScanCap + 1,
        providerKind: owner.dependencies.provider.providerKind,
        modelId: owner.dependencies.provider.modelId,
        schemaVersion: owner.dependencies.provider.schemaVersion
      });
      warnIfWorkspaceScanTruncated(owner, params, scanned.length, workspaceScanCap);
      return Object.freeze({
        storedVectors: scanned.length > workspaceScanCap ? scanned.slice(0, workspaceScanCap) : scanned,
        workspaceScanCap,
        workspaceScannedCount: scanned.length,
        workspaceScanTruncated: scanned.length > workspaceScanCap
      });
    } catch (error) {
      owner.warn("embedding workspace neighbor scan failed", {
        workspace_id: params.workspaceId,
        run_id: params.runId,
        reason: "local_vector_lookup_failed",
        error: toErrorMessage(error)
      });
      return null;
    }
  }

function warnIfWorkspaceScanTruncated(owner: EmbeddingRecallServiceMethodOwner, params: WorkspaceNeighborParams, returned: number, workspaceScanCap: number): void {
    if (returned <= workspaceScanCap) {
      return;
    }
    owner.warn("embedding workspace scan truncated by cap", {
      workspace_id: params.workspaceId,
      run_id: params.runId,
      scan_cap: workspaceScanCap,
      returned
    });
  }

async function resolveWorkspaceNeighborQueryEmbedding(owner: EmbeddingRecallServiceMethodOwner, params: WorkspaceNeighborParams): Promise<WorkspaceQueryEmbeddingResolution> {
    let queryEmbeddingCacheHit = true;
    try {
      const preparedQuery = owner.prepareQueryEmbedding({
        workspaceId: params.workspaceId,
        runId: params.runId,
        queryText: params.queryText
      });
      queryEmbeddingCacheHit = preparedQuery.cacheHit;
      const initialSnapshot = preparedQuery.getSnapshot();
      const snapshot = initialSnapshot.status === "pending" && typeof preparedQuery.waitForSnapshot === "function"
        ? await preparedQuery.waitForSnapshot(owner.queryTimeoutMs)
        : initialSnapshot;
      return resolveWorkspaceNeighborQuerySnapshot(snapshot, queryEmbeddingCacheHit);
    } catch {
      return failedWorkspaceNeighborQuery(queryEmbeddingCacheHit);
    }
  }

function resolveWorkspaceNeighborQuerySnapshot(snapshot: PreparedEmbeddingQuerySnapshot, cacheHit: boolean): WorkspaceQueryEmbeddingResolution {
    if (snapshot.status === "ready") {
      return {
        queryEmbedding: snapshot.embedding,
        queryEmbeddingCacheHit: cacheHit,
        embeddingInferenceCalls: cacheHit ? 0 : 1,
        queryEmbeddingStatus: "provider_returned",
        queryEmbeddingDegradationReason: null,
        queryEmbeddingError: null
      };
    }
    if (snapshot.status === "failed") {
      return failedWorkspaceNeighborQuery(
        cacheHit,
        "provider_failed",
        snapshot.reason,
        snapshot.error_message ?? snapshot.reason
      );
    }
    return failedWorkspaceNeighborQuery(cacheHit, "provider_pending", "query_embedding_pending", "query_embedding_pending");
  }

function failedWorkspaceNeighborQuery(cacheHit: boolean, status: WorkspaceQueryEmbeddingResolution["queryEmbeddingStatus"] = "provider_failed", reason = "query_embedding_failed", error = reason): WorkspaceQueryEmbeddingResolution {
    return Object.freeze({
      queryEmbedding: null,
      queryEmbeddingCacheHit: cacheHit,
      embeddingInferenceCalls: 0,
      queryEmbeddingStatus: status,
      queryEmbeddingDegradationReason: reason,
      queryEmbeddingError: error
    });
  }

function rankWorkspaceNeighborHits(owner: EmbeddingRecallServiceMethodOwner, storedVectors: readonly Readonly<EmbeddingVectorRecord>[], queryEmbedding: Float32Array, params: WorkspaceNeighborParams): readonly Readonly<EmbeddingNeighborHit>[] {
    const excluded = new Set(params.excludeObjectIds);
    return storedVectors
      .filter(
        (record) =>
          !excluded.has(record.object_id) &&
          record.provider_kind === owner.dependencies.provider.providerKind &&
          record.model_id === owner.dependencies.provider.modelId &&
          record.schema_version === owner.dependencies.provider.schemaVersion &&
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
            normalized_similarity: normalizedSimilarity,
            content_hash: record.content_hash
          })
        ];
      })
      .sort((left, right) => {
        const delta = right.normalized_similarity - left.normalized_similarity;
        return delta !== 0 ? delta : left.object_id.localeCompare(right.object_id);
      })
      .slice(0, params.maxNeighbors);
  }

function workspaceNeighborResult(owner: EmbeddingRecallServiceMethodOwner, scan: WorkspaceVectorScan, partial: Pick<EmbeddingWorkspaceNeighborResult, "hits" | "embedding_inference_calls" | "query_embedding_cache_hit" | "query_embedding_status" | "query_embedding_degradation_reason">): Readonly<EmbeddingWorkspaceNeighborResult> {
    return Object.freeze({
      ...partial,
      workspace_scan_truncated: scan.workspaceScanTruncated,
      workspace_scan_cap: scan.workspaceScanCap,
      workspace_scanned_count: scan.workspaceScannedCount,
      provider_kind: owner.dependencies.provider.providerKind,
      model_id: owner.dependencies.provider.modelId,
      schema_version: owner.dependencies.provider.schemaVersion
    });
  }

export async function embeddingRecallServiceLoadStoredVectors(owner: EmbeddingRecallServiceMethodOwner, params: {
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly queryId: string;
    readonly eligibleMemories: readonly Readonly<MemoryEntry>[];
    readonly baseCandidateCount: number;
  }): Promise<readonly Readonly<EmbeddingVectorRecord>[] | null> {
    try {
      return await owner.dependencies.embeddingRepo.listByObjectIds(
        params.workspaceId,
        params.eligibleMemories.map((memory) => memory.object_id)
      );
    } catch (error) {
      const message = toErrorMessage(error);
      owner.warn("embedding supplement degraded", {
        workspace_id: params.workspaceId,
        run_id: params.runId,
        reason: "local_vector_lookup_failed",
        error: message
      });
      await owner.recordDegraded({
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

export async function embeddingRecallServiceResolveQueryEmbeddingNow(owner: EmbeddingRecallServiceMethodOwner, params: {
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly queryId: string;
    readonly queryText: string;
    readonly baseCandidateCount: number;
  }): Promise<Float32Array | null> {
    try {
      const embeddings = await owner.dependencies.provider.embedTexts([params.queryText], {
        timeoutMs: owner.queryTimeoutMs
      });
      if (embeddings.length !== 1) {
        throw new Error(`Expected exactly one query embedding, received ${embeddings.length}.`);
      }

      return new Float32Array(embeddings[0]!);
    } catch (error) {
      const message = toErrorMessage(error);
      owner.warn("embedding supplement degraded", {
        workspace_id: params.workspaceId,
        run_id: params.runId,
        reason: "query_embedding_failed",
        error: message
      });
      await owner.recordDegraded({
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
