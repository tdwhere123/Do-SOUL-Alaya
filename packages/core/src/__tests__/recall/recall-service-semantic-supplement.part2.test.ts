import { describe, expect, it, vi } from "vitest";
import { MemoryDimension, ScopeClass } from "@do-soul/alaya-protocol";
import { RecallService } from "../../recall/recall-service.js";
import { collectEmbeddingSupplement } from "../../recall/supplements/supplements.js";
import { buildRecallPolicy } from "../../shared/recall-policy.js";
import type { EmbeddingVectorRecord } from "../../embedding-recall/embedding-recall-service.js";
import { createDependencies, createMemoryEntry, createPreparedQueryHandle, createTaskSurface, overridePolicy } from "./recall-service-test-fixtures.js";

describe("RecallService", () => {
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

  it("distinguishes disabled, missing-provider, and empty-pool supplement exits", async () => {
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

    expect(providerMissing.collectionStatus).toBe("provider_missing");
    expect(disabled.collectionStatus).toBe("disabled");
    expect(emptyPool.collectionStatus).toBe("empty_candidate_pool");
    expect(querySupplement).not.toHaveBeenCalled();
  });

it("handles overlapped embedding preparation rejection when vector precheck fails", async () => {
    const memories = [
      createMemoryEntry({
        object_id: "memory-lexical",
        dimension: MemoryDimension.PROCEDURE,
        activation_score: 0.9,
        content: "Lexical baseline procedure."
      })
    ];
    const { dependencies } = createDependencies(memories);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    const hasStoredVectors = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      throw new Error("unexpected vector precheck failure");
    });
    const service = new RecallService({
      ...dependencies,
      embeddingRecallService: {
        hasStoredVectors,
        prepareQueryEmbedding: vi.fn(() => createPreparedQueryHandle("prepared-query-unused")),
        querySupplementIfReady: vi.fn(async () => ({
          supplementaryEntries: Object.freeze([]),
          similarityHintsByObjectId: Object.freeze({})
        })),
        querySupplement: vi.fn(async () => ({
          supplementaryEntries: Object.freeze([]),
          similarityHintsByObjectId: Object.freeze({})
        }))
      }
    });
    const basePolicy = service.buildDefaultPolicy("analyze", createTaskSurface().runtime_id);
    const policy = overridePolicy(basePolicy, {
      coarse_filter: {
        ...basePolicy.coarse_filter,
        semantic_supplement: {
          ...basePolicy.coarse_filter.semantic_supplement,
          embedding_enabled: true
        }
      }
    });

    try {
      await expect(
        service.recall({
          taskSurface: createTaskSurface(),
          workspaceId: "workspace-1",
          strategy: "analyze",
          policyOverride: policy
        })
      ).rejects.toThrow("unexpected vector precheck failure");
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(hasStoredVectors).toHaveBeenCalled();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

it("uses prepared embedding supplements without the legacy query-embedding port", async () => {
    const memories = [
      createMemoryEntry({
        object_id: "memory-lexical",
        dimension: MemoryDimension.PROCEDURE,
        activation_score: 0.9,
        content: "Lexical baseline procedure."
      })
    ];
    const { dependencies } = createDependencies(memories);
    const preparedQuery = createPreparedQueryHandle("prepared-query-supplement-only");
    const storedVectors: readonly Readonly<EmbeddingVectorRecord>[] = Object.freeze([
      {
        object_id: "memory-lexical",
        workspace_id: "workspace-1",
        content_hash: "hash-memory-lexical",
        provider_kind: "openai",
        model_id: "text-embedding-3-small",
        schema_version: 1,
        dimensions: 2,
        embedding: new Float32Array([1, 0]),
        created_at: "2026-04-23T00:00:00.000Z",
        updated_at: "2026-04-23T00:00:00.000Z"
      }
    ]);
    const prepareQuerySupplement = vi.fn(async () => ({
      preparedQuery,
      storedVectors,
      degradedReason: null
    }));
    const querySupplementIfReady = vi.fn(async () => ({
      supplementaryEntries: Object.freeze([]),
      similarityHintsByObjectId: Object.freeze({})
    }));
    const service = new RecallService({
      ...dependencies,
      embeddingRecallService: {
        prepareQuerySupplement,
        querySupplementIfReady,
        querySupplement: vi.fn(async () => ({
          supplementaryEntries: Object.freeze([]),
          similarityHintsByObjectId: Object.freeze({})
        }))
      }
    });
    const basePolicy = service.buildDefaultPolicy("analyze", createTaskSurface().runtime_id);
    const policy = overridePolicy(basePolicy, {
      coarse_filter: {
        ...basePolicy.coarse_filter,
        semantic_supplement: {
          ...basePolicy.coarse_filter.semantic_supplement,
          embedding_enabled: true
        }
      }
    });

    await service.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "analyze",
      policyOverride: policy
    });

    expect(prepareQuerySupplement).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      runId: null,
      queryText: "Implement recall",
      eligibleMemories: expect.arrayContaining([
        expect.objectContaining({ object_id: "memory-lexical" })
      ]),
      baseCandidateCount: 1
    });
    expect(querySupplementIfReady).toHaveBeenCalledWith(
      expect.objectContaining({
        preparedQuery,
        storedVectors
      })
    );
  });

