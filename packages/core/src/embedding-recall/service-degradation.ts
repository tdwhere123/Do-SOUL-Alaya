import { type MemoryEntry } from "@do-soul/alaya-protocol";

import type { EmbeddingRecallTelemetry } from "./embedding-recall-telemetry.js";
import { toErrorMessage } from "./helpers.js";
import type {
  EmbeddingRecallRepoPort,
  EmbeddingVectorRecord,
  PreparedEmbeddingQueryHandle,
  PreparedEmbeddingSupplement
} from "./types.js";

export interface EmbeddingDegradationContext {
  readonly workspaceId: string;
  readonly runId: string | null;
  readonly queryId: string;
  readonly baseCandidateCount: number;
}

export function emptyPreparedSupplement(
  degradedReason: string | null
): PreparedEmbeddingSupplement {
  return Object.freeze({
    preparedQuery: null,
    storedVectors: Object.freeze([]),
    degradedReason
  });
}

export function recordEmbeddingDegraded(
  telemetry: EmbeddingRecallTelemetry,
  params: EmbeddingDegradationContext,
  reason: string
): Promise<void> {
  return telemetry.recordDegraded({
    workspaceId: params.workspaceId,
    runId: params.runId,
    queryId: params.queryId,
    reason,
    baseCandidateCount: params.baseCandidateCount,
    fallbackCandidateCount: params.baseCandidateCount
  });
}

export async function loadStoredVectors(params: {
  readonly embeddingRepo: EmbeddingRecallRepoPort;
  readonly workspaceId: string;
  readonly runId: string | null;
  readonly queryId?: string;
  readonly eligibleMemories: readonly Readonly<MemoryEntry>[];
  readonly baseCandidateCount: number;
  readonly precheck?: boolean;
  readonly generateQueryId: () => string;
  readonly warn: (message: string, meta: Record<string, unknown>) => void;
  readonly recordDegraded: (
    context: EmbeddingDegradationContext,
    reason: string
  ) => Promise<void>;
}): Promise<readonly Readonly<EmbeddingVectorRecord>[] | null> {
  try {
    return await params.embeddingRepo.listByObjectIds(
      params.workspaceId,
      params.eligibleMemories.map((memory) => memory.object_id)
    );
  } catch (error) {
    const message = toErrorMessage(error);
    const warning = params.precheck
      ? "embedding supplement precheck failed"
      : "embedding supplement degraded";
    params.warn(warning, {
      workspace_id: params.workspaceId,
      ...(params.precheck ? {} : { run_id: params.runId }),
      reason: "local_vector_lookup_failed",
      error: message
    });
    await params.recordDegraded(
      {
        workspaceId: params.workspaceId,
        runId: params.runId,
        queryId: params.queryId ?? params.generateQueryId(),
        baseCandidateCount: params.baseCandidateCount
      },
      "local_vector_lookup_failed"
    );
    return null;
  }
}

export async function probeHasStoredVectors(params: {
  readonly embeddingRepo: EmbeddingRecallRepoPort;
  readonly workspaceId: string;
  readonly eligibleMemories: readonly Readonly<MemoryEntry>[];
  readonly warn: (message: string, meta: Record<string, unknown>) => void;
}): Promise<boolean> {
  if (params.eligibleMemories.length === 0) {
    return false;
  }

  const objectIds = params.eligibleMemories.map((memory) => memory.object_id);
  try {
    if (typeof params.embeddingRepo.existsAnyByObjectIds === "function") {
      return await params.embeddingRepo.existsAnyByObjectIds(params.workspaceId, objectIds);
    }
    const storedVectors = await params.embeddingRepo.listByObjectIds(
      params.workspaceId,
      objectIds
    );
    return storedVectors.length > 0;
  } catch (error) {
    params.warn("embedding supplement precheck failed", {
      workspace_id: params.workspaceId,
      reason: "local_vector_lookup_failed",
      error: toErrorMessage(error)
    });
    throw Object.assign(new Error("embedding supplement precheck failed"), {
      reason: "local_vector_lookup_failed"
    } satisfies { readonly reason: "local_vector_lookup_failed" });
  }
}

export async function resolvePreparedQueryEmbedding(params: {
  readonly preparedQuery: PreparedEmbeddingQueryHandle;
  readonly workspaceId: string;
  readonly runId: string | null;
  readonly baseCandidateIds: readonly string[];
  readonly queryTimeoutMs: number;
  readonly warn: (message: string, meta: Record<string, unknown>) => void;
  readonly recordDegraded: (
    context: EmbeddingDegradationContext,
    reason: string
  ) => Promise<void>;
}): Promise<Float32Array | null> {
  const initialSnapshot = params.preparedQuery.getSnapshot();
  const snapshot = initialSnapshot.status === "pending" &&
    typeof params.preparedQuery.waitForSnapshot === "function"
    ? await params.preparedQuery.waitForSnapshot(params.queryTimeoutMs)
    : initialSnapshot;
  if (snapshot.status === "ready") {
    return snapshot.embedding;
  }

  if (snapshot.status === "failed") {
    params.warn("embedding supplement degraded", {
      workspace_id: params.workspaceId,
      run_id: params.runId,
      reason: snapshot.reason,
      error_name: snapshot.error_name,
      error: snapshot.error_message ?? snapshot.reason
    });
  }
  const reason = snapshot.status === "pending" ? "query_embedding_pending" : snapshot.reason;
  await params.recordDegraded(
    {
      workspaceId: params.workspaceId,
      runId: params.runId,
      queryId: params.preparedQuery.queryId,
      baseCandidateCount: params.baseCandidateIds.length
    },
    reason
  );
  return null;
}

export async function resolveQueryEmbeddingNowSafely(params: {
  readonly workspaceId: string;
  readonly runId: string | null;
  readonly queryId: string;
  readonly queryText: string;
  readonly baseCandidateCount: number;
  readonly resolve: (queryText: string) => Promise<Float32Array>;
  readonly warn: (message: string, meta: Record<string, unknown>) => void;
  readonly recordDegraded: (
    context: EmbeddingDegradationContext,
    reason: string
  ) => Promise<void>;
}): Promise<Float32Array | null> {
  try {
    return await params.resolve(params.queryText);
  } catch (error) {
    params.warn("embedding supplement degraded", {
      workspace_id: params.workspaceId,
      run_id: params.runId,
      reason: "query_embedding_failed",
      error: toErrorMessage(error)
    });
    await params.recordDegraded(
      {
        workspaceId: params.workspaceId,
        runId: params.runId,
        queryId: params.queryId,
        baseCandidateCount: params.baseCandidateCount
      },
      "query_embedding_failed"
    );
    return null;
  }
}
