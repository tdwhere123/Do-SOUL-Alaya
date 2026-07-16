import { resolveEmbeddingWorkspaceScanCap } from "../constants.js";
import {
  clamp01,
  createCosineBatchScorer,
  hashMemoryContent,
  isFiniteNonzeroVector,
  isProviderMatchedEmbedding,
  isUsableEmbeddingRecordVector,
  toErrorMessage
} from "../helpers.js";
import type { QueryEmbeddingEngine } from "../query-embedding-engine.js";
import { resolveEmbeddingRecallTiers } from "../tier-config.js";
import type {
  EmbeddingNeighborHit,
  EmbeddingProviderPort,
  EmbeddingRecallRepoPort,
  EmbeddingRecallRequestScoreSnapshot,
  EmbeddingVectorRecord,
  EmbeddingWorkspaceNeighborResult,
  PrepareRecallEmbeddingSnapshotParams,
  PreparedEmbeddingQueryHandle,
  PreparedEmbeddingQuerySnapshot
} from "../types.js";

interface RequestScoreSnapshotDependencies {
  readonly provider: EmbeddingProviderPort;
  readonly embeddingRepo: EmbeddingRecallRepoPort;
  readonly queryEngine: QueryEmbeddingEngine;
  readonly queryTimeoutMs: number;
  readonly generateQueryId: () => string;
  readonly nowEpochMs: () => number;
  readonly warn: (message: string, meta: Record<string, unknown>) => void;
}

interface WorkspaceScan {
  readonly records: readonly Readonly<EmbeddingVectorRecord>[];
  readonly objectIds: ReadonlySet<string>;
  readonly cap: number;
  readonly returned: number;
  readonly truncated: boolean;
  readonly attempted: boolean;
  readonly failed: boolean;
}

interface QueryResolution {
  readonly handle: PreparedEmbeddingQueryHandle | null;
  readonly embedding: Float32Array | null;
  readonly status: NonNullable<EmbeddingWorkspaceNeighborResult["query_embedding_status"]>;
  readonly degradationReason: string | null;
  readonly inferenceCalls: number;
  readonly cacheHit: boolean;
}

interface ScoredLedger {
  readonly poolScores: Readonly<Record<string, number>>;
  readonly neighbors: readonly Readonly<EmbeddingNeighborHit>[];
  readonly scoringLatencyMs: number;
}

export class RequestScoreSnapshotBuilder {
  public constructor(private readonly deps: RequestScoreSnapshotDependencies) {}

  public async prepare(
    params: PrepareRecallEmbeddingSnapshotParams
  ): Promise<Readonly<EmbeddingRecallRequestScoreSnapshot>> {
    const scan = await this.loadWorkspaceScan(params);
    const ledger = new Map(scan.records.map((record) => [record.object_id, record] as const));
    const missingPoolIds = this.missingPoolIds(params, ledger);
    const exactLookupFailed = await this.addMissingPoolVectors(params, missingPoolIds, ledger);
    if (ledger.size === 0) {
      return this.emptySnapshot(params, scan, exactLookupFailed);
    }
    const query = await this.resolveQuery(params);
    const scored = query.embedding === null
      ? emptyScoredLedger()
      : this.scoreLedger(params, ledger, scan.objectIds, query.embedding);
    return this.buildSnapshot(params, scan, query, scored, exactLookupFailed);
  }

  private async loadWorkspaceScan(
    params: PrepareRecallEmbeddingSnapshotParams
  ): Promise<WorkspaceScan> {
    const cap = resolveEmbeddingWorkspaceScanCap();
    const listByWorkspace = this.deps.embeddingRepo.listByWorkspace;
    if (params.maxNeighbors <= 0 || !this.deps.provider.isAvailable || listByWorkspace === undefined) {
      return emptyWorkspaceScan(cap);
    }
    try {
      const returned = await listByWorkspace.call(this.deps.embeddingRepo, params.workspaceId, {
        tierFilter: resolveEmbeddingRecallTiers(),
        limit: cap + 1,
        providerKind: this.deps.provider.providerKind,
        modelId: this.deps.provider.modelId,
        schemaVersion: this.deps.provider.schemaVersion
      });
      return this.buildWorkspaceScan(params, returned, cap);
    } catch (error) {
      this.warnLookupFailure(params, "workspace scan", error);
      return Object.freeze({ ...emptyWorkspaceScan(cap), attempted: true, failed: true });
    }
  }

