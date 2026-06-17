import { describe, expect, it, vi } from "vitest";
import {
  MemoryDimension,
  ScopeClass,
} from "@do-soul/alaya-protocol";
import { RecallService } from "../../recall/recall-service.js";
import type { EmbeddingVectorRecord } from "../../embedding-recall/embedding-recall-service.js";
import { createDependencies, createMemoryEntry, createPreparedQueryHandle, createTaskSurface, overridePolicy } from "./recall-service-test-fixtures.js";

describe("RecallService", () => {
  it("buildDefaultPolicy keeps the keyword supplement enabled for chat and analyze", () => {
    const { dependencies } = createDependencies([]);
    const service = new RecallService(dependencies);

    expect(service.buildDefaultPolicy("chat", createTaskSurface().runtime_id).coarse_filter.semantic_supplement).toEqual({
      enabled: true,
      max_supplement: 5,
      embedding_enabled: false
    });
    expect(service.buildDefaultPolicy("analyze", createTaskSurface().runtime_id).coarse_filter.semantic_supplement).toEqual({
      enabled: true,
      max_supplement: 5,
      embedding_enabled: false
    });
  });

  it("does not invoke embedding supplement work under the default policy", async () => {
    const memories = [
      createMemoryEntry({
        object_id: "memory-lexical",
        dimension: MemoryDimension.PROCEDURE,
        activation_score: 0.9,
        content: "Lexical baseline procedure."
      })
    ];
    const { dependencies } = createDependencies(memories);
    const hasStoredVectors = vi.fn(async () => true);
    const prepareQueryEmbedding = vi.fn(() => createPreparedQueryHandle("prepared-query-unused"));
    const querySupplementIfReady = vi.fn(async () => ({
      supplementaryEntries: Object.freeze([]),
      similarityHintsByObjectId: Object.freeze({})
    }));
    const service = new RecallService({
      ...dependencies,
      embeddingRecallService: {
        hasStoredVectors,
        prepareQueryEmbedding,
        querySupplementIfReady,
        querySupplement: vi.fn(async () => ({
          supplementaryEntries: Object.freeze([]),
          similarityHintsByObjectId: Object.freeze({})
        }))
      }
    });

    await service.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "analyze"
    });

    expect(hasStoredVectors).not.toHaveBeenCalled();
    expect(prepareQueryEmbedding).not.toHaveBeenCalled();
    expect(querySupplementIfReady).not.toHaveBeenCalled();
  });

  it("keeps the lexical baseline when the semantic supplement exhausts no remaining budget", async () => {
    const memories = [
      createMemoryEntry({
        object_id: "memory-lexical",
        dimension: MemoryDimension.PROCEDURE,
        activation_score: 0.9,
        content: "Lexical baseline procedure."
      }),
      createMemoryEntry({
        object_id: "memory-semantic",
        dimension: MemoryDimension.PROCEDURE,
        activation_score: 0.05,
        content: "Semantic supplement memory."
      })
    ];
    const { dependencies } = createDependencies(memories);
    const preparedQuery = createPreparedQueryHandle("prepared-query-1");
    const querySupplement = vi.fn(async (_params: unknown) => ({
      supplementaryEntries: Object.freeze([memories[1]!]),
      similarityHintsByObjectId: Object.freeze({
        "memory-lexical": Object.freeze({
          object_id: "memory-lexical",
          normalized_similarity: 0.1
        }),
        "memory-semantic": Object.freeze({
          object_id: "memory-semantic",
          normalized_similarity: 0.95
        })
      })
    }));
    const service = new RecallService({
      ...dependencies,
      embeddingRecallService: {
        hasStoredVectors: vi.fn(async () => true),
        prepareQueryEmbedding: vi.fn(() => preparedQuery),
        querySupplementIfReady: vi.fn(async (params) => {
          expect(params.preparedQuery).toBe(preparedQuery);
          return await querySupplement(params);
        }),
        querySupplement
      }
    });
    const basePolicy = service.buildDefaultPolicy("analyze", createTaskSurface().runtime_id);
    const policy = overridePolicy(basePolicy, {
      coarse_filter: {
        ...basePolicy.coarse_filter,
        semantic_supplement: {
          enabled: true,
          max_supplement: 5,
          embedding_enabled: true
        }
      },
      fine_assessment: {
        ...basePolicy.fine_assessment,
        budgets: {
          max_entries: 1,
          max_total_tokens: 1000,
          per_dimension_limits: null
        }
      }
    });

    const result = await service.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "analyze",
      policyOverride: policy
    });

    expect(querySupplement).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        maxSupplement: 5,
        baseCandidateIds: ["memory-lexical"],
        eligibleMemories: expect.arrayContaining([
          expect.objectContaining({ object_id: "memory-lexical" }),
          expect.objectContaining({ object_id: "memory-semantic" })
        ])
      })
    );
    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual(["memory-lexical"]);
  });

  it("rebuilds budget state after embedding boost without overriding a strong lexical rank", async () => {
    const memories = [
      createMemoryEntry({
        object_id: "memory-first-lexical",
        dimension: MemoryDimension.PROCEDURE,
        activation_score: 0.8,
        content: "Lexical baseline procedure."
      }),
      createMemoryEntry({
        object_id: "memory-second-semantic",
        dimension: MemoryDimension.PROCEDURE,
        activation_score: 0.1,
        content: "Semantic supplement procedure."
      })
    ];
    const { dependencies } = createDependencies(memories);
    dependencies.memoryRepo.searchByKeywordWithinObjectIds = vi.fn(async () => [
      { object_id: "memory-first-lexical", normalized_rank: 1 }
    ]);
    const preparedQuery = createPreparedQueryHandle("prepared-query-budget-state");
    const service = new RecallService({
      ...dependencies,
      embeddingRecallService: {
        hasStoredVectors: vi.fn(async () => true),
        prepareQueryEmbedding: vi.fn(() => preparedQuery),
        querySupplementIfReady: vi.fn(async () => ({
          supplementaryEntries: Object.freeze([]),
          similarityHintsByObjectId: Object.freeze({
            "memory-first-lexical": Object.freeze({
              object_id: "memory-first-lexical",
              normalized_similarity: 0
            }),
            "memory-second-semantic": Object.freeze({
              object_id: "memory-second-semantic",
              normalized_similarity: 1
            })
          })
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
          enabled: true,
          max_supplement: 5,
          embedding_enabled: true
        }
      },
      fine_assessment: {
        ...basePolicy.fine_assessment,
        budgets: {
          max_entries: 2,
          max_total_tokens: 1000,
          per_dimension_limits: null
        }
      }
    });

    const result = await service.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "analyze",
      policyOverride: policy
    });

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
      "memory-first-lexical",
      "memory-second-semantic"
    ]);
    expect(result.candidates[0]?.budget_state).toMatchObject({
      token_estimate: result.candidates[0]?.token_estimate,
      remaining_entries: 1,
      within_budget: true
    });
    expect(result.candidates[1]?.budget_state).toMatchObject({
      token_estimate: result.candidates[1]?.token_estimate,
      remaining_entries: 0,
      within_budget: true
    });
  });

  it("allows an embedding-boosted supplement to replace a weaker lexical candidate within the delivery budget", async () => {
    const memories = [
      createMemoryEntry({
        object_id: "memory-lexical",
        dimension: MemoryDimension.PROCEDURE,
        activation_score: 0.2,
        content: "Lexical baseline procedure."
      }),
      createMemoryEntry({
        object_id: "memory-semantic",
        dimension: MemoryDimension.PROCEDURE,
        activation_score: 0.19,
        content: "Semantically relevant procedure."
      })
    ];
    const { dependencies } = createDependencies(memories);
    const preparedQuery = createPreparedQueryHandle("prepared-query-replace");
    const querySupplementIfReady = vi.fn(async () => ({
      supplementaryEntries: Object.freeze([memories[1]!]),
      similarityHintsByObjectId: Object.freeze({
        "memory-lexical": Object.freeze({
          object_id: "memory-lexical",
          normalized_similarity: 0
        }),
        "memory-semantic": Object.freeze({
          object_id: "memory-semantic",
          normalized_similarity: 1
        })
      })
    }));
    const service = new RecallService({
      ...dependencies,
      embeddingRecallService: {
        hasStoredVectors: vi.fn(async () => true),
        prepareQueryEmbedding: vi.fn(() => preparedQuery),
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
        precomputed_rank: {
          max_candidates: 2,
          min_activation_score: null
        },
        semantic_supplement: {
          enabled: true,
          max_supplement: 1,
          embedding_enabled: true
        }
      },
      fine_assessment: {
        ...basePolicy.fine_assessment,
        budgets: {
          max_entries: 1,
          max_total_tokens: 1000,
          per_dimension_limits: null
        }
      }
    });

    const result = await service.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "analyze",
      policyOverride: policy
    });

    expect(querySupplementIfReady).toHaveBeenCalledWith(
      expect.objectContaining({
        eligibleMemories: expect.arrayContaining([
          expect.objectContaining({ object_id: "memory-lexical" }),
          expect.objectContaining({ object_id: "memory-semantic" })
        ])
      })
    );
    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
      "memory-semantic"
    ]);
    expect(result.candidates[0]?.score_factors?.embedding_similarity).toBe(1);
  });

  it("skips prepared embedding work when no stored vectors exist for eligible memories", async () => {
    const memories = [
      createMemoryEntry({
        object_id: "memory-lexical",
        dimension: MemoryDimension.PROCEDURE,
        activation_score: 0.9,
        content: "Lexical baseline procedure."
      })
    ];
    const { dependencies } = createDependencies(memories);
    const hasStoredVectors = vi.fn(async () => false);
    const prepareQueryEmbedding = vi.fn(() => createPreparedQueryHandle("prepared-query-unused"));
    const querySupplementIfReady = vi.fn(async () => ({
      supplementaryEntries: Object.freeze([]),
      similarityHintsByObjectId: Object.freeze({})
    }));
    const service = new RecallService({
      ...dependencies,
      embeddingRecallService: {
        hasStoredVectors,
        prepareQueryEmbedding,
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

    expect(hasStoredVectors).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      eligibleMemories: expect.arrayContaining([
        expect.objectContaining({ object_id: "memory-lexical" })
      ])
    });
    expect(prepareQueryEmbedding).not.toHaveBeenCalled();
    expect(querySupplementIfReady).not.toHaveBeenCalled();
  });

  it("fails closed and records degraded telemetry when the stored-vector precheck errors", async () => {
    const memories = [
      createMemoryEntry({
        object_id: "memory-lexical",
        dimension: MemoryDimension.PROCEDURE,
        activation_score: 0.9,
        content: "Lexical baseline procedure."
      }),
      createMemoryEntry({
        object_id: "memory-secondary",
        dimension: MemoryDimension.PROCEDURE,
        activation_score: 0.5,
        content: "Secondary lexical candidate."
      }),
      createMemoryEntry({
        object_id: "memory-third",
        dimension: MemoryDimension.PROCEDURE,
        activation_score: 0.2,
        content: "Third lexical candidate."
      })
    ];
    const { dependencies } = createDependencies(memories);
    const hasStoredVectors = vi.fn(async () => {
      throw Object.assign(new Error("vector table unavailable"), {
        reason: "local_vector_lookup_failed"
      });
    });
    const recordPrecheckDegraded = vi.fn(async () => undefined);
    const prepareQueryEmbedding = vi.fn(() => createPreparedQueryHandle("prepared-query-unused"));
    const querySupplementIfReady = vi.fn(async () => ({
      supplementaryEntries: Object.freeze([]),
      similarityHintsByObjectId: Object.freeze({})
    }));
    const service = new RecallService({
      ...dependencies,
      embeddingRecallService: {
        hasStoredVectors,
        recordPrecheckDegraded,
        prepareQueryEmbedding,
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
      },
      fine_assessment: {
        ...basePolicy.fine_assessment,
        budgets: {
          max_entries: 1,
          max_total_tokens: 1000,
          per_dimension_limits: null
        }
      }
    });

    const result = await service.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "analyze",
      policyOverride: policy
    });

    expect(hasStoredVectors).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      eligibleMemories: expect.arrayContaining([
        expect.objectContaining({ object_id: "memory-lexical" })
      ])
    });
    expect(recordPrecheckDegraded).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      runId: null,
      reason: "local_vector_lookup_failed",
      baseCandidateCount: 1,
      fallbackCandidateCount: 1
    });
    expect(result.diagnostics?.embedding_provider_status).toBe("provider_failed");
    expect(result.diagnostics?.provider_degradation_reason).toBe(
      "local_vector_lookup_failed"
    );
    expect(prepareQueryEmbedding).not.toHaveBeenCalled();
    expect(querySupplementIfReady).not.toHaveBeenCalled();
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

  it("merges semantic supplement candidates without duplicating existing matches", async () => {
    const memories = [
      createMemoryEntry({
        object_id: "memory-1",
        dimension: MemoryDimension.PROCEDURE,
        activation_score: 0.2,
        content: "General workspace procedure."
      }),
      createMemoryEntry({
        object_id: "memory-2",
        dimension: MemoryDimension.PREFERENCE,
        activation_score: 0.2,
        content: "Implement recall supplement."
      })
    ];
    const { dependencies } = createDependencies(memories);
    const searchByKeyword = vi.fn(async () => [
      { object_id: "memory-1", normalized_rank: 0.1 },
      { object_id: "memory-2", normalized_rank: 1.0 }
    ]);
    dependencies.memoryRepo.searchByKeyword = searchByKeyword;
    const service = new RecallService(dependencies);
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
    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual(["memory-2", "memory-1"]);
    expect(new Set(result.candidates.map((candidate) => candidate.object_id)).size).toBe(result.candidates.length);
  });

  it("uses the hot-memory supplement search when available so short-token fallback cannot starve live matches", async () => {
    const memories = [
      createMemoryEntry({
        object_id: "memory-hot",
        dimension: MemoryDimension.PREFERENCE,
        activation_score: 0.2,
        content: "Go keep the hot supplement candidate alive."
      })
    ];
    const { dependencies } = createDependencies(memories);
    const searchByKeyword = vi.fn(async () => [
      { object_id: "memory-cold-1", normalized_rank: 1 },
      { object_id: "memory-cold-2", normalized_rank: 1 }
    ]);
    const searchByKeywordWithinObjectIds = vi.fn(async () => [
      { object_id: "memory-hot", normalized_rank: 1 }
    ]);
    const service = new RecallService({
      ...dependencies,
      memoryRepo: {
        ...dependencies.memoryRepo,
        searchByKeyword,
        searchByKeywordWithinObjectIds
      }
    });
    const basePolicy = service.buildDefaultPolicy("chat", createTaskSurface().runtime_id);
    const policy = overridePolicy(basePolicy, {
      coarse_filter: {
        ...basePolicy.coarse_filter,
        semantic_supplement: {
          enabled: true,
          max_supplement: 5
        }
      }
    });
    const taskSurface = {
      ...createTaskSurface(),
      display_name: "Go review"
    };

    const result = await service.recall({
      taskSurface,
      workspaceId: "workspace-1",
      strategy: "chat",
      policyOverride: policy
    });

    expect(searchByKeywordWithinObjectIds).toHaveBeenCalledWith(
      "workspace-1",
      "Go review",
      5,
      ["memory-hot"]
    );
    expect(searchByKeyword).not.toHaveBeenCalled();
    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual(["memory-hot"]);
  });

  it("returns empty candidates for empty workspace", async () => {
    const { dependencies } = createDependencies([]);
    const service = new RecallService(dependencies);

    const result = await service.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "chat"
    });

    expect(result.candidates).toEqual([]);
    expect(result.total_scanned).toBe(0);
    expect(result.working_projection).toBeNull();
  });
});
