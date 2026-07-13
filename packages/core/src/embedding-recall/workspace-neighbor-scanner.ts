import { resolveEmbeddingWorkspaceScanCap } from "./constants.js";
import { clamp01, cosineSimilarity, emptyWorkspaceNeighborResult, toErrorMessage } from "./helpers.js";
import type { QueryEmbeddingEngine } from "./query-embedding-engine.js";
import { resolveEmbeddingRecallTiers } from "./tier-config.js";
import type {
  EmbeddingNeighborHit,
  EmbeddingProviderPort,
  EmbeddingRecallRepoPort,
  EmbeddingVectorRecord,
  EmbeddingWorkspaceNeighborResult,
  PreparedEmbeddingQuerySnapshot
} from "./types.js";

export interface WorkspaceNeighborScannerDependencies {
  readonly provider: EmbeddingProviderPort;
  readonly embeddingRepo: EmbeddingRecallRepoPort;
  readonly queryEngine: QueryEmbeddingEngine;
  readonly queryTimeoutMs: number;
  readonly warn: (message: string, meta: Record<string, unknown>) => void;
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

// Embedding-on coarse-injection path: top-K workspace cosine neighbors that
// lexical recall never admitted into the candidate pool.
export class WorkspaceNeighborScanner {
  public constructor(private readonly deps: WorkspaceNeighborScannerDependencies) {}

  public async collectWorkspaceNeighborsWithMetadata(
    params: WorkspaceNeighborParams
  ): Promise<Readonly<EmbeddingWorkspaceNeighborResult>> {
    if (
      params.maxNeighbors <= 0 ||
      !this.deps.provider.isAvailable ||
      typeof this.deps.embeddingRepo.listByWorkspace !== "function"
    ) {
      return emptyWorkspaceNeighborResult();
    }

    const scan = await this.loadWorkspaceVectorScan(params);
    if (scan === null) {
      return emptyWorkspaceNeighborResult();
    }
    if (scan.storedVectors.length === 0) {
      return this.workspaceNeighborResult(scan, emptyWorkspaceNeighborResult());
    }

    const query = await this.resolveWorkspaceNeighborQueryEmbedding(params);
    if (query.queryEmbedding === null) {
      this.deps.warn("embedding workspace neighbor scan failed", {
        workspace_id: params.workspaceId,
        run_id: params.runId,
        reason: query.queryEmbeddingDegradationReason ?? "query_embedding_failed",
        error: query.queryEmbeddingError ?? query.queryEmbeddingDegradationReason ?? "query_embedding_failed"
      });
      return this.workspaceNeighborResult(scan, {
        hits: Object.freeze([]) as readonly Readonly<EmbeddingNeighborHit>[],
        embedding_inference_calls: 0,
        query_embedding_cache_hit: query.queryEmbeddingCacheHit,
        query_embedding_status: query.queryEmbeddingStatus,
        query_embedding_degradation_reason: query.queryEmbeddingDegradationReason
      });
    }

    return this.workspaceNeighborResult(scan, {
      hits: Object.freeze(this.rankWorkspaceNeighborHits(scan.storedVectors, query.queryEmbedding, params)),
      embedding_inference_calls: query.embeddingInferenceCalls,
      query_embedding_cache_hit: query.queryEmbeddingCacheHit,
      query_embedding_status: query.queryEmbeddingStatus,
      query_embedding_degradation_reason: query.queryEmbeddingDegradationReason
    });
  }

  private async loadWorkspaceVectorScan(params: WorkspaceNeighborParams): Promise<WorkspaceVectorScan | null> {
    const workspaceScanCap = resolveEmbeddingWorkspaceScanCap();
    const embeddingRepo = this.deps.embeddingRepo;
    if (typeof embeddingRepo.listByWorkspace !== "function") {
      return null;
    }
    try {
      const scanned = await embeddingRepo.listByWorkspace(params.workspaceId, {
        tierFilter: resolveEmbeddingRecallTiers(),
        limit: workspaceScanCap + 1,
        providerKind: this.deps.provider.providerKind,
        modelId: this.deps.provider.modelId,
        schemaVersion: this.deps.provider.schemaVersion
      });
      this.warnIfWorkspaceScanTruncated(params, scanned.length, workspaceScanCap);
      return Object.freeze({
        storedVectors: scanned.length > workspaceScanCap ? scanned.slice(0, workspaceScanCap) : scanned,
        workspaceScanCap,
        workspaceScannedCount: scanned.length,
        workspaceScanTruncated: scanned.length > workspaceScanCap
      });
    } catch (error) {
      this.deps.warn("embedding workspace neighbor scan failed", {
        workspace_id: params.workspaceId,
        run_id: params.runId,
        reason: "local_vector_lookup_failed",
        error: toErrorMessage(error)
      });
      return null;
    }
  }