  private buildWorkspaceScan(
    params: PrepareRecallEmbeddingSnapshotParams,
    returned: readonly Readonly<EmbeddingVectorRecord>[],
    cap: number
  ): WorkspaceScan {
    const records = returned.filter((record) =>
      isProviderMatchedEmbedding(record, this.deps.provider)
    );
    const neighborObjectIds = returned.slice(0, cap)
      .filter((record) => isProviderMatchedEmbedding(record, this.deps.provider))
      .map((record) => record.object_id);
    if (returned.length > cap) {
      this.deps.warn("embedding workspace scan truncated by cap", {
        workspace_id: params.workspaceId,
        run_id: params.runId,
        scan_cap: cap,
        returned: returned.length
      });
    }
    return Object.freeze({
      records: Object.freeze(records),
      objectIds: new Set(neighborObjectIds),
      cap,
      returned: returned.length,
      truncated: returned.length > cap,
      attempted: true,
      failed: false
    });
  }

  private missingPoolIds(
    params: PrepareRecallEmbeddingSnapshotParams,
    ledger: ReadonlyMap<string, Readonly<EmbeddingVectorRecord>>
  ): readonly string[] {
    return Object.freeze([
      ...new Set(params.poolMemories.map((memory) => memory.object_id))
    ].filter((objectId) => !ledger.has(objectId)));
  }

  private async addMissingPoolVectors(
    params: PrepareRecallEmbeddingSnapshotParams,
    objectIds: readonly string[],
    ledger: Map<string, Readonly<EmbeddingVectorRecord>>
  ): Promise<boolean> {
    if (objectIds.length === 0) {
      return false;
    }
    try {
      const requested = new Set(objectIds);
      const records = await this.deps.embeddingRepo.listByObjectIds(params.workspaceId, objectIds);
      for (const record of records) {
        if (
          requested.has(record.object_id) &&
          !ledger.has(record.object_id) &&
          isProviderMatchedEmbedding(record, this.deps.provider)
        ) {
          ledger.set(record.object_id, record);
        }
      }
      return false;
    } catch (error) {
      this.warnLookupFailure(params, "pool lookup", error);
      return true;
    }
  }

  private async resolveQuery(params: PrepareRecallEmbeddingSnapshotParams): Promise<QueryResolution> {
    try {
      const handle = this.deps.queryEngine.prepareQueryEmbedding(params);
      const initial = handle.getSnapshot();
      const snapshot = initial.status === "pending" && handle.waitForSnapshot !== undefined
        ? await handle.waitForSnapshot(this.deps.queryTimeoutMs)
        : initial;
      return resolveQuerySnapshot(handle, snapshot);
    } catch (error) {
      const message = toErrorMessage(error);
      this.deps.warn("embedding request score snapshot failed", {
        workspace_id: params.workspaceId,
        run_id: params.runId,
        reason: "query_embedding_failed",
        error: message
      });
      return failedQueryResolution("query_embedding_failed");
    }
  }

  private scoreLedger(
    params: PrepareRecallEmbeddingSnapshotParams,
    ledger: ReadonlyMap<string, Readonly<EmbeddingVectorRecord>>,
    workspaceObjectIds: ReadonlySet<string>,
    queryEmbedding: Float32Array
  ): ScoredLedger {
    const startedAtEpochMs = this.deps.nowEpochMs();
    if (!isFiniteNonzeroVector(queryEmbedding)) {
      return Object.freeze({
        ...emptyScoredLedger(),
        scoringLatencyMs: elapsedMs(this.deps.nowEpochMs(), startedAtEpochMs)
      });
    }
    const poolMemories = new Map(params.poolMemories.map((memory) => [memory.object_id, memory] as const));
    const poolScores: Record<string, number> = {};
    const neighbors: EmbeddingNeighborHit[] = [];
    const scoreCosine = createCosineBatchScorer(queryEmbedding);
    for (const record of ledger.values()) {
      if (!isUsableEmbeddingRecordVector(record, queryEmbedding.length)) {
        continue;
      }
      const poolMemory = poolMemories.get(record.object_id);
      if (poolMemory === undefined && !workspaceObjectIds.has(record.object_id)) {
        continue;
      }
      if (poolMemory !== undefined && record.content_hash !== hashMemoryContent(poolMemory.content)) {
        continue;
      }
      const similarity = clamp01(scoreCosine(record.embedding));
      if (poolMemory !== undefined) {
        poolScores[record.object_id] = similarity;
      } else if (similarity > 0 && workspaceObjectIds.has(record.object_id)) {
        neighbors.push(Object.freeze({
          object_id: record.object_id,
          normalized_similarity: similarity,
          content_hash: record.content_hash
        }));
      }
    }
    neighbors.sort(compareNeighborHits);
    return Object.freeze({
      poolScores: Object.freeze(poolScores),
      neighbors: Object.freeze(neighbors.slice(0, params.maxNeighbors)),
      scoringLatencyMs: elapsedMs(this.deps.nowEpochMs(), startedAtEpochMs)
    });
  }

