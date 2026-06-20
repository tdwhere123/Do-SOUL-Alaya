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

interface BuildSupplementFromQueryEmbeddingParams {
  readonly workspaceId: string;
  readonly runId: string | null;
  readonly queryId: string;
  readonly queryEmbedding: Float32Array;
  readonly storedVectors: readonly Readonly<EmbeddingVectorRecord>[];
  readonly eligibleMemories: readonly Readonly<MemoryEntry>[];
  readonly baseCandidateIds: readonly string[];
  readonly maxSupplement: number;
}

interface EmbeddingSimilarityHint {
  readonly object_id: string;
  readonly normalized_similarity: number;
}

export async function embeddingRecallServiceBuildSupplementFromQueryEmbedding(owner: EmbeddingRecallServiceMethodOwner, params: BuildSupplementFromQueryEmbeddingParams): Promise<EmbeddingRecallSupplementResult> {
    const startedAtEpochMs = Date.now();
    const eligibleMemoryMap = new Map(
      params.eligibleMemories.map((memory) => [memory.object_id, memory] as const)
    );
    const hints = collectEmbeddingSimilarityHints(owner, params, eligibleMemoryMap);
    const latencyMs = Math.max(0, Date.now() - startedAtEpochMs);
    await appendSupplementQueriedTelemetry(owner, params, hints.length, latencyMs);

    const supplementaryEntries = selectSupplementaryEntries(params, hints, eligibleMemoryMap);
    await appendSupplementMergedTelemetry(owner, params, supplementaryEntries.length);

    return Object.freeze({
      supplementaryEntries: Object.freeze([...supplementaryEntries]),
      similarityHintsByObjectId: Object.freeze(
        Object.fromEntries(hints.map((hint) => [hint.object_id, hint] as const))
      )
    });
  }

function collectEmbeddingSimilarityHints(
  owner: EmbeddingRecallServiceMethodOwner,
  params: BuildSupplementFromQueryEmbeddingParams,
  eligibleMemoryMap: ReadonlyMap<string, Readonly<MemoryEntry>>
): readonly Readonly<EmbeddingSimilarityHint>[] {
    return params.storedVectors
      .filter(
        (record) =>
          record.provider_kind === owner.dependencies.provider.providerKind &&
          record.model_id === owner.dependencies.provider.modelId &&
          record.schema_version === owner.dependencies.provider.schemaVersion &&
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
  }

async function appendSupplementQueriedTelemetry(
  owner: EmbeddingRecallServiceMethodOwner,
  params: BuildSupplementFromQueryEmbeddingParams,
  returnedCandidateCount: number,
  latencyMs: number
): Promise<void> {
    await owner.appendTelemetrySafely({
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
          returned_candidate_count: returnedCandidateCount,
          latency_ms: latencyMs,
          queried_at: owner.now()
        })
      }
    });
  }

function selectSupplementaryEntries(
  params: BuildSupplementFromQueryEmbeddingParams,
  hints: readonly Readonly<EmbeddingSimilarityHint>[],
  eligibleMemoryMap: ReadonlyMap<string, Readonly<MemoryEntry>>
): readonly Readonly<MemoryEntry>[] {
    const baseCandidateIdSet = new Set(params.baseCandidateIds);
    return hints
      .filter((hint) => !baseCandidateIdSet.has(hint.object_id))
      .slice(0, params.maxSupplement)
      .flatMap((hint) => {
        const memory = eligibleMemoryMap.get(hint.object_id);
        return memory === undefined ? [] : [memory];
      });
  }

async function appendSupplementMergedTelemetry(
  owner: EmbeddingRecallServiceMethodOwner,
  params: BuildSupplementFromQueryEmbeddingParams,
  supplementCandidateCount: number
): Promise<void> {
    await owner.appendTelemetrySafely({
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
          supplement_candidate_count: supplementCandidateCount,
          merged_candidate_count: params.baseCandidateIds.length + supplementCandidateCount,
          merged_at: owner.now()
        })
      }
    });
  }

export async function embeddingRecallServiceRecordDegraded(owner: EmbeddingRecallServiceMethodOwner, params: {
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly queryId: string;
    readonly reason: string;
    readonly baseCandidateCount: number;
    readonly fallbackCandidateCount: number;
  }): Promise<void> {
    try {
      await owner.dependencies.eventLogRepo.append({
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
          degraded_at: owner.now()
        })
      });
    } catch (error) {
      owner.warn("embedding supplement degraded telemetry failed", {
        workspace_id: params.workspaceId,
        run_id: params.runId,
        query_id: params.queryId,
        stage: "event_log",
        error: toErrorMessage(error)
      });
    }

    try {
      await owner.dependencies.healthJournalRecorder?.record({
        event_kind: HealthEventKind.EMBEDDING_SUPPLEMENT,
        workspace_id: params.workspaceId,
        run_id: params.runId,
        summary: "Embedding supplement degraded to keyword-only recall.",
        detail_json: {
          query_id: params.queryId,
          reason: params.reason,
          base_candidate_count: params.baseCandidateCount,
          fallback_candidate_count: params.fallbackCandidateCount,
          provider_kind: owner.dependencies.provider.providerKind,
          model_id: owner.dependencies.provider.modelId,
          embedding_enabled: owner.dependencies.provider.isAvailable
        }
      });
    } catch (error) {
      owner.warn("embedding supplement degraded telemetry failed", {
        workspace_id: params.workspaceId,
        run_id: params.runId,
        query_id: params.queryId,
        stage: "health_journal",
        error: toErrorMessage(error)
      });
    }
  }

export async function embeddingRecallServiceAppendTelemetrySafely(owner: EmbeddingRecallServiceMethodOwner, params: {
    readonly stage: "queried" | "merged";
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly queryId: string;
    readonly entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">;
  }): Promise<void> {
    try {
      await owner.dependencies.eventLogRepo.append(params.entry);
    } catch (error) {
      owner.warn("embedding supplement telemetry failed", {
        workspace_id: params.workspaceId,
        run_id: params.runId,
        query_id: params.queryId,
        stage: params.stage,
        error: toErrorMessage(error)
      });
    }
  }