it("merges keyword supplement candidates without duplicating deterministic matches", async () => {
    const memories = [
      createMemoryEntry({ object_id: "memory-1", scope_class: ScopeClass.PROJECT, dimension: MemoryDimension.PROCEDURE, activation_score: 0.9 }),
      createMemoryEntry({ object_id: "memory-2", scope_class: ScopeClass.GLOBAL_DOMAIN, dimension: MemoryDimension.PROCEDURE, activation_score: 0.2 })
    ];
    const { dependencies } = createDependencies(memories);
    const searchByKeyword = vi.fn(async () => [
      { object_id: "memory-1", normalized_rank: 1 },
      { object_id: "memory-2", normalized_rank: 0.5 }
    ]);
    const service = new RecallService({
      ...dependencies,
      memoryRepo: {
        ...dependencies.memoryRepo,
        searchByKeyword
      }
    });
    const basePolicy = service.buildDefaultPolicy("build", createTaskSurface().runtime_id);
    const policy = overridePolicy(basePolicy, {
      coarse_filter: {
        ...basePolicy.coarse_filter,
        semantic_supplement: {
          enabled: true,
          max_supplement: 5
        }
      }
    });

    const result = await service.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "build",
      policyOverride: policy
    });

    expect(searchByKeyword).toHaveBeenCalledWith("workspace-1", "Implement recall", 5);
    expect(new Set(result.candidates.map((candidate) => candidate.object_id))).toEqual(
      new Set(["memory-1", "memory-2"])
    );
    expect(result.candidates).toHaveLength(2);
  });

it("uses direct lexical FTS rank as lexical structural evidence", async () => {
    const memories = [
      createMemoryEntry({
        object_id: "memory-alpha",
        activation_score: 0.6,
        content: "unrelated first memory body."
      }),
      createMemoryEntry({
        object_id: "memory-beta",
        activation_score: 0.6,
        content: "unrelated second memory body."
      })
    ];
    const { dependencies } = createDependencies(memories);
    const searchByKeyword = vi.fn(async () => [
      { object_id: "memory-alpha", normalized_rank: 1 },
      { object_id: "memory-beta", normalized_rank: 0.8 }
    ]);
    const service = new RecallService({
      ...dependencies,
      memoryRepo: {
        ...dependencies.memoryRepo,
        searchByKeyword
      }
    });
    const taskSurface = {
      ...createTaskSurface(),
      display_name: "alpha beta gamma"
    };

    const result = await service.recall({
      taskSurface,
      workspaceId: "workspace-1",
      strategy: "chat"
    });

    const alphaDiagnostic = result.diagnostics?.candidates.find(
      (candidate) => candidate.object_id === "memory-alpha"
    );
    const betaDiagnostic = result.diagnostics?.candidates.find(
      (candidate) => candidate.object_id === "memory-beta"
    );
    expect(alphaDiagnostic?.lexical_rank).toBe(1);
    expect(betaDiagnostic?.lexical_rank).toBe(0.8);
    expect(alphaDiagnostic?.structural_score).toBe(1);
    expect(betaDiagnostic?.structural_score).toBe(0.8);
  });

