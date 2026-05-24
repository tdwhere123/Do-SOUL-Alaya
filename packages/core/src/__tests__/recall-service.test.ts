import { describe, expect, it, vi } from "vitest";
import {
  ControlPlaneObjectKind,
  MemoryDimension,
  MemoryGovernanceEventType,
  ObjectLifecycleState,
  RecallContextEventType,
  ProjectMappingState,
  RetentionPolicy,
  ScopeClass,
  SynthesisStatus,
  type EventLogEntry,
  type MemoryEntry,
  type ProjectMappingAnchor,
  type RecallPolicy,
  type SoulActiveConstraint,
  type Slot,
  type SynthesisCapsule,
  type TaskObjectSurface
} from "@do-soul/alaya-protocol";
import {
  RecallService,
  classifyGlobalCandidate,
  type RecallServiceDependencies
} from "../recall-service.js";
import type { EmbeddingVectorRecord } from "../embedding-recall-service.js";

function createTaskSurface(): TaskObjectSurface {
  return {
    runtime_id: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
    object_kind: ControlPlaneObjectKind.TASK_OBJECT_SURFACE,
    task_surface_ref: null,
    expires_at: "2026-03-23T00:30:00.000Z",
    derived_from: null,
    retention_policy: RetentionPolicy.SESSION_ONLY,
    surface_kind: "build",
    display_name: "Implement recall",
    context_refs: []
  };
}

function createPreparedQueryHandle(queryId: string) {
  return {
    queryId,
    getSnapshot: () =>
      ({
        status: "pending"
      }) as const
  };
}

function createMemoryEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    object_id: "11111111-1111-4111-8111-111111111111",
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-20T00:00:00.000Z",
    updated_at: "2026-03-20T00:00:00.000Z",
    created_by: "system",
    dimension: MemoryDimension.PROCEDURE,
    source_kind: "user",
    formation_kind: "explicit",
    scope_class: ScopeClass.PROJECT,
    content: "Use pnpm for workspace commands.",
    domain_tags: ["repo"],
    evidence_refs: [],
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    storage_tier: "hot",
    activation_score: 0.7,
    retention_score: null,
    manifestation_state: null,
    retention_state: null,
    decay_profile: null,
    confidence: null,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: null,
    contradiction_count: null,
    superseded_by: null,
    ...overrides
  };
}

function createActiveConstraint(memory: Readonly<MemoryEntry>): SoulActiveConstraint {
  return {
    object_id: memory.object_id,
    object_kind: memory.object_kind,
    content: memory.content,
    dimension: memory.dimension,
    scope_class: memory.scope_class,
    governance_state: {
      claim_status: null,
      governance_class: null,
      source_channels: ["dimension"]
    }
  };
}

function createSlot(overrides: Partial<Slot> = {}): Slot {
  return {
    object_id: "slot-1",
    object_kind: "slot",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-20T00:00:00.000Z",
    updated_at: "2026-03-20T00:00:00.000Z",
    created_by: "system",
    governance_subject: {
      subject_domain: "security",
      subject_qualifiers: { category: "repo" },
      canonical_key: "security::category=repo"
    },
    claim_kind: "constraint",
    scope_class: ScopeClass.PROJECT,
    winner_claim_id: "claim-form-winner-1",
    incumbent_since: "2026-03-20T00:00:00.000Z",
    flip_conditions: [],
    workspace_id: "workspace-1",
    ...overrides
  };
}

function createAnchor(overrides: Partial<ProjectMappingAnchor> = {}): ProjectMappingAnchor {
  return {
    object_id: "mapping-1",
    object_kind: "project_mapping_anchor",
    schema_version: 1,
    lifecycle_state: ObjectLifecycleState.ACTIVE,
    created_at: "2026-03-23T00:00:00.000Z",
    updated_at: "2026-03-23T00:00:00.000Z",
    created_by: "user_action",
    global_object_id: "memory-1",
    project_id: "workspace-1",
    workspace_id: "workspace-1",
    mapping_state: ProjectMappingState.SUGGESTED,
    accepted_by: null,
    last_transition_at: "2026-03-23T00:00:00.000Z",
    ...overrides
  };
}

