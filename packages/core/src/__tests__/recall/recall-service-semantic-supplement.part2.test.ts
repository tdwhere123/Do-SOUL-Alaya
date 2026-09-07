import { describe, expect, it, vi } from "vitest";
import { collectEmbeddingSupplement } from "../../recall/supplements/supplements.js";
import { buildRecallPolicy } from "../../shared/recall-policy.js";
import { createMemoryEntry } from "./recall-service-test-fixtures.js";

describe("retained component contracts", () => {
it("falls back to the legacy embedding supplement when prepared APIs are unavailable", async () => {
    const memory = createMemoryEntry({ object_id: "memory-legacy-supplement" });
    const querySupplement = vi.fn(async () => ({
      supplementaryEntries: Object.freeze([memory]),
      similarityHintsByObjectId: Object.freeze({
        [memory.object_id]: Object.freeze({
          object_id: memory.object_id,
          normalized_similarity: 0.8
        })
      })
    }));
    const policy = buildRecallPolicy({
      runtimeId: "policy-legacy-supplement",
      taskSurfaceId: "surface-legacy-supplement",
      maxResults: 5,
      filters: { scopeFilter: null, dimensionFilter: null, domainTagFilter: null },
      conflictAwareness: true,
      maxTotalTokens: 2_000,
      embeddingSupplementEnabled: true
    });

    const result = await collectEmbeddingSupplement({
      dependencies: { embeddingRecallService: { querySupplement } },
      baseCandidateIds: Object.freeze([]),
      localEligibleCandidates: Object.freeze([{ entry: memory }]),
      config: {
        ...policy,
        coarse_filter: {
          ...policy.coarse_filter,
          semantic_supplement: {
            ...policy.coarse_filter.semantic_supplement,
            embedding_enabled: true
          }
        }
      },
      workspaceId: "workspace-1",
      runId: null,
      queryText: "legacy supplement",
      preparedEmbeddingQuery: null,
      preparedStoredVectors: null,
      preparedSupplementSupported: false
    });

    expect(querySupplement).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      runId: null,
      queryText: "legacy supplement",
      eligibleMemories: [memory],
      baseCandidateIds: [],
      maxSupplement: policy.coarse_filter.semantic_supplement.max_supplement
    });
    expect(result.supplementaryEntries).toEqual([memory]);
    expect(result.collectionStatus).toBe("requested");
  });

it("distinguishes disabled, missing-provider, empty-pool, and not-attempted supplement exits", async () => {
    const memory = createMemoryEntry({ object_id: "memory-supplement-status" });
    const querySupplement = vi.fn(async () => ({
      supplementaryEntries: Object.freeze([]),
      similarityHintsByObjectId: Object.freeze({})
    }));
    const policy = buildRecallPolicy({
      runtimeId: "policy-supplement-status",
      taskSurfaceId: "surface-supplement-status",
      maxResults: 5,
      filters: { scopeFilter: null, dimensionFilter: null, domainTagFilter: null },
      conflictAwareness: true,
      maxTotalTokens: 2_000,
      embeddingSupplementEnabled: true
    });
    const base = {
      baseCandidateIds: Object.freeze([]),
      localEligibleCandidates: Object.freeze([{ entry: memory }]),
      config: policy,
      workspaceId: "workspace-1",
      runId: null,
      queryText: "supplement status",
      preparedEmbeddingQuery: null,
      preparedStoredVectors: null,
      preparedSupplementSupported: false
    } as const;

    const providerMissing = await collectEmbeddingSupplement({
      ...base,
      dependencies: {}
    });
    const disabled = await collectEmbeddingSupplement({
      ...base,
      dependencies: { embeddingRecallService: { querySupplement } },
      config: {
        ...policy,
        coarse_filter: {
          ...policy.coarse_filter,
          semantic_supplement: {
            ...policy.coarse_filter.semantic_supplement,
            embedding_enabled: false
          }
        }
      }
    });
    const emptyPool = await collectEmbeddingSupplement({
      ...base,
      dependencies: { embeddingRecallService: { querySupplement } },
      localEligibleCandidates: Object.freeze([])
    });
    const notAttempted = await collectEmbeddingSupplement({
      ...base,
      dependencies: { embeddingRecallService: { querySupplement } },
      preparedSupplementSupported: true
    });

    expect(providerMissing.collectionStatus).toBe("provider_missing");
    expect(disabled.collectionStatus).toBe("disabled");
    expect(emptyPool.collectionStatus).toBe("empty_candidate_pool");
    expect(notAttempted.collectionStatus).toBe("not_attempted");
    expect(notAttempted.supplementaryEntries).toEqual([]);
    expect(querySupplement).not.toHaveBeenCalled();
  });
});
