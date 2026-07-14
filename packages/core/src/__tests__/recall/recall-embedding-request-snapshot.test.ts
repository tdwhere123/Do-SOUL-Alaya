import { describe, expect, it, vi } from "vitest";

import { EmbeddingRecallService } from "../../embedding-recall/embedding-recall-service.js";
import type { RecallServiceEmbeddingRecallPort } from "../../recall/runtime/recall-service-types.js";
import { RecallService } from "../../recall/recall-service.js";
import {
  createEmbeddingRecord,
  createProvider,
  hashMemoryContent
} from "../embedding-recall/embedding-recall-test-helpers.js";
import {
  createDependencies,
  createMemoryEntry,
  createPreparedQueryHandle,
  createTaskSurface,
  overridePolicy
} from "./recall-service-test-fixtures.js";

describe("RecallService embedding request score snapshot", () => {
  it("uses the request snapshot without invoking legacy supplement or pool scoring", async () => {
    const memory = createMemoryEntry({
      object_id: "snapshot-pool-memory",
      content: "Snapshot query procedure"
    });
    const { dependencies } = createDependencies([memory]);
    const prepareRecallEmbeddingSnapshot = vi.fn(async () => Object.freeze({
      workspaceId: "workspace-1",
      runId: null,
      queryId: "snapshot-query",
      poolScoresByObjectId: Object.freeze({ [memory.object_id]: 0.91 }),
      scoringLatencyMs: 0,
      workspaceNeighbors: Object.freeze({
        hits: Object.freeze([]),
        embedding_inference_calls: 1,
        query_embedding_cache_hit: false,
        query_embedding_status: "provider_returned" as const,
        query_embedding_degradation_reason: null
      }),
      degradedReason: null
    }));
    const materializeEmbeddingSupplementFromSnapshot = vi.fn(async () => ({
      supplementaryEntries: Object.freeze([]),
      similarityHintsByObjectId: Object.freeze({
        [memory.object_id]: Object.freeze({
          object_id: memory.object_id,
          normalized_similarity: 0.91
        })
      })
    }));
    const legacyPreparedQuery = createPreparedQueryHandle("legacy-query");
    const prepareQuerySupplement = vi.fn(async () => ({
      preparedQuery: legacyPreparedQuery,
      storedVectors: Object.freeze([]),
      degradedReason: null
    }));
    const querySupplementIfReady = vi.fn(async () => ({
      supplementaryEntries: Object.freeze([]),
      similarityHintsByObjectId: Object.freeze({})
    }));
    const scorePoolCandidates = vi.fn(async () => new Map([[memory.object_id, 0.5]]));
    const embeddingRecallService = {
      prepareRecallEmbeddingSnapshot,
      materializeEmbeddingSupplementFromSnapshot,
      prepareQuerySupplement,
      querySupplementIfReady,
      scorePoolCandidates,
      querySupplement: vi.fn(async () => ({
        supplementaryEntries: Object.freeze([]),
        similarityHintsByObjectId: Object.freeze({})
      }))
    } satisfies RecallServiceEmbeddingRecallPort;
    const service = new RecallService({ ...dependencies, embeddingRecallService });
    const taskSurface = { ...createTaskSurface(), display_name: "Snapshot query" };
    const basePolicy = service.buildDefaultPolicy("analyze", taskSurface.runtime_id);
    const policyOverride = overridePolicy(basePolicy, {
      coarse_filter: {
        ...basePolicy.coarse_filter,
        semantic_supplement: {
          ...basePolicy.coarse_filter.semantic_supplement,
          embedding_enabled: true,
          max_supplement: 5,
          injection_cap: 0
        }
      }
    });

    const result = await service.recall({
      taskSurface,
      workspaceId: "workspace-1",
      strategy: "analyze",
      policyOverride
    });

    expect(prepareRecallEmbeddingSnapshot).toHaveBeenCalledOnce();
    expect(prepareRecallEmbeddingSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      maxNeighbors: 0
    }));
    expect(materializeEmbeddingSupplementFromSnapshot).toHaveBeenCalledOnce();
    expect(prepareQuerySupplement).not.toHaveBeenCalled();
    expect(querySupplementIfReady).not.toHaveBeenCalled();
    expect(scorePoolCandidates).not.toHaveBeenCalled();
    expect(result.diagnostics?.token_economy?.embedding_inference_calls).toBe(1);
    expect(result.diagnostics?.embedding_provider_status).toBe("provider_returned");
    expect(result.candidates.find((candidate) => candidate.object_id === memory.object_id)
      ?.score_factors?.embedding_similarity).toBeCloseTo(0.91, 5);
  });

  it("keeps built-in pool scoring when supplement and injection caps are zero", async () => {
    const memory = createMemoryEntry({
      object_id: "zero-cap-pool-memory",
      content: "Zero cap query procedure"
    });
    const { dependencies } = createDependencies([memory]);
    const listByObjectIds = vi.fn(async () => [
      createEmbeddingRecord({
        object_id: memory.object_id,
        content_hash: hashMemoryContent(memory.content),
        embedding: new Float32Array([1, 0])
      })
    ]);
    const embedTexts = vi.fn(async () => [new Float32Array([1, 0])]);
    const embeddingRecallService = new EmbeddingRecallService({
      embeddingRepo: { listByObjectIds },
      provider: createProvider({ embedTexts }),
      eventLogRepo: dependencies.eventLogRepo,
      generateQueryId: () => "zero-cap-query"
    });
    const service = new RecallService({ ...dependencies, embeddingRecallService });
    const taskSurface = { ...createTaskSurface(), display_name: "Zero cap query" };
    const basePolicy = service.buildDefaultPolicy("analyze", taskSurface.runtime_id);
    const policyOverride = overridePolicy(basePolicy, {
      coarse_filter: {
        ...basePolicy.coarse_filter,
        semantic_supplement: {
          ...basePolicy.coarse_filter.semantic_supplement,
          embedding_enabled: true,
          max_supplement: 0,
          injection_cap: 0
        }
      }
    });

    const result = await service.recall({
      taskSurface,
      workspaceId: "workspace-1",
      strategy: "analyze",
      policyOverride
    });

    expect(listByObjectIds).toHaveBeenCalledOnce();
    expect(embedTexts).toHaveBeenCalledOnce();
    expect(result.candidates.find((candidate) => candidate.object_id === memory.object_id)
      ?.score_factors?.embedding_similarity).toBeCloseTo(1, 5);
  });

  it.each([
    ["provider_pending", "provider_pending", "query_embedding_pending"],
    ["provider_failed", "provider_failed", "provider_unavailable"],
    ["provider_not_requested", "provider_failed", "local_vector_lookup_failed"],
    ["provider_returned", "provider_returned", "local_vector_lookup_failed"]
  ] as const)(
    "projects snapshot %s diagnostics to %s without counting a second inference",
    async (snapshotProviderStatus, expectedProviderStatus, degradationReason) => {
      const memory = createMemoryEntry({ content: "Snapshot status query" });
      const { dependencies } = createDependencies([memory]);
      const embeddingRecallService = {
        prepareRecallEmbeddingSnapshot: vi.fn(async () => ({
          workspaceId: "workspace-1",
          runId: null,
          queryId: `snapshot-${snapshotProviderStatus}`,
          poolScoresByObjectId: Object.freeze({}),
          scoringLatencyMs: 0,
          workspaceNeighbors: Object.freeze({
            hits: Object.freeze([]),
            embedding_inference_calls: 0,
            query_embedding_cache_hit: false,
            query_embedding_status: snapshotProviderStatus,
            query_embedding_degradation_reason: degradationReason
          }),
          degradedReason: degradationReason
        })),
        materializeEmbeddingSupplementFromSnapshot: vi.fn(async () => ({
          supplementaryEntries: Object.freeze([]),
          similarityHintsByObjectId: Object.freeze({})
        })),
        querySupplement: vi.fn(async () => ({
          supplementaryEntries: Object.freeze([]),
          similarityHintsByObjectId: Object.freeze({})
        }))
      } satisfies RecallServiceEmbeddingRecallPort;
      const service = new RecallService({ ...dependencies, embeddingRecallService });
      const taskSurface = { ...createTaskSurface(), display_name: "Snapshot status query" };
      const basePolicy = service.buildDefaultPolicy("analyze", taskSurface.runtime_id);
      const policyOverride = overridePolicy(basePolicy, {
        coarse_filter: {
          ...basePolicy.coarse_filter,
          semantic_supplement: {
            ...basePolicy.coarse_filter.semantic_supplement,
            embedding_enabled: true,
            max_supplement: 5,
            injection_cap: 0
          }
        }
      });

      const result = await service.recall({
        taskSurface,
        workspaceId: "workspace-1",
        strategy: "analyze",
        policyOverride
      });

      expect(result.diagnostics?.embedding_provider_status).toBe(expectedProviderStatus);
      expect(result.diagnostics?.provider_degradation_reason).toBe(degradationReason);
      expect(result.diagnostics?.token_economy?.embedding_inference_calls).toBe(0);
    }
  );

  it("injects a snapshot-only neighbor when injection is enabled", async () => {
    const pooled = createMemoryEntry({
      object_id: "snapshot-native-pool",
      content: "Snapshot native query"
    });
    const neighbor = createMemoryEntry({
      object_id: "snapshot-native-neighbor",
      content: "Lexically unrelated Helsinki ledger",
      activation_score: 0.01
    });
    const { dependencies } = createDependencies([pooled]);
    const findByIds = vi.fn(async (_workspaceId: string, objectIds: readonly string[]) =>
      objectIds.includes(neighbor.object_id) ? [neighbor] : []
    );
    const prepareRecallEmbeddingSnapshot = vi.fn(async () => Object.freeze({
      workspaceId: "workspace-1",
      runId: null,
      queryId: "snapshot-native-query",
      poolScoresByObjectId: Object.freeze({ [pooled.object_id]: 0.8 }),
      scoringLatencyMs: 0,
      workspaceNeighbors: Object.freeze({
        hits: Object.freeze([{
          object_id: neighbor.object_id,
          normalized_similarity: 0.96,
          content_hash: hashMemoryContent(neighbor.content)
        }]),
        embedding_inference_calls: 1,
        query_embedding_cache_hit: false,
        query_embedding_status: "provider_returned" as const,
        query_embedding_degradation_reason: null
      }),
      degradedReason: null
    }));
    const embeddingRecallService = {
      prepareRecallEmbeddingSnapshot,
      materializeEmbeddingSupplementFromSnapshot: vi.fn(async () => ({
        supplementaryEntries: Object.freeze([]),
        similarityHintsByObjectId: Object.freeze({})
      })),
      querySupplement: vi.fn(async () => ({
        supplementaryEntries: Object.freeze([]),
        similarityHintsByObjectId: Object.freeze({})
      }))
    } satisfies RecallServiceEmbeddingRecallPort;
    const service = new RecallService({
      ...dependencies,
      memoryRepo: { ...dependencies.memoryRepo, findByIds },
      embeddingRecallService
    });
    const taskSurface = { ...createTaskSurface(), display_name: "Snapshot native query" };
    const basePolicy = service.buildDefaultPolicy("analyze", taskSurface.runtime_id);
    const policyOverride = overridePolicy(basePolicy, {
      coarse_filter: {
        ...basePolicy.coarse_filter,
        precomputed_rank: {
          ...basePolicy.coarse_filter.precomputed_rank,
          min_activation_score: 0.5
        },
        semantic_supplement: {
          ...basePolicy.coarse_filter.semantic_supplement,
          embedding_enabled: true,
          max_supplement: 5,
          injection_cap: 1
        }
      }
    });

    const result = await service.recall({
      taskSurface,
      workspaceId: "workspace-1",
      strategy: "analyze",
      policyOverride
    });

    expect(prepareRecallEmbeddingSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      maxNeighbors: 5
    }));
    expect(findByIds).toHaveBeenCalledWith("workspace-1", [neighbor.object_id]);
    expect(result.candidates.find((candidate) => candidate.object_id === neighbor.object_id)
      ?.source_channels).toContain("semantic_supplement");
  });
});
