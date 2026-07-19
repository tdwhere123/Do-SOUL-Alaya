import { describe, expect, it, vi } from "vitest";
import { MemoryDimension } from "@do-soul/alaya-protocol";
import { RecallService } from "../../recall/recall-service.js";
import { prepareEmbeddingSupplementQuery } from "../../recall/supplements/supplements.js";
import { createDependencies, createMemoryEntry, createPreparedQueryHandle, createTaskSurface, overridePolicy } from "./recall-service-test-fixtures.js";

describe("RecallService", () => {
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
    const querySupplement = vi.fn(async () => ({
      supplementaryEntries: Object.freeze([]),
      similarityHintsByObjectId: Object.freeze({})
    }));
    const service = new RecallService({
      ...dependencies,
      embeddingRecallService: {
        hasStoredVectors,
        prepareQueryEmbedding,
        querySupplementIfReady,
        querySupplement
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
    expect(querySupplement).not.toHaveBeenCalled();
  });

it("preserves the legacy query-embedding receiver", async () => {
    const basePolicy = new RecallService(createDependencies([]).dependencies)
      .buildDefaultPolicy("analyze", createTaskSurface().runtime_id);
    const preparedQuery = createPreparedQueryHandle("prepared-query-receiver");
    const embeddingRecallService = {
      preparedQuery,
      prepareQueryEmbedding() { return this.preparedQuery; },
      querySupplement: vi.fn(async () => ({
        supplementaryEntries: Object.freeze([]), similarityHintsByObjectId: Object.freeze({})
      }))
    };
    const result = await prepareEmbeddingSupplementQuery({
      dependencies: { embeddingRecallService },
      config: overridePolicy(basePolicy, {
        coarse_filter: {
          ...basePolicy.coarse_filter,
          semantic_supplement: { enabled: true, max_supplement: 1, embedding_enabled: true }
        }
      }),
      workspaceId: "workspace-1",
      runId: "run-1",
      queryText: "query",
      localEligibleCandidates: [{ entry: createMemoryEntry() }],
      lexicalFallbackCount: 1
    });
    expect(result.handle).toBe(preparedQuery);
  });

it("keeps the lexical baseline when a non-decisive semantic supplement joins the pool", async () => {
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
          normalized_similarity: 0.2
        }),
        "memory-semantic": Object.freeze({
          object_id: "memory-semantic",
          // Not decisive vs lexical — injection alone must not steal a tight budget slot.
          normalized_similarity: 0.2
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

// Decisive embedding match out-ranks strong lexical with near-zero embedding similarity
// via the lightweight deep head (family vote is weight-1; emb is not a fitted ×12 ballot).
  it("rebuilds budget state after the embedding head chooses the delivered set", async () => {
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
    const querySupplement = vi.fn(async () => ({
      supplementaryEntries: Object.freeze([]),
      similarityHintsByObjectId: Object.freeze({})
    }));
    const service = new RecallService({
      ...dependencies,
      embeddingRecallService: {
        hasStoredVectors,
        prepareQueryEmbedding,
        querySupplementIfReady,
        querySupplement
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
    expect(querySupplement).not.toHaveBeenCalled();
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
    const querySupplement = vi.fn(async () => ({
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
        querySupplement
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
    expect(querySupplement).not.toHaveBeenCalled();
  });
});