function createDependencies(
  memories: readonly MemoryEntry[],
  slots: readonly Slot[] = [],
  // Maps claim object_id -> source_object_refs (backing memory IDs).
  claimSourceRefs: Readonly<Record<string, readonly string[]>> = {},
  activeConstraints: readonly Readonly<SoulActiveConstraint>[] = []
): {
  readonly dependencies: RecallServiceDependencies;
  readonly appendSpy: ReturnType<typeof vi.fn>;
  readonly warnSpy: ReturnType<typeof vi.fn>;
} {
  const appendSpy = vi.fn(async (event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => ({
    event_id: `event-${event.event_type}`,
    created_at: "2026-03-23T00:00:00.000Z",
    revision: 0,
    ...event
  }));
  const warnSpy = vi.fn();

  return {
    dependencies: {
      now: () => "2026-03-23T00:00:00.000Z",
      generateRuntimeId: () => "85b3671a-d8d8-4848-9e5c-07d0a89f5ae9",
      memoryRepo: {
        findByWorkspaceId: vi.fn(async () => memories),
        findByDimension: vi.fn(async (_workspaceId, dimension) => memories.filter((entry) => entry.dimension === dimension)),
        findByScopeClass: vi.fn(async (_workspaceId, scopeClass) => memories.filter((entry) => entry.scope_class === scopeClass))
      },
      slotRepo: {
        findByWorkspace: vi.fn(async () => slots)
      },
      eventLogRepo: {
        append: appendSpy,
        queryByEntity: vi.fn(async () => [])
      },
      warn: warnSpy,
      claimResolverPort: {
        findByIds: vi.fn(async (ids: readonly string[]) =>
          ids
            .filter((id) => claimSourceRefs[id] !== undefined)
            .map((id) => ({ object_id: id, source_object_refs: claimSourceRefs[id] ?? [] }))
        )
      },
      activeConstraintsPort: {
        findActiveConstraints: vi.fn(async () => ({
          constraints: activeConstraints,
          total_count: activeConstraints.length
        }))
      }
    },
    appendSpy,
    warnSpy
  };
}

function overridePolicy(base: Readonly<RecallPolicy>, patch: Partial<RecallPolicy>): RecallPolicy {
  return {
    ...base,
    ...patch,
    coarse_filter: patch.coarse_filter ?? base.coarse_filter,
    fine_assessment: patch.fine_assessment ?? base.fine_assessment
  };
}

describe("RecallService", () => {
  it("classifyGlobalCandidate only includes accepted and adapted anchors for future global supply", () => {
    const anchorMap = new Map<string, Readonly<ProjectMappingAnchor>>([
      [
        "global-accepted",
        createAnchor({
          object_id: "mapping-accepted",
          global_object_id: "global-accepted",
          mapping_state: ProjectMappingState.ACCEPTED
        })
      ],
      [
        "global-adapted",
        createAnchor({
          object_id: "mapping-adapted",
          global_object_id: "global-adapted",
          mapping_state: ProjectMappingState.ADAPTED
        })
      ],
      [
        "global-suggested",
        createAnchor({
          object_id: "mapping-suggested",
          global_object_id: "global-suggested",
          mapping_state: ProjectMappingState.SUGGESTED
        })
      ],
      [
        "global-probationary",
        createAnchor({
          object_id: "mapping-probationary",
          global_object_id: "global-probationary",
          mapping_state: ProjectMappingState.PROBATIONARY
        })
      ],
      [
        "global-rejected",
        createAnchor({
          object_id: "mapping-rejected",
          global_object_id: "global-rejected",
          mapping_state: ProjectMappingState.REJECTED
        })
      ],
      [
        "global-not-applicable",
        createAnchor({
          object_id: "mapping-not-applicable",
          global_object_id: "global-not-applicable",
          mapping_state: ProjectMappingState.NOT_APPLICABLE
        })
      ]
    ]);

    expect(classifyGlobalCandidate({ global_object_id: "global-missing" }, anchorMap)).toEqual({
      include: false,
      reason: "no_anchor",
      anchor_state: null
    });
    expect(classifyGlobalCandidate({ global_object_id: "global-accepted" }, anchorMap)).toEqual({
      include: true,
      reason: "adopted",
      anchor_state: ProjectMappingState.ACCEPTED
    });
    expect(classifyGlobalCandidate({ global_object_id: "global-adapted" }, anchorMap)).toEqual({
      include: true,
      reason: "adopted",
      anchor_state: ProjectMappingState.ADAPTED
    });
    expect(classifyGlobalCandidate({ global_object_id: "global-suggested" }, anchorMap)).toEqual({
      include: false,
      reason: "not_adopted:suggested",
      anchor_state: ProjectMappingState.SUGGESTED
    });
    expect(classifyGlobalCandidate({ global_object_id: "global-probationary" }, anchorMap)).toEqual({
      include: false,
      reason: "not_adopted:probationary",
      anchor_state: ProjectMappingState.PROBATIONARY
    });
    expect(classifyGlobalCandidate({ global_object_id: "global-rejected" }, anchorMap)).toEqual({
      include: false,
      reason: "not_adopted:rejected",
      anchor_state: ProjectMappingState.REJECTED
    });
    expect(classifyGlobalCandidate({ global_object_id: "global-not-applicable" }, anchorMap)).toEqual({
      include: false,
      reason: "not_adopted:not_applicable",
      anchor_state: ProjectMappingState.NOT_APPLICABLE
    });
  });

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

  it("forwards active constraints cap to the active constraints port", async () => {
    const memory = createMemoryEntry({ object_id: "c-1", dimension: MemoryDimension.CONSTRAINT });
    const { dependencies } = createDependencies([memory], [], {}, [createActiveConstraint(memory)]);
    const service = new RecallService(dependencies);

    const result = await service.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "analyze",
      activeConstraintsCap: 5
    });

    expect(dependencies.activeConstraintsPort?.findActiveConstraints).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      cap: 5
    });
    expect(result.active_constraints_count).toBe(1);
  });

  it("keeps pre-budget diagnostics for candidates dropped by final delivery budget", async () => {
    const memories = [
      createMemoryEntry({ object_id: "memory-1", activation_score: 0.9 }),
      createMemoryEntry({ object_id: "memory-2", activation_score: 0.8 }),
      createMemoryEntry({ object_id: "memory-3", activation_score: 0.7 })
    ];
    const { dependencies } = createDependencies(memories);
    const service = new RecallService(dependencies);
    const basePolicy = service.buildDefaultPolicy("analyze", createTaskSurface().runtime_id);
    const policy = overridePolicy(basePolicy, {
      coarse_filter: {
        ...basePolicy.coarse_filter,
        precomputed_rank: {
          ...basePolicy.coarse_filter.precomputed_rank,
          max_candidates: 3
        }
      },
      fine_assessment: {
        ...basePolicy.fine_assessment,
        budgets: {
          max_total_tokens: 1000,
          max_entries: 1,
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

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual(["memory-1"]);
    expect(result.diagnostics?.candidate_pool_count).toBe(3);
    expect(result.diagnostics?.candidates.find((candidate) => candidate.object_id === "memory-2")).toMatchObject({
      pre_budget_rank: 2,
      final_rank: null,
      dropped_reason: "max_entries",
      within_budget: false
    });
  });

  it("uses graph and path expansion as read-side candidate generators before scoring", async () => {
    const memories = [
      createMemoryEntry({
        object_id: "seed-memory",
        content: "Deployment recall seed.",
        activation_score: 0.9
      }),
      createMemoryEntry({
        object_id: "graph-target",
        content: "Graph neighbor has the answer.",
        activation_score: 0.1,
        domain_tags: ["graph"]
      }),
      createMemoryEntry({
        object_id: "path-target",
        content: "Path neighbor has the answer.",
        activation_score: 0.1,
        domain_tags: ["path"]
      })
    ];
    const { dependencies } = createDependencies(memories);
    const graphExpansionPort = {
      findByMemoryId: vi.fn(async (memoryId: string) =>
        memoryId === "seed-memory"
          ? [
              {
                edge_id: "edge-1",
                source_memory_id: "seed-memory",
                target_memory_id: "graph-target",
                edge_type: "supports" as const,
                workspace_id: "workspace-1",
                created_at: "2026-03-20T00:00:00.000Z"
              }
            ]
          : []
      )
    };
    const pathExpansionPort = {
      findByAnchors: vi.fn(async () => [
        {
          path_id: "path-1",
          workspace_id: "workspace-1",
          anchors: {
            source_anchor: { kind: "object", object_id: "seed-memory" },
            target_anchor: { kind: "object", object_id: "path-target" }
          },
          constitution: {
            relation_kind: "supports_recall",
            why_this_relation_exists: ["test relation"]
          },
          effect_vector: {
            salience: 1,
            recall_bias: 1,
            verification_bias: 0,
            unfinishedness_bias: 0,
            default_manifestation_preference: "lens_entry"
          },
          plasticity_state: {
            strength: 1,
            direction_bias: "source_to_target",
            stability_class: "stable",
            support_events_count: 1,
            contradiction_events_count: 0
          },
          lifecycle: {
            status: "active",
            retirement_rule: "manual"
          },
          legitimacy: {
            evidence_basis: ["test"],
            governance_class: "recall_allowed"
          },
          created_at: "2026-03-20T00:00:00.000Z",
          updated_at: "2026-03-20T00:00:00.000Z"
        }
      ])
    };
    const service = new RecallService({
      ...dependencies,
      graphExpansionPort,
      pathExpansionPort
    });
    const basePolicy = service.buildDefaultPolicy("analyze", createTaskSurface().runtime_id);
    const policy = overridePolicy(basePolicy, {
      coarse_filter: {
        ...basePolicy.coarse_filter,
        precomputed_rank: {
          ...basePolicy.coarse_filter.precomputed_rank,
          max_candidates: 1
        },
        semantic_supplement: {
          enabled: false,
          max_supplement: 0
        }
      },
      fine_assessment: {
        ...basePolicy.fine_assessment,
        budgets: {
          max_total_tokens: 1000,
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

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual(
      expect.arrayContaining(["seed-memory", "graph-target", "path-target"])
    );
    expect(result.diagnostics?.candidates.find((candidate) => candidate.object_id === "graph-target")).toMatchObject({
      structural_score: 1
    });
    expect(result.diagnostics?.candidates.find((candidate) => candidate.object_id === "graph-target")?.admission_planes)
      .toContain("graph_expansion");
    expect(result.diagnostics?.candidates.find((candidate) => candidate.object_id === "path-target")).toMatchObject({
      object_id: "path-target"
    });
    expect(result.diagnostics?.candidates.find((candidate) => candidate.object_id === "path-target")?.admission_planes)
      .toContain("path_expansion");
  });

  it("applies conflict awareness to non-winner claim-like entries", async () => {
    const memories = [
      createMemoryEntry({ object_id: "winner-claim-1", dimension: MemoryDimension.PROCEDURE, activation_score: 0.8 }),
      createMemoryEntry({ object_id: "memory-2", dimension: MemoryDimension.PROCEDURE, activation_score: 0.8 })
    ];
    // The slot's winner_claim_id is a ClaimForm ID; its source_object_refs links to the backing memory.
    const claimSourceRefs = { "claim-form-winner-1": ["winner-claim-1"] };
    const { dependencies } = createDependencies(memories, [createSlot()], claimSourceRefs);
    const service = new RecallService(dependencies);

    const result = await service.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "analyze"
    });

    const winner = result.candidates.find((candidate) => candidate.object_id === "winner-claim-1");
    const loser = result.candidates.find((candidate) => candidate.object_id === "memory-2");

    expect(winner?.relevance_score).toBeGreaterThan(loser?.relevance_score ?? 0);
  });

  it("exempts all source_object_refs from conflict penalty when a claim has multiple backing memories", async () => {
    // Claim "claim-form-winner-1" backs two memory entries; both should be treated as winner-backed
    // and must NOT receive the conflict_penalty regardless of which one is listed first.
    const memories = [
      createMemoryEntry({ object_id: "winner-mem-a", dimension: MemoryDimension.PROCEDURE, activation_score: 0.8 }),
      createMemoryEntry({ object_id: "winner-mem-b", dimension: MemoryDimension.PROCEDURE, activation_score: 0.8 }),
      createMemoryEntry({ object_id: "non-winner-mem", dimension: MemoryDimension.PROCEDURE, activation_score: 0.8 })
    ];
    const claimSourceRefs = { "claim-form-winner-1": ["winner-mem-a", "winner-mem-b"] };
    const { dependencies } = createDependencies(memories, [createSlot()], claimSourceRefs);
    const service = new RecallService(dependencies);

    const result = await service.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "analyze"
    });

    const winnerA = result.candidates.find((c) => c.object_id === "winner-mem-a");
    const winnerB = result.candidates.find((c) => c.object_id === "winner-mem-b");
    const nonWinner = result.candidates.find((c) => c.object_id === "non-winner-mem");

    // Both backing memories should score higher than the non-winner (which gets conflict_penalty)
    expect(winnerA?.relevance_score).toBeGreaterThan(nonWinner?.relevance_score ?? 0);
    expect(winnerB?.relevance_score).toBeGreaterThan(nonWinner?.relevance_score ?? 0);
  });

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

  it("handles overlapped embedding preparation rejection when assessment fails", async () => {
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
      graphSupportPort: {
        countInboundEdgesWeighted: vi.fn(async () => {
          throw new Error("graph support unavailable");
        })
      },
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
      ).rejects.toThrow("graph support unavailable");
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

  it("emits soul.recall.completed after recall", async () => {
    const { dependencies, appendSpy } = createDependencies([createMemoryEntry()]);
    const service = new RecallService(dependencies);

    await service.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "chat",
      runId: "run-1"
    });

    expect(appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: RecallContextEventType.SOUL_RECALL_COMPLETED,
        entity_type: "task_object_surface",
        entity_id: createTaskSurface().runtime_id,
        run_id: "run-1"
      })
    );
  });

  it("ranks a high-plasticity candidate above an equivalent low-plasticity candidate", async () => {
    // Two memories with identical activation scores but different plasticity
    // strengths. The high-plasticity one must rank first.
    const memories = [
      createMemoryEntry({
        object_id: "memory-low-plasticity",
        dimension: MemoryDimension.PROCEDURE,
        activation_score: 0.5,
        content: "Lower-plasticity procedure baseline."
      }),
      createMemoryEntry({
        object_id: "memory-high-plasticity",
        dimension: MemoryDimension.PROCEDURE,
        activation_score: 0.5,
        content: "Higher-plasticity procedure baseline."
      })
    ];
    const { dependencies } = createDependencies(memories);
    const plasticityPort = {
      getStrengthByMemoryId: vi.fn(
        async (_workspaceId: string, _memoryIds: readonly string[]) =>
          new Map<string, number>([
            ["memory-low-plasticity", 0.0],
            ["memory-high-plasticity", 0.9]
          ])
      )
    };
    const service = new RecallService({
      ...dependencies,
      pathPlasticityPort: plasticityPort
    });

    const result = await service.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "analyze"
    });

    expect(plasticityPort.getStrengthByMemoryId).toHaveBeenCalled();
    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
      "memory-high-plasticity",
      "memory-low-plasticity"
    ]);
    const highCandidate = result.candidates.find(
      (candidate) => candidate.object_id === "memory-high-plasticity"
    );
    const lowCandidate = result.candidates.find(
      (candidate) => candidate.object_id === "memory-low-plasticity"
    );
    expect(highCandidate?.relevance_score).toBeGreaterThan(lowCandidate?.relevance_score ?? 0);
  });

  it("does not let plasticity alone override a base lexical/activation rank inversion (mirror of the embedding-supplement contract)", async () => {
    // Strong-activation lexical baseline vs weak-activation candidate with
    // moderate plasticity. The lexical baseline must still win because the
    // 0.15-cap plasticity boost cannot close a 0.85 → 0.05 activation gap.
    const memories = [
      createMemoryEntry({
        object_id: "memory-strong-lexical",
        dimension: MemoryDimension.PROCEDURE,
        activation_score: 0.85,
        content: "Strong lexical baseline procedure."
      }),
      createMemoryEntry({
        object_id: "memory-weak-but-plastic",
        dimension: MemoryDimension.PROCEDURE,
        activation_score: 0.05,
        content: "Weak baseline, but heavily reinforced by plasticity."
      })
    ];
    const { dependencies } = createDependencies(memories);
    const plasticityPort = {
      getStrengthByMemoryId: vi.fn(
        async (_workspaceId: string, _memoryIds: readonly string[]) =>
          new Map<string, number>([
            ["memory-strong-lexical", 0.0],
            ["memory-weak-but-plastic", 1.0]
          ])
      )
    };
    const service = new RecallService({
      ...dependencies,
      pathPlasticityPort: plasticityPort
    });

    const result = await service.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "analyze"
    });

    expect(result.candidates[0]?.object_id).toBe("memory-strong-lexical");
  });

  it("preserves base lexical ordering on a moderate gap under PATH_PLASTICITY_WEIGHT=0.15", async () => {
    // Activation contribution gap = (0.7 - 0.4) * 0.7 = 0.21
    // because the activation-weight base sums to 0.70. Max plasticity
    // boost gap = (1.0 - 0.0) * 0.15 = 0.15. Since 0.21 > 0.15, the
    // stronger-activation candidate must rank first even when the weaker
    // candidate is fully plastic and the stronger has zero plasticity.
    const memories = [
      createMemoryEntry({
        object_id: "memory-strong-baseline",
        dimension: MemoryDimension.PROCEDURE,
        activation_score: 0.7,
        content: "Strong activation baseline procedure."
      }),
      createMemoryEntry({
        object_id: "memory-moderate-but-plastic",
        dimension: MemoryDimension.PROCEDURE,
        activation_score: 0.4,
        content: "Moderate baseline, fully plastic."
      })
    ];
    const { dependencies } = createDependencies(memories);
    const plasticityPort = {
      getStrengthByMemoryId: vi.fn(
        async (_workspaceId: string, _memoryIds: readonly string[]) =>
          new Map<string, number>([
            ["memory-strong-baseline", 0.0],
            ["memory-moderate-but-plastic", 1.0]
          ])
      )
    };
    const service = new RecallService({
      ...dependencies,
      pathPlasticityPort: plasticityPort
    });

    const result = await service.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "analyze"
    });

    expect(result.candidates[0]?.object_id).toBe("memory-strong-baseline");
  });

  it("falls back to no plasticity boost when the path plasticity port throws — recall must not break on a plasticity failure", async () => {
    const memories = [
      createMemoryEntry({
        object_id: "memory-x",
        activation_score: 0.5,
        content: "Resilient memory."
      })
    ];
    const { dependencies, warnSpy } = createDependencies(memories);
    const plasticityPort = {
      getStrengthByMemoryId: vi.fn(async () => {
        throw new Error("plasticity port unavailable");
      })
    };
    const service = new RecallService({
      ...dependencies,
      pathPlasticityPort: plasticityPort
    });

    const result = await service.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "analyze"
    });

    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0]?.object_id).toBe("memory-x");
    expect(warnSpy).toHaveBeenCalledWith(
      "path plasticity port lookup failed",
      expect.objectContaining({ workspace_id: "workspace-1" })
    );
  });

  it("lets an L2 synthesis_capsule compete with memory entries before the delivery budget cut", async () => {
    const memories = [
      createMemoryEntry({
        object_id: "memory-1",
        scope_class: ScopeClass.PROJECT,
        dimension: MemoryDimension.PROCEDURE,
        content: "ordinary activation-heavy memory",
        activation_score: 1
      })
    ];
    const { dependencies } = createDependencies(memories);
    const synthesis: SynthesisCapsule = {
      object_id: "synthesis-1",
      object_kind: "synthesis_capsule",
      schema_version: 1,
      lifecycle_state: "active",
      created_at: "2026-03-23T00:00:00.000Z",
      updated_at: "2026-03-23T00:00:00.000Z",
      created_by: "system",
      topic_key: "recall/synthesis",
      synthesis_type: "cross_evidence",
      summary: "Cross-evidence synthesis covering the recall implementation.",
      evidence_refs: ["evidence-1", "evidence-2"],
      source_memory_refs: ["memory-1"],
      workspace_id: "workspace-1",
      run_id: "run-1",
      synthesis_status: SynthesisStatus.WORKING
    };
    const synthesisSearchByKeyword = vi.fn(async () => [
      { object_id: "synthesis-1", normalized_rank: 1 }
    ]);
    const synthesisFindByIds = vi.fn(async () => [synthesis]);
    const service = new RecallService({
      ...dependencies,
      synthesisSearchPort: {
        searchByKeyword: synthesisSearchByKeyword,
        findByIds: synthesisFindByIds
      }
    });
    const policy = overridePolicy(service.buildDefaultPolicy("analyze", createTaskSurface().runtime_id), {
      fine_assessment: {
        budgets: {
          max_entries: 1,
          max_total_tokens: 1000,
          per_dimension_limits: null
        },
        conflict_awareness: false
      }
    });

    const result = await service.recall({
      taskSurface: {
        ...createTaskSurface(),
        display_name: "Cross-evidence synthesis recall implementation"
      },
      workspaceId: "workspace-1",
      strategy: "analyze",
      policyOverride: policy
    });

    expect(synthesisSearchByKeyword).toHaveBeenCalled();
    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual(["synthesis-1"]);
    expect(result.candidates[0]?.object_kind).toBe("synthesis_capsule");
    const synthesisDiagnostic = result.diagnostics?.candidates.find(
      (candidate) => candidate.object_id === "synthesis-1"
    );
    const memoryDiagnostic = result.diagnostics?.candidates.find(
      (candidate) => candidate.object_id === "memory-1"
    );
    expect(synthesisDiagnostic?.per_stream_rank.synthesis_fts).toBe(1);
    expect(synthesisDiagnostic?.object_kind).toBe("synthesis_capsule");
    expect(synthesisDiagnostic?.final_rank).toBe(1);
    expect(memoryDiagnostic?.dropped_reason).toBe("max_entries");
  });

  it("keeps a strong memory_entry ahead of a weaker synthesis_capsule", async () => {
    const memories = [
      createMemoryEntry({
        object_id: "memory-1",
        scope_class: ScopeClass.PROJECT,
        dimension: MemoryDimension.PROCEDURE,
        content: "Cross-evidence synthesis recall implementation exact memory.",
        activation_score: 1
      })
    ];
    const { dependencies } = createDependencies(memories);
    const synthesis: SynthesisCapsule = {
      object_id: "synthesis-1",
      object_kind: "synthesis_capsule",
      schema_version: 1,
      lifecycle_state: "active",
      created_at: "2026-03-23T00:00:00.000Z",
      updated_at: "2026-03-23T00:00:00.000Z",
      created_by: "system",
      topic_key: "recall/synthesis",
      synthesis_type: "cross_evidence",
      summary: "Generic synthesis about recall.",
      evidence_refs: ["evidence-1", "evidence-2"],
      source_memory_refs: ["memory-1"],
      workspace_id: "workspace-1",
      run_id: "run-1",
      synthesis_status: SynthesisStatus.WORKING
    };
    const service = new RecallService({
      ...dependencies,
      memoryRepo: {
        ...dependencies.memoryRepo,
        searchByKeyword: vi.fn(async () => [
          { object_id: "memory-1", normalized_rank: 1 }
        ])
      },
      synthesisSearchPort: {
        searchByKeyword: vi.fn(async () => [
          { object_id: "synthesis-1", normalized_rank: 0.25 }
        ]),
        findByIds: vi.fn(async () => [synthesis])
      }
    });
    const policy = overridePolicy(service.buildDefaultPolicy("analyze", createTaskSurface().runtime_id), {
      fine_assessment: {
        budgets: {
          max_entries: 1,
          max_total_tokens: 1000,
          per_dimension_limits: null
        },
        conflict_awareness: false
      }
    });

    const result = await service.recall({
      taskSurface: {
        ...createTaskSurface(),
        display_name: "Cross-evidence synthesis recall implementation"
      },
      workspaceId: "workspace-1",
      strategy: "analyze",
      policyOverride: policy
    });

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual(["memory-1"]);
  });

  it("keeps memory_entry and synthesis_capsule streams namespaced when object ids collide", async () => {
    const sharedObjectId = "shared-object-1";
    const memories = [
      createMemoryEntry({
        object_id: sharedObjectId,
        scope_class: ScopeClass.PROJECT,
        dimension: MemoryDimension.PROCEDURE,
        content: "Cross-evidence synthesis recall implementation exact memory.",
        activation_score: 1
      })
    ];
    const { dependencies } = createDependencies(memories);
    const synthesis: SynthesisCapsule = {
      object_id: sharedObjectId,
      object_kind: "synthesis_capsule",
      schema_version: 1,
      lifecycle_state: "active",
      created_at: "2026-03-23T00:00:00.000Z",
      updated_at: "2026-03-23T00:00:00.000Z",
      created_by: "system",
      topic_key: "recall/synthesis",
      synthesis_type: "cross_evidence",
      summary: "Cross-evidence synthesis covering the recall implementation.",
      evidence_refs: ["evidence-1", "evidence-2"],
      source_memory_refs: [sharedObjectId],
      workspace_id: "workspace-1",
      run_id: "run-1",
      synthesis_status: SynthesisStatus.WORKING
    };
    const service = new RecallService({
      ...dependencies,
      memoryRepo: {
        ...dependencies.memoryRepo,
        searchByKeyword: vi.fn(async () => [
          { object_id: sharedObjectId, normalized_rank: 1 }
        ])
      },
      synthesisSearchPort: {
        searchByKeyword: vi.fn(async () => [
          { object_id: sharedObjectId, normalized_rank: 1 }
        ]),
        findByIds: vi.fn(async () => [synthesis])
      }
    });
    const policy = overridePolicy(service.buildDefaultPolicy("analyze", createTaskSurface().runtime_id), {
      fine_assessment: {
        budgets: {
          max_entries: 2,
          max_total_tokens: 1000,
          per_dimension_limits: null
        },
        conflict_awareness: false
      }
    });

    const result = await service.recall({
      taskSurface: {
        ...createTaskSurface(),
        display_name: "Cross-evidence synthesis recall implementation"
      },
      workspaceId: "workspace-1",
      strategy: "analyze",
      policyOverride: policy
    });

    expect(result.candidates.map((candidate) => `${candidate.object_kind}:${candidate.object_id}`))
      .toEqual(expect.arrayContaining([
        `memory_entry:${sharedObjectId}`,
        `synthesis_capsule:${sharedObjectId}`
      ]));
    const memoryDiagnostic = result.diagnostics?.candidates.find(
      (candidate) => candidate.candidate_key === `workspace_local:memory_entry:${sharedObjectId}`
    );
    const synthesisDiagnostic = result.diagnostics?.candidates.find(
      (candidate) => candidate.candidate_key === `workspace_local:synthesis_capsule:${sharedObjectId}`
    );

    expect(memoryDiagnostic?.per_stream_rank.lexical_fts).toBe(1);
    expect(memoryDiagnostic?.object_kind).toBe("memory_entry");
    expect(memoryDiagnostic?.per_stream_rank.synthesis_fts).toBeNull();
    expect(synthesisDiagnostic?.per_stream_rank.synthesis_fts).toBe(1);
    expect(synthesisDiagnostic?.object_kind).toBe("synthesis_capsule");
    expect(synthesisDiagnostic?.per_stream_rank.lexical_fts).toBeNull();
    expect(synthesisDiagnostic?.per_stream_rank.existing_score).toBeNull();
  });

  it("degrades cleanly to memory_entry-only when no synthesis port is wired", async () => {
    const memories = [
      createMemoryEntry({
        object_id: "memory-1",
        scope_class: ScopeClass.PROJECT,
        dimension: MemoryDimension.PROCEDURE,
        activation_score: 0.9
      })
    ];
    const { dependencies } = createDependencies(memories);
    const service = new RecallService(dependencies);

    const result = await service.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "build"
    });

    expect(
      result.candidates.every((candidate) => candidate.object_kind === "memory_entry")
    ).toBe(true);
  });

  it("reserves tail delivery slots for top synthesis below the fused-rank cut", async () => {
    // Eight memory_entry rows with strong lexical hits win fused rank
    // outright (multi-stream RRF). A synthesis fires on synthesis_fts only,
    // so without the reserve no synthesis reaches the delivery budget.
    const memories = Array.from({ length: 8 }, (_unused, index) =>
      createMemoryEntry({
        object_id: `memory-${index + 1}`,
        scope_class: ScopeClass.PROJECT,
        dimension: MemoryDimension.PROCEDURE,
        content: "Cross-evidence synthesis recall implementation exact memory.",
        activation_score: 1
      })
    );
    const { dependencies } = createDependencies(memories);
    const buildSynthesis = (id: string): SynthesisCapsule => ({
      object_id: id,
      object_kind: "synthesis_capsule",
      schema_version: 1,
      lifecycle_state: "active",
      created_at: "2026-03-23T00:00:00.000Z",
      updated_at: "2026-03-23T00:00:00.000Z",
      created_by: "system",
      topic_key: `recall/${id}`,
      synthesis_type: "cross_evidence",
      summary: `Cross-evidence synthesis recall implementation ${id}.`,
      evidence_refs: ["evidence-1", "evidence-2"],
      source_memory_refs: [],
      workspace_id: "workspace-1",
      run_id: "run-1",
      synthesis_status: SynthesisStatus.WORKING
    });
    const synthesisRows = ["synthesis-1", "synthesis-2", "synthesis-3"].map(buildSynthesis);
    const service = new RecallService({
      ...dependencies,
      memoryRepo: {
        ...dependencies.memoryRepo,
        searchByKeyword: vi.fn(async () =>
          memories.map((memory, index) => ({
            object_id: memory.object_id,
            normalized_rank: 1 - index * 0.05
          }))
        )
      },
      synthesisSearchPort: {
        searchByKeyword: vi.fn(async () => [
          { object_id: "synthesis-1", normalized_rank: 1 },
          { object_id: "synthesis-2", normalized_rank: 0.8 },
          { object_id: "synthesis-3", normalized_rank: 0.2 }
        ]),
        findByIds: vi.fn(async () => synthesisRows)
      }
    });
    const policy = overridePolicy(service.buildDefaultPolicy("analyze", createTaskSurface().runtime_id), {
      fine_assessment: {
        budgets: { max_entries: 5, max_total_tokens: 4000, per_dimension_limits: null },
        conflict_awareness: false
      }
    });

    const result = await service.recall({
      taskSurface: {
        ...createTaskSurface(),
        display_name: "Cross-evidence synthesis recall implementation"
      },
      workspaceId: "workspace-1",
      strategy: "analyze",
      policyOverride: policy
    });

    const delivered = result.candidates;
    expect(delivered.length).toBe(5);
    // Exactly the reserve count, the top synthesis by FTS rank, tail-placed.
    expect(
      delivered
        .filter((candidate) => candidate.object_kind === "synthesis_capsule")
        .map((candidate) => candidate.object_id)
    ).toEqual(["synthesis-1", "synthesis-2"]);
    expect(delivered.slice(-2).map((candidate) => candidate.object_kind)).toEqual([
      "synthesis_capsule",
      "synthesis_capsule"
    ]);
    expect(delivered.slice(0, 3).every((candidate) => candidate.object_kind === "memory_entry")).toBe(
      true
    );
  });

  describe("entity_seed plane", () => {
    it("admits FTS hits for extracted entities on the entity_seed plane and fans into graph_expansion", async () => {
      const memories = [
        createMemoryEntry({
          object_id: "memory-anchor",
          dimension: MemoryDimension.PROCEDURE,
          scope_class: ScopeClass.PROJECT,
          domain_tags: ["repo"],
          content: "MaterializationRouter binds memory creation."
        }),
        createMemoryEntry({
          object_id: "memory-neighbor",
          dimension: MemoryDimension.FACT,
          scope_class: ScopeClass.PROJECT,
          domain_tags: ["repo"],
          content: "Downstream consumer of MaterializationRouter outcomes."
        })
      ];
      const { dependencies } = createDependencies(memories);
      const searchByKeywordWithinObjectIds = vi.fn(async (_workspace: string, query: string) => {
        if (query.toLowerCase().includes("materializationrouter")) {
          return [{ object_id: "memory-anchor", normalized_rank: 0.9 }];
        }
        return [];
      });
      const findByMemoryId = vi.fn(async (memoryId: string) => {
        if (memoryId === "memory-anchor") {
          return [
            {
              object_id: "edge-1",
              object_kind: "memory_graph_edge" as const,
              schema_version: 1,
              lifecycle_state: "active" as const,
              created_at: "2026-03-23T00:00:00.000Z",
              updated_at: "2026-03-23T00:00:00.000Z",
              created_by: "system",
              workspace_id: "workspace-1",
              edge_type: "derives_from" as const,
              source_memory_id: "memory-anchor",
              target_memory_id: "memory-neighbor",
              confidence: 0.8
            }
          ];
        }
        return [];
      });

      const service = new RecallService({
        ...dependencies,
        memoryRepo: {
          ...dependencies.memoryRepo,
          searchByKeywordWithinObjectIds
        },
        graphExpansionPort: {
          findByMemoryId
        },
        entityExtractionPort: {
          extract: async () => [
            // Quoted kind (confidence 1.0) clears the
            // ENTITY_GRAPH_EXPANSION_CONFIDENCE_FLOOR — strong entities are
            // eligible to seed graph_expansion fan-in. Weak kinds
            // (proper_noun=0.7 / cjk_phrase=0.6 / unknown=0.35) are
            // covered by the dedicated isWeakEntityOnlyDraft tests below.
            // see also: packages/core/src/entity-extraction-rules.ts CONFIDENCE_QUOTED
            Object.freeze({
              surface: "MaterializationRouter",
              normalized: "materializationrouter",
              kind: "quoted" as const,
              confidence: 1.0
            })
          ]
        }
      });

      const result = await service.recall({
        taskSurface: {
          ...createTaskSurface(),
          display_name: "How does MaterializationRouter coordinate writes?"
        },
        workspaceId: "workspace-1",
        strategy: "chat"
      });

      const ids = new Set(result.candidates.map((c) => c.object_id));
      expect(ids.has("memory-anchor")).toBe(true);
      expect(ids.has("memory-neighbor")).toBe(true);

      const anchorDiag = result.diagnostics?.candidates.find(
        (c) => c.object_id === "memory-anchor"
      );
      expect(anchorDiag?.admission_planes).toContain("entity_seed");

      const neighborDiag = result.diagnostics?.candidates.find(
        (c) => c.object_id === "memory-neighbor"
      );
      expect(neighborDiag?.admission_planes).toContain("graph_expansion");

      expect(findByMemoryId).toHaveBeenCalledWith("memory-anchor", "workspace-1");
    });

    it("is a no-op when entityExtractionPort is not wired", async () => {
      const memories = [
        createMemoryEntry({
          object_id: "memory-x",
          content: "MaterializationRouter binds memory creation."
        })
      ];
      const { dependencies } = createDependencies(memories);
      const searchByKeywordWithinObjectIds = vi.fn(async () => [
        { object_id: "memory-x", normalized_rank: 0.9 }
      ]);
      const service = new RecallService({
        ...dependencies,
        memoryRepo: {
          ...dependencies.memoryRepo,
          searchByKeywordWithinObjectIds
        }
      });

      const result = await service.recall({
        taskSurface: {
          ...createTaskSurface(),
          display_name: "MaterializationRouter behavior"
        },
        workspaceId: "workspace-1",
        strategy: "chat"
      });

      const diag = result.diagnostics?.candidates.find((c) => c.object_id === "memory-x");
      expect(diag?.admission_planes ?? []).not.toContain("entity_seed");
    });

    it("never writes propose/accept paths from entity-seed admissions", async () => {
      // Truth-boundary regression. proposeMemory / reviewMemoryProposal /
      // memoryRepo.update are not exposed here; this test asserts that the
      // entity helper only emits append-only candidate diagnostics — no
      // governance event is written. The appendSpy comes from createDependencies
      // and tracks every event-log append; we filter for any SOUL_PROPOSAL_* /
      // SOUL_MEMORY_UPDATED variant to catch a leak. The memoryRepo wired by
      // createDependencies exposes only read methods (findByWorkspaceId /
      // findByDimension / findByScopeClass) — surfacing a write method here
      // would be a typed contract break, so the stricter assertion is that
      // the event log received zero writes of any governance kind.
      const memories = [
        createMemoryEntry({
          object_id: "memory-truth",
          content: "MaterializationRouter binds memory creation."
        })
      ];
      const { dependencies, appendSpy } = createDependencies(memories);
      const searchByKeywordWithinObjectIds = vi.fn(async () => [
        { object_id: "memory-truth", normalized_rank: 0.9 }
      ]);
      const service = new RecallService({
        ...dependencies,
        memoryRepo: {
          ...dependencies.memoryRepo,
          searchByKeywordWithinObjectIds
        },
        entityExtractionPort: {
          extract: async () => [
            Object.freeze({
              surface: "MaterializationRouter",
              normalized: "materializationrouter",
              kind: "proper_noun" as const,
              confidence: 0.7
            })
          ]
        }
      });

      await service.recall({
        taskSurface: {
          ...createTaskSurface(),
          display_name: "MaterializationRouter behavior"
        },
        workspaceId: "workspace-1",
        strategy: "chat"
      });

      const writtenEventTypes = appendSpy.mock.calls.map(
        (args: readonly unknown[]) => (args[0] as { event_type: string }).event_type
      );
      // invariant: recall read path emits zero MemoryGovernanceEventType
      // mutation events; only RECALL_CONTEXT diagnostic events are allowed.
      // invariant: blacklist derives from MemoryGovernanceEventType enum
      // values via the mutation-suffix regex below; the enum is the
      // single source of truth, not a hand-curated string list.
      // see also: docs/handbook/invariants.md (memory ontology = durable truth)
      // see also: packages/protocol/src/events/memory-governance.ts
      const TRUTH_MUTATION_EVENT_TYPES = new Set<string>(
        Object.values(MemoryGovernanceEventType).filter((value) =>
          // anchor: include `completed` for SOUL_REVIEW_COMPLETED. A
          // review completion transitions a proposal to a settled
          // state — semantically a truth mutation, even though the
          // suffix differs from the create/update family. recall is
          // read-only and must not emit it.
          /\.(created|updated|deleted|retired|resolved|archived|completed|state_changed|tier_changed|tier_promoted|retention_updated|manifestation_changed|status_changed|promoted|health_changed|lifecycle_changed|contested|won|superseded)$/.test(
            value
          )
        )
      );
      expect(
        writtenEventTypes.filter((kind: string) => TRUTH_MUTATION_EVENT_TYPES.has(kind))
      ).toEqual([]);
    });

    it("entity_seed admissions still pass the deterministic scope/dimension filter", async () => {
      // invariant: entity_seed admissions must pass matchesDeterministicFilter
      // (scope_class / dimension / domain_tag). An in-tier memory whose
      // dimension does not match the strategy's deterministic filter must
      // not leak into recall just because its surface name appears in the
      // query and an entity extractor picks it up.
      // see also: packages/core/src/recall-service.ts addCandidate filter gate
      const memories = [
        createMemoryEntry({
          object_id: "memory-in-scope",
          dimension: MemoryDimension.PROCEDURE,
          scope_class: ScopeClass.PROJECT,
          domain_tags: ["repo"],
          content: "MaterializationRouter binds memory creation."
        }),
        createMemoryEntry({
          object_id: "memory-off-scope",
          // PREFERENCE dimension is filtered out by the explicit
          // dimension_filter policy override below; the entity_seed plane
          // must not punch a hole in that gate.
          dimension: MemoryDimension.PREFERENCE,
          scope_class: ScopeClass.PROJECT,
          domain_tags: ["repo"],
          content: "MaterializationRouter mentioned elsewhere."
        })
      ];
      const { dependencies } = createDependencies(memories);
      // Lexical FTS uses the unmodified queryText; the entity helper queries
      // by the extracted surface only. Returning the off-scope hit ONLY for
      // the entity-surface query isolates the entity_seed plane as the sole
      // admission path for memory-off-scope; the existing "lexical" plane
      // bypass of the deterministic filter cannot mask the regression.
      const searchByKeywordWithinObjectIds = vi.fn(async (_workspace: string, query: string) => {
        if (query === "MaterializationRouter") {
          return [
            { object_id: "memory-in-scope", normalized_rank: 0.9 },
            { object_id: "memory-off-scope", normalized_rank: 0.9 }
          ];
        }
        return [];
      });

      const service = new RecallService({
        ...dependencies,
        memoryRepo: {
          ...dependencies.memoryRepo,
          searchByKeywordWithinObjectIds
        },
        entityExtractionPort: {
          extract: async () => [
            Object.freeze({
              surface: "MaterializationRouter",
              normalized: "materializationrouter",
              kind: "proper_noun" as const,
              confidence: 0.7
            })
          ]
        }
      });
      const basePolicy = service.buildDefaultPolicy("chat", createTaskSurface().runtime_id);
      const policy = overridePolicy(basePolicy, {
        coarse_filter: {
          ...basePolicy.coarse_filter,
          deterministic_match: {
            ...basePolicy.coarse_filter.deterministic_match,
            dimension_filter: [MemoryDimension.PROCEDURE]
          }
        }
      });

      const result = await service.recall({
        taskSurface: {
          ...createTaskSurface(),
          display_name: "coordinate writes"
        },
        workspaceId: "workspace-1",
        strategy: "chat",
        policyOverride: policy
      });

      const ids = new Set(result.candidates.map((c) => c.object_id));
      // The off-scope PREFERENCE memory must never appear — entity_seed
      // is not a deterministic-filter bypass.
      expect(ids.has("memory-off-scope")).toBe(false);
    });

    it("does not double-count fusion when the same memory hits lexical_fts and entity_seed", async () => {
      // invariant: when a memory is already ranked on lexical_fts, the
      // entity_seed RRF rank for that memory must be zero so a single
      // attacker-controllable surface term cannot claim two fusion-stream
      // rank slots. The memory still admits on the entity_seed plane
      // (the diagnostic distinguishes entity-only from entity+lexical),
      // but the entity_seed stream contribution is null.
      // see also: collectEntityDerivedSeeds lexicalFtsRanks dedup
      const memories = [
        createMemoryEntry({
          object_id: "memory-overlap",
          dimension: MemoryDimension.PROCEDURE,
          scope_class: ScopeClass.PROJECT,
          domain_tags: ["repo"],
          content: "MaterializationRouter binds memory creation."
        })
      ];
      const { dependencies } = createDependencies(memories);
      // searchByKeywordWithinObjectIds is called for both the lexical FTS
      // supplement AND the entity-seed pass. Both return the same memory,
      // simulating a single surface term getting two FTS rank contributions.
      const searchByKeywordWithinObjectIds = vi.fn(async () => [
        { object_id: "memory-overlap", normalized_rank: 0.9 }
      ]);

      const service = new RecallService({
        ...dependencies,
        memoryRepo: {
          ...dependencies.memoryRepo,
          searchByKeywordWithinObjectIds
        },
        entityExtractionPort: {
          extract: async () => [
            Object.freeze({
              surface: "MaterializationRouter",
              normalized: "materializationrouter",
              kind: "proper_noun" as const,
              confidence: 0.7
            })
          ]
        }
      });

      const result = await service.recall({
        taskSurface: {
          ...createTaskSurface(),
          display_name: "MaterializationRouter behavior"
        },
        workspaceId: "workspace-1",
        strategy: "chat"
      });

      const diag = result.diagnostics?.candidates.find(
        (c) => c.object_id === "memory-overlap"
      );
      // Plane admission diagnostic still records entity_seed alongside
      // lexical — the dedup happens at the RRF contribution layer, not at
      // admission.
      expect(diag?.admission_planes).toContain("lexical");
      expect(diag?.admission_planes).toContain("entity_seed");
      // entity_seed contribution is zero when there is a lexical_fts hit
      // on the same memory; the entity_seed per-stream rank is null
      // (filtered out at fusion because the stream score is 0).
      const entitySeedContribution =
        diag?.fused_rank_contribution_per_stream?.entity_seed ?? 0;
      expect(entitySeedContribution).toBe(0);
      expect(diag?.per_stream_rank?.entity_seed ?? null).toBeNull();
      // lexical_fts contribution is non-zero — the surface match still
      // earns its single fusion slot.
      const lexicalContribution =
        diag?.fused_rank_contribution_per_stream?.lexical_fts ?? 0;
      expect(lexicalContribution).toBeGreaterThan(0);
    });

    it("excludes a weak entity-only draft from graph_expansion fan-in (Fix-5b path 1)", async () => {
      // invariant: when the only non-activation admission is entity_seed
      // and the strongest entity confidence is below
      // ENTITY_GRAPH_EXPANSION_CONFIDENCE_FLOOR (0.85), the draft must NOT
      // seed graph_expansion. Without this gate, a weak cjk_phrase /
      // proper_noun surface (confidence 0.35-0.7) admitted ONLY on
      // entity_seed would still feed selectExpansionSeedDrafts (path 1) and
      // compound surface manipulation across 1-hop neighbors.
      // see also: packages/core/src/recall-service.ts isWeakEntityOnlyDraft
      const memories = [
        createMemoryEntry({
          object_id: "memory-anchor",
          dimension: MemoryDimension.PROCEDURE,
          scope_class: ScopeClass.PROJECT,
          domain_tags: ["repo"],
          content: "MaterializationRouter binds memory creation."
        }),
        createMemoryEntry({
          object_id: "memory-neighbor",
          dimension: MemoryDimension.FACT,
          scope_class: ScopeClass.PROJECT,
          domain_tags: ["repo"],
          content: "Downstream consumer of MaterializationRouter outcomes."
        })
      ];
      const { dependencies } = createDependencies(memories);
      // searchByKeyword is only hit by the entity-seed pass (queried with
      // the surface "MaterializationRouter"). Returning nothing for any
      // other query isolates the entity_seed plane as the sole admission
      // path for memory-anchor — no lexical / object_probe / evidence
      // overlap can co-admit and rescue it past the weak-entity-only check.
      const searchByKeywordWithinObjectIds = vi.fn(
        async (_workspace: string, query: string) => {
          if (query === "MaterializationRouter") {
            return [{ object_id: "memory-anchor", normalized_rank: 0.9 }];
          }
          return [];
        }
      );
      const findByMemoryId = vi.fn(async (memoryId: string) => {
        if (memoryId === "memory-anchor") {
          return [
            {
              object_id: "edge-1",
              object_kind: "memory_graph_edge" as const,
              schema_version: 1,
              lifecycle_state: "active" as const,
              created_at: "2026-03-23T00:00:00.000Z",
              updated_at: "2026-03-23T00:00:00.000Z",
              created_by: "system",
              workspace_id: "workspace-1",
              edge_type: "derives_from" as const,
              source_memory_id: "memory-anchor",
              target_memory_id: "memory-neighbor",
              confidence: 0.8
            }
          ];
        }
        return [];
      });

      const service = new RecallService({
        ...dependencies,
        memoryRepo: {
          ...dependencies.memoryRepo,
          searchByKeywordWithinObjectIds
        },
        graphExpansionPort: { findByMemoryId },
        entityExtractionPort: {
          extract: async () => [
            Object.freeze({
              surface: "MaterializationRouter",
              normalized: "materializationrouter",
              kind: "proper_noun" as const,
              // 0.7 < 0.85 floor.
              confidence: 0.7
            })
          ]
        }
      });

      const result = await service.recall({
        taskSurface: {
          ...createTaskSurface(),
          // Deliberately avoid mentioning the entity surface so the
          // tier-level activation does not pre-admit memory-anchor on a
          // non-entity plane and accidentally satisfy the gate.
          display_name: "describe the binding"
        },
        workspaceId: "workspace-1",
        strategy: "chat"
      });

      const anchorDiag = result.diagnostics?.candidates.find(
        (c) => c.object_id === "memory-anchor"
      );
      // The anchor still admits on the entity_seed plane (diagnostics
      // distinguish the entity-seed-only case).
      expect(anchorDiag?.admission_planes).toContain("entity_seed");
      // invariant: the weak entity-only anchor must NEVER be asked to fan
      // into graph_expansion. Other unrelated tier memories may still be
      // ranked as seeds by selectExpansionSeedDrafts via their own non-
      // entity admission planes (activation / lexical), so the assertion
      // is targeted at this specific seed memory, not at the port at all.
      const anchorFanCalls = findByMemoryId.mock.calls.filter(
        (call) => call[0] === "memory-anchor"
      );
      expect(anchorFanCalls).toEqual([]);
    });

    it("admits a weak entity into graph_expansion when a co-admitting plane carries it (Fix-5b)", async () => {
      // invariant: the weak-entity-only floor in selectExpansionSeedDrafts
      // ONLY excludes drafts whose sole non-activation admission is
      // entity_seed. A weak entity that is also admitted via lexical_fts
      // (or evidence_anchor, source_proximity, etc.) survives — the
      // co-admitting plane is independent corroboration that the surface
      // is meaningfully present in the corpus.
      // see also: packages/core/src/recall-service.ts isWeakEntityOnlyDraft
      const memories = [
        createMemoryEntry({
          object_id: "memory-anchor",
          dimension: MemoryDimension.PROCEDURE,
          scope_class: ScopeClass.PROJECT,
          domain_tags: ["repo"],
          content: "MaterializationRouter binds memory creation."
        }),
        createMemoryEntry({
          object_id: "memory-neighbor",
          dimension: MemoryDimension.FACT,
          scope_class: ScopeClass.PROJECT,
          domain_tags: ["repo"],
          content: "Downstream consumer of MaterializationRouter outcomes."
        })
      ];
      const { dependencies } = createDependencies(memories);
      // searchByKeywordWithinObjectIds is called for both the lexical FTS
      // supplement (queryText) AND the entity-seed pass (entity surface).
      // The same hit shows up on BOTH lanes — entity_seed admits the
      // anchor AND lexical co-admits it. The weak-entity-only gate must
      // not fire because a non-entity plane co-admitted.
      const searchByKeywordWithinObjectIds = vi.fn(async () => [
        { object_id: "memory-anchor", normalized_rank: 0.9 }
      ]);
      const findByMemoryId = vi.fn(async (memoryId: string) => {
        if (memoryId === "memory-anchor") {
          return [
            {
              object_id: "edge-1",
              object_kind: "memory_graph_edge" as const,
              schema_version: 1,
              lifecycle_state: "active" as const,
              created_at: "2026-03-23T00:00:00.000Z",
              updated_at: "2026-03-23T00:00:00.000Z",
              created_by: "system",
              workspace_id: "workspace-1",
              edge_type: "derives_from" as const,
              source_memory_id: "memory-anchor",
              target_memory_id: "memory-neighbor",
              confidence: 0.8
            }
          ];
        }
        return [];
      });

      const service = new RecallService({
        ...dependencies,
        memoryRepo: {
          ...dependencies.memoryRepo,
          searchByKeywordWithinObjectIds
        },
        graphExpansionPort: { findByMemoryId },
        entityExtractionPort: {
          extract: async () => [
            Object.freeze({
              surface: "MaterializationRouter",
              normalized: "materializationrouter",
              kind: "proper_noun" as const,
              // Weak per Fix-5b's gate.
              confidence: 0.7
            })
          ]
        }
      });

      const result = await service.recall({
        taskSurface: {
          ...createTaskSurface(),
          // Include the surface so the lexical FTS supplement also returns
          // the anchor — that is the "co-admitting plane" survival path.
          display_name: "How does MaterializationRouter coordinate writes?"
        },
        workspaceId: "workspace-1",
        strategy: "chat"
      });

      const anchorDiag = result.diagnostics?.candidates.find(
        (c) => c.object_id === "memory-anchor"
      );
      // Confirm BOTH planes admitted — this is the precondition for the
      // co-admitting-plane survival branch to apply.
      expect(anchorDiag?.admission_planes).toContain("entity_seed");
      expect(anchorDiag?.admission_planes).toContain("lexical");
      // With co-admission present, the weak entity confidence does not
      // block graph_expansion fan-in.
      const neighborDiag = result.diagnostics?.candidates.find(
        (c) => c.object_id === "memory-neighbor"
      );
      expect(neighborDiag?.admission_planes).toContain("graph_expansion");
      expect(findByMemoryId).toHaveBeenCalledWith("memory-anchor", "workspace-1");
    });

    it("does not let a weak entity-only draft leak into content_expansion (evidence_anchor + domain_tag_cluster)", async () => {
      // invariant: selectPreferredExpansionSeedEntries — which feeds the
      // evidence_anchor and domain_tag_cluster planes inside
      // addContentDerivedExpansionCandidates — must apply the same
      // weak-entity-only filter as selectExpansionSeedDrafts. Today
      // the entity_seed admission pass runs AFTER content expansion,
      // so the gap is latent at this exact call ordering. The filter
      // is defense-in-depth so any future reordering (or a follow-up
      // path that calls selectPreferredExpansionSeedEntries after
      // entity_seed has fired) cannot silently leak weak cjk_phrase /
      // proper_noun surfaces (confidence below
      // ENTITY_GRAPH_EXPANSION_CONFIDENCE_FLOOR) into evidence/tag
      // fan-out — the same surface manipulation the graph_expansion
      // floor blocks must stay blocked here.
      // This test asserts the externally-observable shape: a tier
      // memory hit only by the weak entity surface must not fan
      // evidence_anchor / domain_tag_cluster admissions to unrelated
      // tier memories that merely share evidence_refs / domain_tags.
      // see also: packages/core/src/recall-service.ts
      //   isWeakEntityOnlyDraft, selectPreferredExpansionSeedEntries
      const memories = [
        createMemoryEntry({
          object_id: "memory-weak-anchor",
          dimension: MemoryDimension.PROCEDURE,
          scope_class: ScopeClass.PROJECT,
          domain_tags: ["weak-anchor-rare-tag"],
          evidence_refs: ["evidence-weak-anchor-shared"],
          content: "MaterializationRouter binds memory creation."
        }),
        createMemoryEntry({
          object_id: "memory-evidence-target",
          dimension: MemoryDimension.FACT,
          scope_class: ScopeClass.PROJECT,
          // Disjoint tag set keeps domain_tag_cluster from co-admitting
          // this memory; only evidence_refs overlap with the weak anchor.
          domain_tags: ["unrelated-tag-A"],
          evidence_refs: ["evidence-weak-anchor-shared"],
          content: "Unrelated downstream observation."
        }),
        createMemoryEntry({
          object_id: "memory-tag-target",
          dimension: MemoryDimension.FACT,
          scope_class: ScopeClass.PROJECT,
          domain_tags: ["weak-anchor-rare-tag"],
          // Disjoint evidence_refs keeps evidence_anchor from
          // co-admitting; only the rare tag overlaps with the anchor.
          evidence_refs: ["evidence-unrelated"],
          content: "Unrelated tagged observation."
        })
      ];
      const { dependencies } = createDependencies(memories);
      // searchByKeywordWithinObjectIds returns only the weak anchor on
      // the entity surface "MaterializationRouter" — no other lane hits
      // memory-weak-anchor, so its sole non-activation admission is
      // entity_seed.
      const searchByKeywordWithinObjectIds = vi.fn(
        async (_workspace: string, query: string) => {
          if (query === "MaterializationRouter") {
            return [{ object_id: "memory-weak-anchor", normalized_rank: 0.9 }];
          }
          return [];
        }
      );

      const service = new RecallService({
        ...dependencies,
        memoryRepo: {
          ...dependencies.memoryRepo,
          searchByKeywordWithinObjectIds
        },
        entityExtractionPort: {
          extract: async () => [
            Object.freeze({
              surface: "MaterializationRouter",
              normalized: "materializationrouter",
              kind: "proper_noun" as const,
              // 0.7 < 0.85 floor → isWeakEntityOnlyDraft = true.
              confidence: 0.7
            })
          ]
        }
      });

      const result = await service.recall({
        taskSurface: {
          ...createTaskSurface(),
          // Avoid mentioning the entity surface so the lexical lane
          // does not co-admit and rescue memory-weak-anchor.
          display_name: "describe the binding"
        },
        workspaceId: "workspace-1",
        strategy: "chat"
      });

      const anchorDiag = result.diagnostics?.candidates.find(
        (c) => c.object_id === "memory-weak-anchor"
      );
      // Precondition: weak anchor still admits on the entity_seed plane.
      expect(anchorDiag?.admission_planes).toContain("entity_seed");

      const evidenceTargetDiag = result.diagnostics?.candidates.find(
        (c) => c.object_id === "memory-evidence-target"
      );
      const tagTargetDiag = result.diagnostics?.candidates.find(
        (c) => c.object_id === "memory-tag-target"
      );
      // invariant under test: the weak entity-only anchor must NOT
      // seed evidence_anchor or domain_tag_cluster expansion. Either
      // the targets are not admitted at all, or their admission_planes
      // do not include the content-expansion planes seeded by the
      // weak anchor.
      expect(evidenceTargetDiag?.admission_planes ?? []).not.toContain("evidence_anchor");
      expect(tagTargetDiag?.admission_planes ?? []).not.toContain("domain_tag_cluster");
    });
  });
});

