import {
  ComputeRecallGardenEventType,
  RecallEmbeddingSupplementMergedPayloadSchema,
  RecallEmbeddingSupplementQueriedPayloadSchema,
  type MemoryEntry
} from "@do-soul/alaya-protocol";

import type { EmbeddingRecallTelemetry } from "./embedding-recall-telemetry.js";
import { clamp01, cosineSimilarity, hashMemoryContent } from "./helpers.js";
import type {
  EmbeddingProviderPort,
  EmbeddingRecallSupplementResult,
  EmbeddingSimilarityHint,
  EmbeddingVectorRecord
} from "./types.js";

export interface SupplementBuilderDependencies {
  readonly provider: EmbeddingProviderPort;
  readonly now: () => string;
  readonly telemetry: EmbeddingRecallTelemetry;
}

export interface BuildSupplementFromQueryEmbeddingParams {
  readonly workspaceId: string;
  readonly runId: string | null;
  readonly queryId: string;
  readonly queryEmbedding: Float32Array;
  readonly storedVectors: readonly Readonly<EmbeddingVectorRecord>[];
  readonly eligibleMemories: readonly Readonly<MemoryEntry>[];
  readonly baseCandidateIds: readonly string[];
  readonly maxSupplement: number;
}

// Ranks stored vectors against the query embedding, emits queried/merged
// telemetry, and selects the additive supplement set.
export class EmbeddingSupplementBuilder {
  public constructor(private readonly deps: SupplementBuilderDependencies) {}

  public async buildSupplementFromQueryEmbedding(
    params: BuildSupplementFromQueryEmbeddingParams
  ): Promise<EmbeddingRecallSupplementResult> {
    const startedAtEpochMs = Date.now();
    const eligibleMemoryMap = new Map(
      params.eligibleMemories.map((memory) => [memory.object_id, memory] as const)
    );
    const hints = this.collectEmbeddingSimilarityHints(params, eligibleMemoryMap);
    const latencyMs = Math.max(0, Date.now() - startedAtEpochMs);
    await this.appendSupplementQueriedTelemetry(params, hints.length, latencyMs);

    const supplementaryEntries = selectSupplementaryEntries(params, hints, eligibleMemoryMap);
    await this.appendSupplementMergedTelemetry(params, supplementaryEntries.length);

    return Object.freeze({
      supplementaryEntries: Object.freeze([...supplementaryEntries]),
      similarityHintsByObjectId: Object.freeze(
        Object.fromEntries(hints.map((hint) => [hint.object_id, hint] as const))
      )
    });
  }

  private collectEmbeddingSimilarityHints(
    params: BuildSupplementFromQueryEmbeddingParams,
    eligibleMemoryMap: ReadonlyMap<string, Readonly<MemoryEntry>>
  ): readonly Readonly<EmbeddingSimilarityHint>[] {
    return params.storedVectors
      .filter(
        (record) =>
          record.provider_kind === this.deps.provider.providerKind &&
          record.model_id === this.deps.provider.modelId &&
          record.schema_version === this.deps.provider.schemaVersion &&
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

  private async appendSupplementQueriedTelemetry(
    params: BuildSupplementFromQueryEmbeddingParams,
    returnedCandidateCount: number,
    latencyMs: number
  ): Promise<void> {
    await this.deps.telemetry.appendTelemetrySafely({
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
          queried_at: this.deps.now()
        })
      }
    });
  }

  private async appendSupplementMergedTelemetry(
    params: BuildSupplementFromQueryEmbeddingParams,
    supplementCandidateCount: number
  ): Promise<void> {
    await this.deps.telemetry.appendTelemetrySafely({
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
          merged_at: this.deps.now()
        })
      }
    });
  }
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
