import { describe, expect, it, vi } from "vitest";
import {
  ControlPlaneObjectKind,
  MemoryDimension,
  ObjectLifecycleState,
  Phase3AEventType,
  ProjectMappingState,
  RetentionPolicy,
  ScopeClass,
  type EventLogEntry,
  type MemoryEntry,
  type ProjectMappingAnchor,
  type RecallPolicy,
  type Slot,
  type TaskObjectSurface
} from "@do-what/protocol";
import {
  RecallService,
  classifyGlobalCandidate,
  type RecallServiceDependencies
} from "../recall-service.js";

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
  claimSourceRefs: Readonly<Record<string, readonly string[]>> = {}
): {
  readonly dependencies: RecallServiceDependencies;
  readonly appendSpy: ReturnType<typeof vi.fn>;
  readonly warnSpy: ReturnType<typeof vi.fn>;
} {
  const appendSpy = vi.fn(async (event: Omit<EventLogEntry, "event_id" | "created_at">) => ({
    event_id: `event-${event.event_type}`,
    created_at: "2026-03-23T00:00:00.000Z",
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

    const collidingCandidates = result.candidates.filter(
      (candidate) => candidate.object_id === sharedObjectId
    );
    expect(collidingCandidates).toHaveLength(2);
    expect(collidingCandidates.map((candidate) => candidate.origin_plane).sort()).toEqual([
      "global",
      "workspace_local"
    ]);
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

  it("applies coarse scope filters to optional global-source candidates while keeping protected dimensions", async () => {
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
    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual(["global-hazard"]);
    expect(result.candidates[0]).toMatchObject({
      object_id: "global-hazard",
      dimension: MemoryDimension.HAZARD,
      origin_plane: "global"
    });
    expect(recordClassifications).toHaveBeenCalledWith([
      {
        workspaceId: "workspace-1",
        globalObjectId: "global-procedure",
        classification: "excluded"
      },
      {
        workspaceId: "workspace-1",
        globalObjectId: "global-hazard",
        classification: "included"
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
    const service = new RecallService(dependencies);

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

  it("build strategy only returns project scope plus protected quota", async () => {
    const memories = [
      createMemoryEntry({ object_id: "memory-1", scope_class: ScopeClass.PROJECT, dimension: MemoryDimension.PROCEDURE, activation_score: 0.8 }),
      createMemoryEntry({ object_id: "memory-2", scope_class: ScopeClass.GLOBAL_DOMAIN, dimension: MemoryDimension.PROCEDURE, activation_score: 0.9 }),
      createMemoryEntry({ object_id: "memory-3", scope_class: ScopeClass.GLOBAL_DOMAIN, dimension: MemoryDimension.HAZARD, activation_score: 0.01 })
    ];
    const { dependencies } = createDependencies(memories);
    const service = new RecallService(dependencies);

    const result = await service.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "build"
    });

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual(["memory-3", "memory-1"]);
    expect(result.candidates.every((candidate) => candidate.scope_class === ScopeClass.PROJECT || candidate.dimension === MemoryDimension.HAZARD)).toBe(true);
  });

  it("build strategy only returns constraint procedure hazard dimensions", async () => {
    const memories = [
      createMemoryEntry({ object_id: "memory-1", dimension: MemoryDimension.PROCEDURE, activation_score: 0.7 }),
      createMemoryEntry({ object_id: "memory-2", dimension: MemoryDimension.PREFERENCE, activation_score: 0.9 }),
      createMemoryEntry({ object_id: "memory-3", dimension: MemoryDimension.CONSTRAINT, activation_score: 0.01 })
    ];
    const { dependencies } = createDependencies(memories);
    const service = new RecallService(dependencies);

    const result = await service.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "build"
    });

    expect(result.candidates.map((candidate) => candidate.dimension)).toEqual([
      MemoryDimension.CONSTRAINT,
      MemoryDimension.PROCEDURE
    ]);
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
    expect(recordPrecheckDegraded).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      runId: null,
      reason: "local_vector_lookup_failed",
      baseCandidateCount: 1,
      fallbackCandidateCount: 1
    });
    expect(prepareQueryEmbedding).not.toHaveBeenCalled();
    expect(querySupplementIfReady).not.toHaveBeenCalled();
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
        event_type: Phase3AEventType.SOUL_RECALL_COMPLETED,
        entity_type: "task_object_surface",
        entity_id: createTaskSurface().runtime_id,
        run_id: "run-1"
      })
    );
  });
});