describe("RecallService embedding-on coarse injection", () => {
  // A memory whose content shares no lexical token with the recall query, so
  // coarse FTS / deterministic filtering never admits it. The only path that
  // can surface it is the embedding-on workspace cosine-neighbor injection.
  const lexicallyAbsentMemory = createMemoryEntry({
    object_id: "22222222-2222-4222-8222-222222222222",
    content: "Quarterly revenue figures for the Helsinki office.",
    activation_score: 0.05
  });

  function buildEmbeddingScopedService(input: {
    readonly collectWorkspaceNeighbors?: ReturnType<typeof vi.fn>;
    readonly findByIds?: ReturnType<typeof vi.fn>;
  }) {
    const { dependencies } = createDependencies([lexicallyAbsentMemory]);
    return new RecallService({
      ...dependencies,
      memoryRepo: {
        ...dependencies.memoryRepo,
        ...(input.findByIds === undefined ? {} : { findByIds: input.findByIds })
      },
      embeddingRecallService: {
        hasStoredVectors: vi.fn(async () => true),
        prepareQueryEmbedding: vi.fn(() => createPreparedQueryHandle("prepared-embedding-injection")),
        querySupplementIfReady: vi.fn(async () => ({
          supplementaryEntries: Object.freeze([]),
          similarityHintsByObjectId: Object.freeze({})
        })),
        querySupplement: vi.fn(async () => ({
          supplementaryEntries: Object.freeze([]),
          similarityHintsByObjectId: Object.freeze({})
        })),
        ...(input.collectWorkspaceNeighbors === undefined
          ? {}
          : { collectWorkspaceNeighbors: input.collectWorkspaceNeighbors })
      }
    });
  }

  function buildPolicy(service: RecallService, embeddingEnabled: boolean) {
    const basePolicy = service.buildDefaultPolicy("analyze", createTaskSurface().runtime_id);
    return overridePolicy(basePolicy, {
      coarse_filter: {
        ...basePolicy.coarse_filter,
        // Activation floor above the fixture memory's score keeps it out of
        // the precomputed-rank plane; with no lexical / evidence overlap the
        // only path into the pool is the embedding-on neighbor injection.
        precomputed_rank: {
          ...basePolicy.coarse_filter.precomputed_rank,
          min_activation_score: 0.5
        },
        semantic_supplement: {
          enabled: true,
          max_supplement: 5,
          embedding_enabled: embeddingEnabled
        }
      }
    });
  }

  it("does not call the workspace neighbor scan when embedding is disabled", async () => {
    const collectWorkspaceNeighbors = vi.fn(async () => [
      Object.freeze({ object_id: lexicallyAbsentMemory.object_id, normalized_similarity: 0.95 })
    ]);
    const findByIds = vi.fn(async () => [lexicallyAbsentMemory]);
    const service = buildEmbeddingScopedService({ collectWorkspaceNeighbors, findByIds });

    const result = await service.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "analyze",
      policyOverride: buildPolicy(service, false)
    });

    expect(collectWorkspaceNeighbors).not.toHaveBeenCalled();
    expect(findByIds).not.toHaveBeenCalled();
    expect(
      result.candidates.some((candidate) => candidate.object_id === lexicallyAbsentMemory.object_id)
    ).toBe(false);
  });

  it("injects a lexically-absent cosine neighbor as a coarse candidate when embedding is enabled", async () => {
    const collectWorkspaceNeighbors = vi.fn(async () => [
      Object.freeze({ object_id: lexicallyAbsentMemory.object_id, normalized_similarity: 0.95 })
    ]);
    const findByIds = vi.fn(async () => [lexicallyAbsentMemory]);
    const service = buildEmbeddingScopedService({ collectWorkspaceNeighbors, findByIds });

    const result = await service.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "analyze",
      policyOverride: buildPolicy(service, true)
    });

    expect(collectWorkspaceNeighbors).toHaveBeenCalledTimes(1);
    const injected = result.candidates.find(
      (candidate) => candidate.object_id === lexicallyAbsentMemory.object_id
    );
    expect(injected).toBeDefined();
    expect(injected?.source_channels).toContain("semantic_supplement");
    expect(injected?.score_factors?.embedding_similarity).toBeCloseTo(0.95, 5);
  });

  it("recalls nothing extra when the embedding service exposes no neighbor scan", async () => {
    const service = buildEmbeddingScopedService({});
    const result = await service.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "analyze",
      policyOverride: buildPolicy(service, true)
    });
    expect(
      result.candidates.some((candidate) => candidate.object_id === lexicallyAbsentMemory.object_id)
    ).toBe(false);
  });
});