  private warnIfWorkspaceScanTruncated(params: WorkspaceNeighborParams, returned: number, workspaceScanCap: number): void {
    if (returned <= workspaceScanCap) {
      return;
    }
    this.deps.warn("embedding workspace scan truncated by cap", {
      workspace_id: params.workspaceId,
      run_id: params.runId,
      scan_cap: workspaceScanCap,
      returned
    });
  }

  private async resolveWorkspaceNeighborQueryEmbedding(
    params: WorkspaceNeighborParams
  ): Promise<WorkspaceQueryEmbeddingResolution> {
    let queryEmbeddingCacheHit = true;
    try {
      const preparedQuery = this.deps.queryEngine.prepareQueryEmbedding({
        workspaceId: params.workspaceId,
        runId: params.runId,
        queryText: params.queryText
      });
      queryEmbeddingCacheHit = preparedQuery.cacheHit;
      const initialSnapshot = preparedQuery.getSnapshot();
      const snapshot = initialSnapshot.status === "pending" && typeof preparedQuery.waitForSnapshot === "function"
        ? await preparedQuery.waitForSnapshot(this.deps.queryTimeoutMs)
        : initialSnapshot;
      return resolveWorkspaceNeighborQuerySnapshot(snapshot, { queryEmbeddingCacheHit });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.warn("embedding workspace neighbor scan failed", {
        workspace_id: params.workspaceId,
        run_id: params.runId,
        reason: "query_embedding_failed",
        error: message
      });
      return failedWorkspaceNeighborQuery(
        { queryEmbeddingCacheHit },
        "provider_failed",
        "query_embedding_failed",
        message
      );
    }
  }

  private rankWorkspaceNeighborHits(
    storedVectors: readonly Readonly<EmbeddingVectorRecord>[],
    queryEmbedding: Float32Array,
    params: WorkspaceNeighborParams
  ): readonly Readonly<EmbeddingNeighborHit>[] {
    const excluded = new Set(params.excludeObjectIds);
    return storedVectors
      .filter(
        (record) =>
          !excluded.has(record.object_id) &&
          record.provider_kind === this.deps.provider.providerKind &&
          record.model_id === this.deps.provider.modelId &&
          record.schema_version === this.deps.provider.schemaVersion &&
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

  private workspaceNeighborResult(
    scan: WorkspaceVectorScan,
    partial: Pick<EmbeddingWorkspaceNeighborResult, "hits" | "embedding_inference_calls" | "query_embedding_cache_hit" | "query_embedding_status" | "query_embedding_degradation_reason">
  ): Readonly<EmbeddingWorkspaceNeighborResult> {
    return Object.freeze({
      ...partial,
      workspace_scan_truncated: scan.workspaceScanTruncated,
      workspace_scan_cap: scan.workspaceScanCap,
      workspace_scanned_count: scan.workspaceScannedCount,
      provider_kind: this.deps.provider.providerKind,
      model_id: this.deps.provider.modelId,
      schema_version: this.deps.provider.schemaVersion
    });
  }
}

interface WorkspaceNeighborQuerySnapshotOptions {
  readonly queryEmbeddingCacheHit: boolean;
}

function resolveWorkspaceNeighborQuerySnapshot(
  snapshot: PreparedEmbeddingQuerySnapshot,
  options: WorkspaceNeighborQuerySnapshotOptions
): WorkspaceQueryEmbeddingResolution {
  const { queryEmbeddingCacheHit } = options;
  if (snapshot.status === "ready") {
    return {
      queryEmbedding: snapshot.embedding,
      queryEmbeddingCacheHit,
      embeddingInferenceCalls: queryEmbeddingCacheHit ? 0 : 1,
      queryEmbeddingStatus: "provider_returned",
      queryEmbeddingDegradationReason: null,
      queryEmbeddingError: null
    };
  }
  if (snapshot.status === "failed") {
    return failedWorkspaceNeighborQuery(
      { queryEmbeddingCacheHit },
      "provider_failed",
      snapshot.reason,
      snapshot.error_message ?? snapshot.reason
    );
  }
  return failedWorkspaceNeighborQuery(
    { queryEmbeddingCacheHit },
    "provider_pending",
    "query_embedding_pending",
    "query_embedding_pending"
  );
}

function failedWorkspaceNeighborQuery(
  options: WorkspaceNeighborQuerySnapshotOptions,
  status: WorkspaceQueryEmbeddingResolution["queryEmbeddingStatus"] = "provider_failed",
  reason = "query_embedding_failed",
  error = reason
): WorkspaceQueryEmbeddingResolution {
  return Object.freeze({
    queryEmbedding: null,
    queryEmbeddingCacheHit: options.queryEmbeddingCacheHit,
    embeddingInferenceCalls: 0,
    queryEmbeddingStatus: status,
    queryEmbeddingDegradationReason: reason,
    queryEmbeddingError: error
  });
}