it("ranks the trigram_fts fusion stream from keyword-search trigram_rank", async () => {
    const memories = [
      createMemoryEntry({
        object_id: "memory-trigram-strong",
        activation_score: 0.6,
        content: "unrelated first memory body."
      }),
      createMemoryEntry({
        object_id: "memory-trigram-weak",
        activation_score: 0.6,
        content: "unrelated second memory body."
      }),
      createMemoryEntry({
        object_id: "memory-no-trigram",
        activation_score: 0.6,
        content: "unrelated third memory body."
      })
    ];
    const { dependencies } = createDependencies(memories);
    const searchByKeyword = vi.fn(async () => [
      { object_id: "memory-trigram-strong", normalized_rank: 0.9, trigram_rank: 1 },
      { object_id: "memory-trigram-weak", normalized_rank: 0.9, trigram_rank: 0.4 },
      { object_id: "memory-no-trigram", normalized_rank: 0.9 }
    ]);
    const service = new RecallService({
      ...dependencies,
      memoryRepo: {
        ...dependencies.memoryRepo,
        searchByKeyword
      }
    });

    const result = await service.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "chat"
    });

    const strong = result.diagnostics?.candidates.find(
      (candidate) => candidate.object_id === "memory-trigram-strong"
    );
    const weak = result.diagnostics?.candidates.find(
      (candidate) => candidate.object_id === "memory-trigram-weak"
    );
    const absent = result.diagnostics?.candidates.find(
      (candidate) => candidate.object_id === "memory-no-trigram"
    );
    // A higher trigram_rank wins a lower (better) trigram_fts ordinal rank.
    expect(strong?.per_stream_rank.trigram_fts).toBe(1);
    expect(weak?.per_stream_rank.trigram_fts).toBe(2);
    // No trigram_rank on the hit means the trigram_fts stream stays unranked.
    expect(absent?.per_stream_rank.trigram_fts).toBeNull();
  });

it("ranks the trigram_fts fusion stream through the production within-object-ids supplement path", async () => {
    const memories = [
      createMemoryEntry({
        object_id: "memory-trigram-strong",
        activation_score: 0.6,
        content: "unrelated first memory body."
      }),
      createMemoryEntry({
        object_id: "memory-trigram-weak",
        activation_score: 0.6,
        content: "unrelated second memory body."
      }),
      createMemoryEntry({
        object_id: "memory-no-trigram",
        activation_score: 0.6,
        content: "unrelated third memory body."
      })
    ];
    const { dependencies } = createDependencies(memories);
    // Production `MemoryEntryRepo` implements `searchByKeywordWithinObjectIds`,
    // so recall always takes that branch rather than the `searchByKeyword`
    // fallback. Mock it directly to exercise the path bench actually runs.
    const searchByKeywordWithinObjectIds = vi.fn(async () => [
      { object_id: "memory-trigram-strong", normalized_rank: 0.9, trigram_rank: 1 },
      { object_id: "memory-trigram-weak", normalized_rank: 0.9, trigram_rank: 0.4 },
      { object_id: "memory-no-trigram", normalized_rank: 0.9 }
    ]);
    const service = new RecallService({
      ...dependencies,
      memoryRepo: {
        ...dependencies.memoryRepo,
        searchByKeywordWithinObjectIds
      }
    });

    const result = await service.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "chat"
    });

    expect(searchByKeywordWithinObjectIds).toHaveBeenCalled();
    const strong = result.diagnostics?.candidates.find(
      (candidate) => candidate.object_id === "memory-trigram-strong"
    );
    const weak = result.diagnostics?.candidates.find(
      (candidate) => candidate.object_id === "memory-trigram-weak"
    );
    const absent = result.diagnostics?.candidates.find(
      (candidate) => candidate.object_id === "memory-no-trigram"
    );
    // A higher trigram_rank wins a lower (better) trigram_fts ordinal rank,
    // proving the production supplement path feeds trigramFtsRanks all the way
    // through to the per_stream_rank.trigram_fts diagnostic.
    expect(strong?.per_stream_rank.trigram_fts).toBe(1);
    expect(weak?.per_stream_rank.trigram_fts).toBe(2);
    // No trigram_rank on the hit means the trigram_fts stream stays unranked.
    expect(absent?.per_stream_rank.trigram_fts).toBeNull();
  });

});
