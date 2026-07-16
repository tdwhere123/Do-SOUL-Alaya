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
    query_embedding_cache_hit: true,
    workspace_scan_truncated: false,
    query_embedding_status: "provider_not_requested",
    query_embedding_degradation_reason: null
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
  const leftMagnitude = nonzeroFiniteMagnitude(left);
  return leftMagnitude === null ? 0 : cosineWithLeftMagnitude(left, leftMagnitude, right);
}

// invariant: all documents scored by one batch share the left-vector norm.
export function createCosineBatchScorer(
  left: Float32Array
): (right: Float32Array) => number {
  const leftMagnitude = nonzeroFiniteMagnitude(left);
  if (leftMagnitude === null) {
    return () => 0;
  }
  return (right) => cosineWithLeftMagnitude(left, leftMagnitude, right);
}

function cosineWithLeftMagnitude(
  left: Float32Array,
  leftMagnitude: number,
  right: Float32Array
): number {
  if (left.length !== right.length || right.length === 0) {
    return 0;
  }
  let dot = 0;
  let rightMagnitudeSquared = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    rightMagnitudeSquared += rightValue * rightValue;
  }
  if (rightMagnitudeSquared === 0) {
    return 0;
  }
  return dot / (leftMagnitude * Math.sqrt(rightMagnitudeSquared));
}

export function isFiniteNonzeroVector(vector: Float32Array): boolean {
  return finiteNonzeroMagnitudeSquared(vector) !== null;
}

export function isUsableEmbeddingRecordVector(
  record: { readonly dimensions: number; readonly embedding: Float32Array },
  expectedDimensions: number
): boolean {
  return (
    record.dimensions === expectedDimensions &&
    record.embedding.length === expectedDimensions &&
    isFiniteNonzeroVector(record.embedding)
  );
}

export function assertValidEmbeddingBatch(
  embeddings: readonly Float32Array[],
  expectedCount: number
): void {
  if (embeddings.length !== expectedCount) {
    throw new Error(`Expected ${expectedCount} embeddings but received ${embeddings.length}.`);
  }
  let dimensions: number | null = null;
  embeddings.forEach((embedding, index) => {
    if (!(embedding instanceof Float32Array) || !isFiniteNonzeroVector(embedding)) {
      throw new Error(`Embedding ${index} must be a non-empty finite vector with nonzero norm.`);
    }
    dimensions ??= embedding.length;
    if (embedding.length !== dimensions) {
      throw new Error(
        `Embedding batch dimensions must match; expected ${dimensions} but received ${embedding.length}.`
      );
    }
  });
}

function nonzeroFiniteMagnitude(vector: Float32Array): number | null {
  const squared = finiteNonzeroMagnitudeSquared(vector);
  return squared === null ? null : Math.sqrt(squared);
}

function finiteNonzeroMagnitudeSquared(vector: Float32Array): number | null {
  if (vector.length === 0) {
    return null;
  }
  let squared = 0;
  for (const value of vector) {
    squared += value * value;
  }
  return squared === 0 || !Number.isFinite(squared) ? null : squared;
}

// cosine space is comparable only within one (provider_kind, model_id, schema_version).
export function isProviderMatchedEmbedding(
  record: { readonly provider_kind: string; readonly model_id: string; readonly schema_version: number },
  provider: { readonly providerKind: string; readonly modelId: string; readonly schemaVersion: number }
): boolean {
  return (
    record.provider_kind === provider.providerKind &&
    record.model_id === provider.modelId &&
    record.schema_version === provider.schemaVersion
  );
}

export { clamp01 } from "../shared/clamp.js";

export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
