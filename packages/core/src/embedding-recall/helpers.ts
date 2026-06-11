import { createHash } from "node:crypto";
import {
  DEFAULT_QUERY_EMBEDDING_CACHE_SIZE,
  DEFAULT_QUERY_TIMEOUT_MS,
  MAX_QUERY_EMBEDDING_CACHE_SIZE,
  MAX_QUERY_TIMEOUT_MS,
  MIN_QUERY_TIMEOUT_MS
} from "./constants.js";
import type {
  EmbeddingNeighborHit,
  EmbeddingRecallSupplementResult,
  EmbeddingWorkspaceNeighborResult,
  PreparedEmbeddingQueryHandle,
  PreparedEmbeddingQuerySnapshot
} from "./types.js";

export function clampQueryTimeout(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_QUERY_TIMEOUT_MS;
  }
  return Math.min(MAX_QUERY_TIMEOUT_MS, Math.max(MIN_QUERY_TIMEOUT_MS, value));
}

export function clampQueryEmbeddingCacheSize(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return DEFAULT_QUERY_EMBEDDING_CACHE_SIZE;
  }
  return Math.min(MAX_QUERY_EMBEDDING_CACHE_SIZE, Math.floor(value));
}

export const EMPTY_SUPPLEMENT_RESULT: EmbeddingRecallSupplementResult = Object.freeze({
  supplementaryEntries: Object.freeze([]),
  similarityHintsByObjectId: Object.freeze({})
});

export function emptyWorkspaceNeighborResult(): Readonly<EmbeddingWorkspaceNeighborResult> {
  return Object.freeze({
    hits: Object.freeze([]) as readonly Readonly<EmbeddingNeighborHit>[],
    embedding_inference_calls: 0,
    query_embedding_cache_hit: true
  });
}

export function createPreparedEmbeddingQueryHandle(
  queryId: string,
  snapshotOrGetter:
    | PreparedEmbeddingQuerySnapshot
    | (() => PreparedEmbeddingQuerySnapshot),
  options: {
    readonly cacheHit: boolean;
    readonly waitForSnapshot?: (
      timeoutMs: number
    ) => Promise<PreparedEmbeddingQuerySnapshot>;
  }
): PreparedEmbeddingQueryHandle {
  return {
    queryId,
    cacheHit: options.cacheHit,
    getSnapshot:
      typeof snapshotOrGetter === "function"
        ? snapshotOrGetter
        : () => snapshotOrGetter,
    ...(options.waitForSnapshot === undefined
      ? {}
      : { waitForSnapshot: options.waitForSnapshot })
  };
}

export async function waitForPreparedQuery(settled: Promise<unknown>, timeoutMs: number): Promise<void> {
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

export function hashMemoryContent(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

export function cosineSimilarity(left: Float32Array, right: Float32Array): number {
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

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.min(1, Math.max(0, value));
}

export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