  private buildSnapshot(
    params: PrepareRecallEmbeddingSnapshotParams,
    scan: WorkspaceScan,
    query: QueryResolution,
    scored: ScoredLedger,
    exactLookupFailed: boolean
  ): Readonly<EmbeddingRecallRequestScoreSnapshot> {
    const queryId = query.handle?.queryId ?? this.deps.generateQueryId();
    return Object.freeze({
      workspaceId: params.workspaceId,
      runId: params.runId,
      queryId,
      poolScoresByObjectId: scored.poolScores,
      scoringLatencyMs: scored.scoringLatencyMs,
      workspaceNeighbors: buildNeighborResult(scan, query, scored.neighbors, this.deps.provider),
      degradedReason: resolveDegradationReason(scan, query.degradationReason, exactLookupFailed)
    });
  }

  private emptySnapshot(
    params: PrepareRecallEmbeddingSnapshotParams,
    scan: WorkspaceScan,
    exactLookupFailed: boolean
  ): Readonly<EmbeddingRecallRequestScoreSnapshot> {
    const query = notRequestedQueryResolution();
    return Object.freeze({
      workspaceId: params.workspaceId,
      runId: params.runId,
      queryId: this.deps.generateQueryId(),
      poolScoresByObjectId: Object.freeze({}),
      scoringLatencyMs: 0,
      workspaceNeighbors: buildNeighborResult(scan, query, Object.freeze([]), this.deps.provider),
      degradedReason: resolveDegradationReason(scan, null, exactLookupFailed)
    });
  }

  private warnLookupFailure(
    params: PrepareRecallEmbeddingSnapshotParams,
    operation: string,
    error: unknown
  ): void {
    this.deps.warn(`embedding request score ${operation} failed`, {
      workspace_id: params.workspaceId,
      run_id: params.runId,
      reason: "local_vector_lookup_failed",
      error: toErrorMessage(error)
    });
  }
}

function emptyScoredLedger(): ScoredLedger {
  return Object.freeze({
    poolScores: Object.freeze({}),
    neighbors: Object.freeze([]),
    scoringLatencyMs: 0
  });
}

function resolveDegradationReason(
  scan: WorkspaceScan,
  queryReason: string | null,
  exactLookupFailed: boolean
): string | null {
  return queryReason ?? (scan.failed || exactLookupFailed ? "local_vector_lookup_failed" : null);
}

function elapsedMs(finishedAtEpochMs: number, startedAtEpochMs: number): number {
  return Math.max(0, Math.trunc(finishedAtEpochMs - startedAtEpochMs));
}

function emptyWorkspaceScan(cap: number): WorkspaceScan {
  return Object.freeze({
    records: Object.freeze([]),
    objectIds: new Set<string>(),
    cap,
    returned: 0,
    truncated: false,
    attempted: false,
    failed: false
  });
}

function resolveQuerySnapshot(
  handle: PreparedEmbeddingQueryHandle,
  snapshot: PreparedEmbeddingQuerySnapshot
): QueryResolution {
  if (snapshot.status === "ready") {
    return Object.freeze({
      handle,
      embedding: snapshot.embedding,
      status: "provider_returned",
      degradationReason: null,
      inferenceCalls: handle.cacheHit ? 0 : 1,
      cacheHit: handle.cacheHit
    });
  }
  return Object.freeze({
    handle,
    embedding: null,
    status: snapshot.status === "pending" ? "provider_pending" : "provider_failed",
    degradationReason: snapshot.status === "pending" ? "query_embedding_pending" : snapshot.reason,
    inferenceCalls: 0,
    cacheHit: handle.cacheHit
  });
}

function failedQueryResolution(reason: string): QueryResolution {
  return Object.freeze({
    handle: null,
    embedding: null,
    status: "provider_failed",
    degradationReason: reason,
    inferenceCalls: 0,
    cacheHit: true
  });
}

function notRequestedQueryResolution(): QueryResolution {
  return Object.freeze({
    handle: null,
    embedding: null,
    status: "provider_not_requested",
    degradationReason: null,
    inferenceCalls: 0,
    cacheHit: true
  });
}

function buildNeighborResult(
  scan: WorkspaceScan,
  query: QueryResolution,
  hits: readonly Readonly<EmbeddingNeighborHit>[],
  provider: EmbeddingProviderPort
): Readonly<EmbeddingWorkspaceNeighborResult> {
  return Object.freeze({
    hits,
    embedding_inference_calls: query.inferenceCalls,
    query_embedding_cache_hit: query.cacheHit,
    query_embedding_status: query.status,
    query_embedding_degradation_reason: query.degradationReason,
    ...(scan.attempted ? {
      workspace_scan_truncated: scan.truncated,
      workspace_scan_cap: scan.cap,
      workspace_scanned_count: scan.returned,
      provider_kind: provider.providerKind,
      model_id: provider.modelId,
      schema_version: provider.schemaVersion
    } : {})
  });
}

function compareNeighborHits(
  left: Readonly<EmbeddingNeighborHit>,
  right: Readonly<EmbeddingNeighborHit>
): number {
  const delta = right.normalized_similarity - left.normalized_similarity;
  return delta !== 0 ? delta : left.object_id.localeCompare(right.object_id);
}
