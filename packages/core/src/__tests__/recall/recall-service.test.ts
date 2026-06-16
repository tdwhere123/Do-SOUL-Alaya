import { describe, expect, it, vi } from "vitest";
import {
  MemoryDimension,
  ProjectMappingState,
  ScopeClass,
} from "@do-soul/alaya-protocol";
import { RecallService } from "../../recall/recall-service.js";
import { createActiveConstraint, createAnchor, createDependencies, createMemoryEntry, createPreparedQueryHandle, createTaskSurface, overridePolicy } from "./recall-service-test-fixtures.js";

describe("RecallService", () => {
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
      error: "cache write failed"
    });
  });

  it("applies coarse scope filters to all global-source candidates", async () => {
    const recordClassifications = vi.fn(async () => {});
    const globalRecall = vi.fn(async () => [
      {
        global_object_id: "global-procedure",
        dimension: MemoryDimension.PROCEDURE,
        scope_class: ScopeClass.GLOBAL_DOMAIN,
        content: "Accepted global procedure",
        domain_tags: ["repo"],
        evidence_refs: [],
        activation_score: 0.9,
        created_at: "2026-03-23T00:00:00.000Z",
        updated_at: "2026-03-23T00:00:00.000Z"
      },
      {
        global_object_id: "global-hazard",
        dimension: MemoryDimension.HAZARD,
        scope_class: ScopeClass.GLOBAL_DOMAIN,
        content: "Accepted global hazard",
        domain_tags: ["repo"],
        evidence_refs: [],
        activation_score: 0.01,
        created_at: "2026-03-23T00:00:00.000Z",
        updated_at: "2026-03-23T00:00:00.000Z"
      }
    ]);
    const { dependencies } = createDependencies([]);
    const service = new RecallService({
      ...dependencies,
      projectMappingPort: {
        findByWorkspace: vi.fn(async () => []),
        ensureSuggestedAnchors: vi.fn(async () => [
          createAnchor({
            object_id: "mapping-procedure",
            global_object_id: "global-procedure",
            mapping_state: ProjectMappingState.ACCEPTED
          }),
          createAnchor({
            object_id: "mapping-hazard",
            global_object_id: "global-hazard",
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
      strategy: "build"
    });

    expect(globalRecall).toHaveBeenCalled();
    expect(result.candidates).toEqual([]);
    expect(recordClassifications).toHaveBeenCalledWith([
      {
        workspaceId: "workspace-1",
        globalObjectId: "global-procedure",
        classification: "excluded"
      },
      {
        workspaceId: "workspace-1",
        globalObjectId: "global-hazard",
        classification: "excluded"
      }
    ]);
  });

  it("applies min_activation_score and preserves full content for full-eligible global candidates", async () => {
    const coldGlobal = {
      global_object_id: "global-cold",
      dimension: MemoryDimension.PROCEDURE,
      scope_class: ScopeClass.GLOBAL_DOMAIN,
      content: "Cold global procedure",
      domain_tags: ["repo"],
      evidence_refs: [],
      activation_score: 0.2,
      created_at: "2026-03-23T00:00:00.000Z",
      updated_at: "2026-03-23T00:00:00.000Z"
    };
    const warmContent = "Shared procedure ".repeat(16).trim();
    const warmGlobal = {
      global_object_id: "global-warm",
      dimension: MemoryDimension.PROCEDURE,
      scope_class: ScopeClass.GLOBAL_DOMAIN,
      content: warmContent,
      domain_tags: ["repo"],
      evidence_refs: [],
      activation_score: 0.95,
      created_at: "2026-03-23T00:00:00.000Z",
      updated_at: "2026-03-23T00:00:00.000Z"
    };
    const { dependencies } = createDependencies([]);
    const service = new RecallService({
      ...dependencies,
      projectMappingPort: {
        findByWorkspace: vi.fn(async () => []),
        ensureSuggestedAnchors: vi.fn(async () => [
          createAnchor({
            object_id: "mapping-cold",
            global_object_id: "global-cold",
            mapping_state: ProjectMappingState.ACCEPTED
          }),
          createAnchor({
            object_id: "mapping-warm",
            global_object_id: "global-warm",
            mapping_state: ProjectMappingState.ACCEPTED
          })
        ])
      },
      globalRecallPort: {
        recall: vi.fn(async () => [coldGlobal, warmGlobal])
      }
    });
    const basePolicy = service.buildDefaultPolicy("analyze", createTaskSurface().runtime_id);
    const policy = overridePolicy(basePolicy, {
      coarse_filter: {
        ...basePolicy.coarse_filter,
        precomputed_rank: {
          ...basePolicy.coarse_filter.precomputed_rank,
          max_candidates: 10,
          min_activation_score: 0.5
        }
      },
      fine_assessment: {
        ...basePolicy.fine_assessment,
        budgets: {
          max_entries: 10,
          max_total_tokens: 5000,
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

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual(["global-warm"]);
    expect(result.candidates[0]).toMatchObject({
      object_id: "global-warm",
      manifestation: "full_eligible",
      origin_plane: "global",
      content_preview: warmContent
    });
  });

  it("returns more candidates for analyze than build", async () => {
    const memories = [
      createMemoryEntry({ object_id: "memory-1", dimension: MemoryDimension.PREFERENCE, scope_class: ScopeClass.PROJECT, activation_score: 0.8 }),
      createMemoryEntry({ object_id: "memory-2", dimension: MemoryDimension.FACT, scope_class: ScopeClass.GLOBAL_DOMAIN, activation_score: 0.6 }),
      createMemoryEntry({ object_id: "memory-3", dimension: MemoryDimension.PROCEDURE, scope_class: ScopeClass.PROJECT, activation_score: 0.7 }),
      createMemoryEntry({ object_id: "memory-4", dimension: MemoryDimension.HAZARD, scope_class: ScopeClass.GLOBAL_DOMAIN, activation_score: 0.05 })
    ];
    const { dependencies } = createDependencies(memories);
    const searchByKeyword = vi.fn(async () => [
      { object_id: "memory-template", normalized_rank: 1 },
      { object_id: "memory-answer", normalized_rank: 1 }
    ]);
    const service = new RecallService({
      ...dependencies,
      memoryRepo: {
        ...dependencies.memoryRepo,
        searchByKeyword
      }
    });

    const analyze = await service.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "analyze"
    });
    const build = await service.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "build"
    });

    expect(analyze.candidates.length).toBeGreaterThan(build.candidates.length);
  });

  it("build strategy applies scope filters while active constraints stay separate", async () => {
    const memories = [
      createMemoryEntry({ object_id: "memory-1", scope_class: ScopeClass.PROJECT, dimension: MemoryDimension.PROCEDURE, activation_score: 0.8 }),
      createMemoryEntry({ object_id: "memory-2", scope_class: ScopeClass.GLOBAL_DOMAIN, dimension: MemoryDimension.PROCEDURE, activation_score: 0.9 }),
      createMemoryEntry({ object_id: "memory-3", scope_class: ScopeClass.GLOBAL_DOMAIN, dimension: MemoryDimension.HAZARD, activation_score: 0.01 })
    ];
    const { dependencies } = createDependencies(memories, [], {}, [createActiveConstraint(memories[2]!)]);
    const service = new RecallService(dependencies);

    const result = await service.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "build"
    });

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual(["memory-1"]);
    expect(result.candidates.every((candidate) => candidate.scope_class === ScopeClass.PROJECT)).toBe(true);
    expect(result.active_constraints.map((constraint) => constraint.object_id)).toEqual(["memory-3"]);
  });

  it("build strategy applies dimension filters while active constraints stay separate", async () => {
    const memories = [
      createMemoryEntry({ object_id: "memory-1", dimension: MemoryDimension.PROCEDURE, activation_score: 0.7 }),
      createMemoryEntry({ object_id: "memory-2", dimension: MemoryDimension.PREFERENCE, activation_score: 0.9 }),
      createMemoryEntry({ object_id: "memory-3", dimension: MemoryDimension.CONSTRAINT, activation_score: 0.01 })
    ];
    const { dependencies } = createDependencies(memories, [], {}, [createActiveConstraint(memories[2]!)]);
    const service = new RecallService(dependencies);

    const result = await service.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "build"
    });

    expect(result.candidates.map((candidate) => candidate.dimension)).toEqual([
      MemoryDimension.PROCEDURE
    ]);
    expect(result.active_constraints.map((constraint) => constraint.object_id)).toEqual(["memory-3"]);
  });

  it("min_activation_score filters low-activation optional entries", async () => {
    const memories = [
      createMemoryEntry({ object_id: "memory-1", dimension: MemoryDimension.PROCEDURE, activation_score: 0.2 }),
      createMemoryEntry({ object_id: "memory-2", dimension: MemoryDimension.PROCEDURE, activation_score: 0.7 })
    ];
    const { dependencies } = createDependencies(memories);
    const service = new RecallService(dependencies);
    const basePolicy = service.buildDefaultPolicy("analyze", createTaskSurface().runtime_id);
    const policy = overridePolicy(basePolicy, {
      coarse_filter: {
        ...basePolicy.coarse_filter,
        precomputed_rank: {
          max_candidates: 10,
          min_activation_score: 0.5
        }
      }
    });

    const result = await service.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "analyze",
      policyOverride: policy
    });

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual(["memory-2"]);
  });

  it("respects token budget", async () => {
    const memories = [
      createMemoryEntry({ object_id: "memory-1", content: "a".repeat(24), activation_score: 0.9 }),
      createMemoryEntry({ object_id: "memory-2", content: "b".repeat(24), activation_score: 0.8 })
    ];
    const { dependencies } = createDependencies(memories);
    const service = new RecallService(dependencies);
    const basePolicy = service.buildDefaultPolicy("analyze", createTaskSurface().runtime_id);
    const policy = overridePolicy(basePolicy, {
      fine_assessment: {
        ...basePolicy.fine_assessment,
        budgets: {
          max_total_tokens: 6,
          max_entries: 5,
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

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].object_id).toBe("memory-1");
  });

  it("respects max_entries budget", async () => {
    const memories = [
      createMemoryEntry({ object_id: "memory-1", activation_score: 0.9 }),
      createMemoryEntry({ object_id: "memory-2", activation_score: 0.8 }),
      createMemoryEntry({ object_id: "memory-3", activation_score: 0.7 })
    ];
    const { dependencies } = createDependencies(memories);
    const service = new RecallService(dependencies);
    const basePolicy = service.buildDefaultPolicy("analyze", createTaskSurface().runtime_id);
    const policy = overridePolicy(basePolicy, {
      fine_assessment: {
        ...basePolicy.fine_assessment,
        budgets: {
          max_total_tokens: 1000,
          max_entries: 2,
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

    expect(result.candidates).toHaveLength(2);
  });

  it("cohort dominance guard skips the plane when union ratio exceeds 50% on a single-session workspace", async () => {
    const memories = Array.from({ length: 12 }, (_, i) =>
      createMemoryEntry({
        object_id: `0aaa${i.toString().padStart(2, "0")}aa-0000-4000-8000-000000000abc`,
        scope_class: ScopeClass.PROJECT,
        dimension: MemoryDimension.PROCEDURE,
        surface_id: "surface-shared",
        run_id: "run-shared",
        content: `unrelated topic ${i}`,
        activation_score: 0.6
      })
    );
    const { dependencies } = createDependencies(memories);
    const service = new RecallService(dependencies);
    // invariant: query text mentions both surface-shared and run-shared
    // so recall-query-probes populates surface_ids / run_ids; without
    // this the cohort exact branch finds no matches and the test would
    // pass vacuously for the wrong reason.
    const taskSurface = createTaskSurface();
    const result = await service.recall({
      taskSurface: { ...taskSurface, display_name: "request inside surface-shared during run-shared" },
      workspaceId: "workspace-1",
      runId: "run-shared",
      strategy: "analyze"
    });
    const cohortWins = result.candidates.filter(
      (c) => c.source_channels?.some((channel) => channel.includes("session_surface_cohort"))
    ).length;
    expect(cohortWins).toBe(0);
  });

  it("cohort dominance guard admits the cohort plane when matching cohort stays under 50%", async () => {
    const memories = [
      createMemoryEntry({
        object_id: "0aaa0001-0000-4000-8000-000000000abc",
        surface_id: "surface-target",
        run_id: "run-target",
        content: "match by exact cohort",
        activation_score: 0.6
      }),
      createMemoryEntry({
        object_id: "0aaa0002-0000-4000-8000-000000000abc",
        surface_id: "surface-other",
        run_id: "run-other",
        content: "unrelated topic alpha",
        activation_score: 0.6
      }),
      createMemoryEntry({
        object_id: "0aaa0003-0000-4000-8000-000000000abc",
        surface_id: "surface-other",
        run_id: "run-other",
        content: "unrelated topic beta",
        activation_score: 0.6
      }),
      createMemoryEntry({
        object_id: "0aaa0004-0000-4000-8000-000000000abc",
        surface_id: "surface-other",
        run_id: "run-other",
        content: "unrelated topic gamma",
        activation_score: 0.6
      })
    ];
    const { dependencies } = createDependencies(memories);
    const service = new RecallService(dependencies);
    const taskSurface = createTaskSurface();
    const result = await service.recall({
      taskSurface: { ...taskSurface, display_name: "request inside surface-target during run-target" },
      workspaceId: "workspace-1",
      runId: "run-target",
      strategy: "analyze"
    });
    // invariant: when the would-be cohort union stays under 50% of the
    // tier pool (here 1/4 = 25%), the cohort plane admits the matching
    // memory and the diagnostic surface records the cohort attribution.
    const cohortDiagnostic = result.diagnostics?.candidates.find(
      (d) =>
        d.object_id === "0aaa0001-0000-4000-8000-000000000abc" &&
        d.admission_planes.includes("session_surface_cohort")
    );
    expect(cohortDiagnostic, "matching memory should be admitted via the cohort plane").toBeDefined();
  });

  it("keeps active constraints independent from the score-ranked result budget", async () => {
    const constraintMemories = [
      createMemoryEntry({ object_id: "c-1", dimension: MemoryDimension.CONSTRAINT, activation_score: 0.50 }),
      createMemoryEntry({ object_id: "c-2", dimension: MemoryDimension.CONSTRAINT, activation_score: 0.55 }),
      createMemoryEntry({ object_id: "c-3", dimension: MemoryDimension.CONSTRAINT, activation_score: 0.60 }),
      createMemoryEntry({ object_id: "c-4", dimension: MemoryDimension.CONSTRAINT, activation_score: 0.65 }),
      createMemoryEntry({ object_id: "c-5", dimension: MemoryDimension.CONSTRAINT, activation_score: 0.70 }),
      createMemoryEntry({ object_id: "c-6", dimension: MemoryDimension.CONSTRAINT, activation_score: 0.75 })
    ];
    const activeConstraints = constraintMemories.map(createActiveConstraint);
    const { dependencies } = createDependencies(constraintMemories, [], {}, activeConstraints);
    const service = new RecallService(dependencies);
    const basePolicy = service.buildDefaultPolicy("analyze", createTaskSurface().runtime_id);
    const policy = overridePolicy(basePolicy, {
      fine_assessment: {
        ...basePolicy.fine_assessment,
        budgets: {
          max_total_tokens: 10_000,
          max_entries: 3,
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

    expect(result.candidates).toHaveLength(3);
    expect(result.active_constraints.map((constraint) => constraint.object_id)).toEqual([
      "c-1",
      "c-2",
      "c-3",
      "c-4",
      "c-5",
      "c-6"
    ]);
    expect(result.active_constraints_count).toBe(6);
  });
});
