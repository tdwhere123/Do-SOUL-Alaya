import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryDimension, ProjectMappingState, ScopeClass } from "@do-soul/alaya-protocol";
import { RecallService } from "../../recall/recall-service.js";
import { createAnchor, createDependencies, createMemoryEntry, createPreparedQueryHandle, createTaskSurface, overridePolicy } from "./recall-service-test-fixtures.js";

describe("RecallService", () => {
  afterEach(() => { vi.unstubAllEnvs(); });
it("merges adopted global-source candidates through optional recall ports and excludes non-adopted globals", async () => {
    const memories = [
      createMemoryEntry({
        object_id: "project-memory",
        scope_class: ScopeClass.PROJECT,
        activation_score: 0.9
      })
    ];
    const recordClassifications = vi.fn(async () => {});
    const globalRecall = vi.fn(async () => [
      {
        global_object_id: "global-accepted",
        dimension: MemoryDimension.PROCEDURE,
        scope_class: ScopeClass.GLOBAL_DOMAIN,
        content: "Accepted global content",
        domain_tags: ["repo"],
        evidence_refs: ["evidence-accepted"],
        activation_score: 0.75,
        created_at: "2026-03-23T00:00:00.000Z",
        updated_at: "2026-03-23T00:00:00.000Z"
      },
      {
        global_object_id: "global-suggested",
        dimension: MemoryDimension.PROCEDURE,
        scope_class: ScopeClass.GLOBAL_DOMAIN,
        content: "Suggested global content",
        domain_tags: ["repo"],
        evidence_refs: [],
        activation_score: 0.7,
        created_at: "2026-03-23T00:00:00.000Z",
        updated_at: "2026-03-23T00:00:00.000Z"
      }
    ]);
    const ensureSuggestedAnchors = vi.fn(async () => [
      createAnchor({
        object_id: "mapping-accepted",
        global_object_id: "global-accepted",
        mapping_state: ProjectMappingState.ACCEPTED
      }),
      createAnchor({
        object_id: "mapping-suggested",
        global_object_id: "global-suggested",
        mapping_state: ProjectMappingState.SUGGESTED
      })
    ]);
    const { dependencies } = createDependencies(memories);
    const service = new RecallService({
      ...dependencies,
      projectMappingPort: {
        findByWorkspace: vi.fn(async () => []),
        ensureSuggestedAnchors
      },
      globalRecallPort: {
        recall: globalRecall
      },
      globalRecallCachePort: {
        recordClassifications
      }
    });
    const basePolicy = service.buildDefaultPolicy("analyze", createTaskSurface().runtime_id);
    const policy = overridePolicy(basePolicy, {
      coarse_filter: {
        ...basePolicy.coarse_filter,
        deterministic_match: {
          ...basePolicy.coarse_filter.deterministic_match,
          scope_filter: null,
          dimension_filter: null,
          domain_tag_filter: null
        },
        precomputed_rank: {
          ...basePolicy.coarse_filter.precomputed_rank,
          max_candidates: 10,
          min_activation_score: null
        }
      },
      fine_assessment: {
        ...basePolicy.fine_assessment,
        budgets: {
          max_entries: 10,
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

    expect(globalRecall).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      queryText: "Implement recall",
      limit: 10
    });
    expect(ensureSuggestedAnchors).toHaveBeenCalledWith(
      ["global-accepted", "global-suggested"],
      "workspace-1",
      "system"
    );
    expect(result.candidates.map((candidate) => candidate.object_id).sort()).toEqual([
      "global-accepted",
      "project-memory"
    ]);
    expect(
      result.candidates.find((candidate) => candidate.object_id === "global-accepted")?.origin_plane
    ).toBe("global");
    expect(
      result.candidates.find((candidate) => candidate.object_id === "global-accepted")?.is_advisory
    ).toBe(false);
    expect(result.candidates.some((candidate) => candidate.object_id === "global-suggested")).toBe(
      false
    );
    expect(recordClassifications).toHaveBeenCalledWith([
      {
        workspaceId: "workspace-1",
        globalObjectId: "global-accepted",
        classification: "included"
      },
      {
        workspaceId: "workspace-1",
        globalObjectId: "global-suggested",
        classification: "excluded"
      }
    ]);
  });

it("keeps local and global recall candidates with matching ids in separate origin planes", async () => {
    const sharedObjectId = "shared-object-id";
    const memories = [
      createMemoryEntry({
        object_id: sharedObjectId,
        scope_class: ScopeClass.PROJECT,
        content: "Local workspace procedure",
        activation_score: 0.9
      })
    ];
    const globalRecall = vi.fn(async () => [
      {
        global_object_id: sharedObjectId,
        dimension: MemoryDimension.PROCEDURE,
        scope_class: ScopeClass.GLOBAL_DOMAIN,
        content: "Global source-plane procedure",
        domain_tags: ["repo"],
        evidence_refs: ["evidence-shared"],
        activation_score: 0.8,
        created_at: "2026-03-23T00:00:00.000Z",
        updated_at: "2026-03-23T00:00:00.000Z"
      }
    ]);
    const { dependencies } = createDependencies(memories);
    const preparedQuery = createPreparedQueryHandle("prepared-query-origin-collision");
    const querySupplementIfReady = vi.fn(async () => ({
      supplementaryEntries: Object.freeze([]),
      similarityHintsByObjectId: Object.freeze({
        [sharedObjectId]: Object.freeze({
          object_id: sharedObjectId,
          normalized_similarity: 0.25
        })
      })
    }));
    const service = new RecallService({
      ...dependencies,
      projectMappingPort: {
        findByWorkspace: vi.fn(async () => []),
        ensureSuggestedAnchors: vi.fn(async () => [
          createAnchor({
            object_id: "mapping-shared",
            global_object_id: sharedObjectId,
            mapping_state: ProjectMappingState.ACCEPTED
          })
        ])
      },
      globalRecallPort: {
        recall: globalRecall
      },
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
        deterministic_match: {
          ...basePolicy.coarse_filter.deterministic_match,
          scope_filter: null,
          dimension_filter: null,
          domain_tag_filter: null
        },
        precomputed_rank: {
          ...basePolicy.coarse_filter.precomputed_rank,
          max_candidates: 10,
          min_activation_score: null
        },
        semantic_supplement: {
          enabled: true,
          max_supplement: 5,
          embedding_enabled: true
        }
      },
      fine_assessment: {
        ...basePolicy.fine_assessment,
        budgets: {
          max_entries: 10,
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

    const collidingCandidates = result.candidates.filter(
      (candidate) => candidate.object_id === sharedObjectId
    );
    expect(querySupplementIfReady).toHaveBeenCalled();
    expect(collidingCandidates).toHaveLength(2);
    expect(collidingCandidates.map((candidate) => candidate.origin_plane).sort()).toEqual([
      "global",
      "workspace_local"
    ]);
  });

it("applies embedding hits to the local candidate when a global candidate shares its object id", async () => {
    // Asserts the flat fusion ordering for the shared-object embedding merge (retained under the kill-switch).
    vi.stubEnv("ALAYA_RECALL_FLAT_BASELINE", "1");
    const sharedObjectId = "shared-object-id-embedding";
    const memories = [
      createMemoryEntry({
        object_id: sharedObjectId,
        scope_class: ScopeClass.PROJECT,
        content: "Local workspace procedure with the semantic answer.",
        activation_score: 0.19
      })
    ];
    const globalRecall = vi.fn(async () => [
      {
        global_object_id: sharedObjectId,
        dimension: MemoryDimension.PROCEDURE,
        scope_class: ScopeClass.GLOBAL_DOMAIN,
        content: "Global source-plane procedure.",
        domain_tags: ["repo"],
        evidence_refs: ["evidence-shared"],
        activation_score: 0.2,
        created_at: "2026-03-23T00:00:00.000Z",
        updated_at: "2026-03-23T00:00:00.000Z"
      }
    ]);
    const { dependencies } = createDependencies(memories);
    const preparedQuery = createPreparedQueryHandle("prepared-query-origin-local");
    const querySupplementIfReady = vi.fn(async () => ({
      supplementaryEntries: Object.freeze([memories[0]!]),
      similarityHintsByObjectId: Object.freeze({
        [sharedObjectId]: Object.freeze({
          object_id: sharedObjectId,
          normalized_similarity: 1
        })
      })
    }));
    const service = new RecallService({
      ...dependencies,
      projectMappingPort: {
        findByWorkspace: vi.fn(async () => []),
        ensureSuggestedAnchors: vi.fn(async () => [
          createAnchor({
            object_id: "mapping-shared-embedding",
            global_object_id: sharedObjectId,
            mapping_state: ProjectMappingState.ACCEPTED
          })
        ])
      },
      globalRecallPort: {
        recall: globalRecall
      },
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
        deterministic_match: {
          ...basePolicy.coarse_filter.deterministic_match,
          scope_filter: null,
          dimension_filter: null,
          domain_tag_filter: null
        },
        precomputed_rank: {
          ...basePolicy.coarse_filter.precomputed_rank,
          max_candidates: 10,
          min_activation_score: null
        },
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

    expect(querySupplementIfReady).toHaveBeenCalled();
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      object_id: sharedObjectId,
      origin_plane: "workspace_local"
    });
    expect(result.candidates[0]?.score_factors?.embedding_similarity).toBe(1);
    expect(result.candidates[0]?.source_channels).toContain("semantic_supplement");
  });

it("does not record global recall classifications when recall completion fails", async () => {
    const recordClassifications = vi.fn(async () => {});
    const globalRecall = vi.fn(async () => [
      {
        global_object_id: "global-accepted",
        dimension: MemoryDimension.PROCEDURE,
        scope_class: ScopeClass.GLOBAL_DOMAIN,
        content: "Accepted global content",
        domain_tags: ["repo"],
        evidence_refs: ["evidence-accepted"],
        activation_score: 0.75,
        created_at: "2026-03-23T00:00:00.000Z",
        updated_at: "2026-03-23T00:00:00.000Z"
      }
    ]);
    const { dependencies, appendSpy } = createDependencies([]);
    appendSpy.mockRejectedValueOnce(new Error("completion append failed"));
    const service = new RecallService({
      ...dependencies,
      projectMappingPort: {
        findByWorkspace: vi.fn(async () => []),
        ensureSuggestedAnchors: vi.fn(async () => [
          createAnchor({
            object_id: "mapping-accepted",
            global_object_id: "global-accepted",
            mapping_state: ProjectMappingState.ACCEPTED
          })
        ])
      },
      globalRecallPort: {
        recall: globalRecall
      },
      globalRecallCachePort: {
        recordClassifications
      }
    });

    await expect(
      service.recall({
        taskSurface: createTaskSurface(),
        workspaceId: "workspace-1",
        strategy: "analyze"
      })
    ).rejects.toThrow("completion append failed");
    expect(recordClassifications).not.toHaveBeenCalled();
  });

it("does not fail recall when optional global recall cache recording throws and emits a warning witness", async () => {
    const recordClassifications = vi.fn(async () => {
      throw new Error("cache write failed");
    });
    const globalRecall = vi.fn(async () => [
      {
        global_object_id: "global-accepted",
        dimension: MemoryDimension.PROCEDURE,
        scope_class: ScopeClass.GLOBAL_DOMAIN,
        content: "Accepted global content",
        domain_tags: ["repo"],
        evidence_refs: ["evidence-accepted"],
        activation_score: 0.75,
        created_at: "2026-03-23T00:00:00.000Z",
        updated_at: "2026-03-23T00:00:00.000Z"
      }
    ]);
    const { dependencies, warnSpy } = createDependencies([]);
    const service = new RecallService({
      ...dependencies,
      projectMappingPort: {
        findByWorkspace: vi.fn(async () => []),
        ensureSuggestedAnchors: vi.fn(async () => [
          createAnchor({
            object_id: "mapping-accepted",
            global_object_id: "global-accepted",
            mapping_state: ProjectMappingState.ACCEPTED
          })
        ])
      },
      globalRecallPort: {
        recall: globalRecall
      },
      globalRecallCachePort: {
        recordClassifications
      }
    });

    const result = await service.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "analyze"
    });

    expect(result.candidates.map((candidate) => candidate.object_id)).toContain("global-accepted");
    expect(recordClassifications).toHaveBeenCalledWith([
      {
        workspaceId: "workspace-1",
        globalObjectId: "global-accepted",
        classification: "included"
      }
    ]);
    expect(warnSpy).toHaveBeenCalledWith("global recall cache record failed", {
      workspace_id: "workspace-1",
      classification_count: 1,
      operation: "global_recall_cache_record",
      errorName: "Error",
      error: "cache write failed"
    });
  });
});
