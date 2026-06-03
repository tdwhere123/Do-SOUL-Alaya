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
  type PathAnchorRef,
  type PathRelation,
  type ProjectMappingAnchor,
  type RecallCandidate,
  type RecallPolicy,
  type SoulActiveConstraint,
  type Slot,
  type SynthesisCapsule,
  type TaskObjectSurface
} from "@do-soul/alaya-protocol";
import {
  RecallService,
  classifyGlobalCandidate,
  computeRecallTokenEconomy,
  type RecallServiceDependencies
} from "../recall-service.js";
import type {
  RecallServiceEmbeddingRecallPort,
  RecallServiceMemoryRepoPort,
  RecallServicePathExpansionPort
} from "../recall-service-types.js";
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
    // invariant: stubs mirror the cache-miss path so
    // RecallTokenEconomy.embedding_inference_calls reads as 1 when the
    // snapshot is `provider_returned`.
    // see also: packages/core/src/recall-service.ts computeRecallTokenEconomy
    cacheHit: false,
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

// Typed PathRelation fixture factory. graph_expansion now traverses the
// unified PathRelation plane (pathExpansionPort.findByAnchors) instead of
// memory_graph_edges, so graph-traversal fixtures are expressed as paths whose
// constitution.relation_kind names the equivalent edge type. A positive
// recall_bias keeps the path recall-eligible; direction_bias source_to_target
// makes the target reachable from the source anchor, matching the directed
// edge it replaces. strength 1 + the supports/derives_from/recalls relation
// kinds reproduce the static contribution_weight basis so the merged plane is
// zero-drift on the first pass.
// see also: packages/core/src/recall-service.ts graphTraversalScoreFromPath
function createPathRelation(overrides: {
  readonly path_id?: string;
  readonly sourceId?: string;
  readonly targetId?: string;
  readonly relationKind?: string;
  readonly recallBias?: number;
  readonly strength?: number;
  readonly directionBias?: "source_to_target" | "target_to_source" | "bidirectional_asymmetric";
  readonly governanceClass?: "hint_only" | "attention_only" | "recall_allowed" | "strictly_governed";
  readonly evidenceBasis?: readonly string[];
  readonly stabilityClass?: "stable" | "pinned" | "volatile" | "normal";
  readonly status?: "active" | "dormant" | "retired";
} = {}): PathRelation {
  return {
    path_id: overrides.path_id ?? "path-fixture",
    workspace_id: "workspace-1",
    anchors: {
      source_anchor: { kind: "object", object_id: overrides.sourceId ?? "memory-a" },
      target_anchor: { kind: "object", object_id: overrides.targetId ?? "memory-b" }
    },
    constitution: {
      relation_kind: overrides.relationKind ?? "supports",
      why_this_relation_exists: ["test relation"]
    },
    effect_vector: {
      salience: 1,
      recall_bias: overrides.recallBias ?? 1,
      verification_bias: 0,
      unfinishedness_bias: 0,
      default_manifestation_preference: "lens_entry"
    },
    plasticity_state: {
      strength: overrides.strength ?? 1,
      direction_bias: overrides.directionBias ?? "source_to_target",
      stability_class: overrides.stabilityClass ?? "stable",
      support_events_count: 1,
      contradiction_events_count: 0
    },
    lifecycle: {
      status: overrides.status ?? "active",
      retirement_rule: "manual"
    },
    legitimacy: {
      evidence_basis: overrides.evidenceBasis ?? ["test"],
      governance_class: overrides.governanceClass ?? "recall_allowed"
    },
    created_at: "2026-03-20T00:00:00.000Z",
    updated_at: "2026-03-20T00:00:00.000Z"
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

  // see also: packages/core/src/recall-service.ts computeRecallTokenEconomy,
  // apps/bench-runner/src/longmemeval/recall-token-economy.ts.
  // invariant: this test exercises the non-degraded recall path, so the HOT
  // tier satisfies MIN_RECALL_RESULTS (= 5), so this pins the normal HOT
  // path while the degraded-path regression below pins the cascade path.
  it("populates RecallTokenEconomy with per-call structural counters", async () => {
    const memories = [
      createMemoryEntry({ object_id: "memory-1", activation_score: 0.9 }),
      createMemoryEntry({ object_id: "memory-2", activation_score: 0.8 }),
      createMemoryEntry({ object_id: "memory-3", activation_score: 0.7 }),
      createMemoryEntry({ object_id: "memory-4", activation_score: 0.6 }),
      createMemoryEntry({ object_id: "memory-5", activation_score: 0.5 })
    ];
    const { dependencies } = createDependencies(memories);
    const service = new RecallService(dependencies);
    const result = await service.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "analyze"
    });

    const tokenEconomy = result.diagnostics?.token_economy;
    expect(tokenEconomy).toBeDefined();
    // delivered_context_tokens_estimate is the sum over delivered
    // candidates' token_estimate.
    const expectedDelivered = result.candidates.reduce(
      (sum, candidate) => sum + candidate.token_estimate,
      0
    );
    expect(tokenEconomy?.delivered_context_tokens_estimate).toBe(
      expectedDelivered
    );
    // coarse_pool_size equals candidate_pool_count (== combined coarse
    // candidates fed into fineAssess).
    expect(tokenEconomy?.coarse_pool_size).toBe(
      result.diagnostics?.candidate_pool_count ?? -1
    );
    // fine_evaluated mirrors coarse_pool_size because fineAssess scores
    // every coarse candidate before delivery truncation.
    expect(tokenEconomy?.fine_evaluated).toBe(tokenEconomy?.coarse_pool_size);
    // No embedding provider was wired into the deps factory, so the
    // pipeline reports zero fresh provider inferences for this recall.
    expect(tokenEconomy?.embedding_inference_calls).toBe(0);
    // fusion_streams_with_hits is non-negative and never exceeds the
    // total fusion stream surface.
    expect(tokenEconomy?.fusion_streams_with_hits).toBeGreaterThanOrEqual(0);
    expect(tokenEconomy?.fusion_streams_with_hits).toBeLessThanOrEqual(16);
  });

  // anti-patterns-lint-allow: see the populates-RecallTokenEconomy test —
  // both must seed >= MIN_RECALL_RESULTS HOT memories to stay on the
  // non-degraded path so token_economy is emitted (and therefore
  // comparable across calls).
  it("repeats RecallTokenEconomy stably across identical recalls on a fixed corpus", async () => {
    const memories = [
      createMemoryEntry({ object_id: "memory-1", activation_score: 0.9 }),
      createMemoryEntry({ object_id: "memory-2", activation_score: 0.8 }),
      createMemoryEntry({ object_id: "memory-3", activation_score: 0.7 }),
      createMemoryEntry({ object_id: "memory-4", activation_score: 0.6 }),
      createMemoryEntry({ object_id: "memory-5", activation_score: 0.5 })
    ];
    const { dependencies } = createDependencies(memories);
    const service = new RecallService(dependencies);
    const first = await service.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "analyze"
    });
    const second = await service.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "analyze"
    });
    // Both recalls land on the non-degraded path so token_economy is
    // present and stable across identical inputs.
    expect(first.diagnostics?.token_economy).toBeDefined();
    expect(first.diagnostics?.token_economy).toEqual(
      second.diagnostics?.token_economy
    );
  });

  // O-1 regression guard for the per-call instrument's latency contract.
  // computeRecallTokenEconomy iterates RECALL_FUSION_STREAMS (16) and for
  // each does an Array.some across the pre-budget candidate set: nested
  // 16 × N. The bench uses N up to ~200 candidates, so a worst-case
  // scan is 3200 .some calls — still pure index lookups. We pin a hard
  // < 50µs ceiling per call so future additions (extra streams, richer
  // per-stream gating) cannot quietly turn the instrument into a
  // measurable latency tax. The bound is loose enough to absorb host
  // jitter while still catching an order-of-magnitude regression.
  // see also: packages/core/src/recall-service.ts
  // @anchor compute-recall-token-economy.
  // anti-patterns-lint-allow: the candidate-diagnostic shape is local to
  // this perf probe; promoting a shared factory would couple this latency
  // contract to evolving production fixture helpers.
  it("computeRecallTokenEconomy stays sub-50µs at 200×16 worst-case cardinality", () => {
    // anti-patterns-lint-allow: the fusion-stream literal and the
    // RecallCandidateDiagnostic-shape fixture below are intentionally
    // inline. Sharing them with the global-filter test would couple this
    // perf contract to fixture evolution in an unrelated test file, and
    // promoting them to a helper module would force public exposure of a
    // diagnostic shape that production callers never construct.
    const fusionStreams = [
      "lexical_fts",
      "trigram_fts",
      "synthesis_fts",
      "evidence_fts",
      "evidence_structural_agreement",
      "source_proximity",
      "source_evidence_agreement",
      "subject_alignment",
      "structural",
      "existing_score",
      "embedding_similarity",
      "graph_expansion",
      "entity_seed",
      "path_expansion",
      "temporal_recency",
      "workspace_activation"
    ] as const;

    // 200 pre-budget diagnostic candidates, each carrying a non-null rank
    // on every stream — the worst case for the .some scan because every
    // probe finds a hit immediately rather than scanning the full array.
    // (A miss-heavy fixture would understate the cost; we exercise the
    // realistic case where streams genuinely contribute signal.)
    const preBudgetCandidates = Array.from({ length: 200 }, (_, index) => {
      const perStreamRank = Object.fromEntries(
        fusionStreams.map((stream) => [stream, index + 1])
      ) as Record<(typeof fusionStreams)[number], number | null>;
      const contributions = Object.fromEntries(
        fusionStreams.map((stream) => [stream, 0.1])
      ) as Record<(typeof fusionStreams)[number], number>;
      // The candidate diagnostic carries many fields the instrument never
      // reads (object_id, score_factors, etc.). We satisfy only the
      // properties computeRecallTokenEconomy actually consumes —
      // per_stream_rank — so the fixture stays declarative.
      return {
        candidate_key: `cand-${index}`,
        object_id: `mem-${index}`,
        object_kind: "memory_entry",
        origin_plane: "workspace_local",
        admission_planes: ["lexical"],
        plane_first_admitted: "lexical",
        plane_winning_admission: "lexical",
        pre_budget_rank: index + 1,
        selection_order: index + 1,
        fused_rank: index + 1,
        fused_score: 1,
        per_stream_rank: perStreamRank,
        fused_rank_contribution_per_stream: contributions,
        final_rank: index + 1,
        dropped_reason: null,
        within_budget: true,
        relevance_score: 0.5,
        lexical_rank: 0.5,
        structural_score: 0.5,
        score_factors: {},
        source_channels: [],
        path_expansion_sources: []
      } as unknown as Parameters<typeof computeRecallTokenEconomy>[0]["preBudgetCandidates"][number];
    });

    const deliveredCandidates = Array.from({ length: 30 }, (_, index) => ({
      token_estimate: 50 + index
    })) as unknown as Parameters<typeof computeRecallTokenEconomy>[0]["deliveredCandidates"];

    // Warm-up to amortize V8 JIT inlining so the timed sample reflects
    // steady-state cost, not first-call interpreter overhead.
    for (let i = 0; i < 50; i += 1) {
      computeRecallTokenEconomy({
        deliveredCandidates,
        coarsePoolSize: 200,
        fineEvaluated: 200,
        preBudgetCandidates,
        embeddingInferenceCalls: 1
      });
    }

    // Take the minimum across N timed samples to suppress GC / scheduler
    // noise; the regression we care about is a systematic blow-up, not
    // the worst-case outlier.
    const SAMPLE_COUNT = 25;
    let bestMicros = Number.POSITIVE_INFINITY;
    for (let i = 0; i < SAMPLE_COUNT; i += 1) {
      const startNs = process.hrtime.bigint();
      computeRecallTokenEconomy({
        deliveredCandidates,
        coarsePoolSize: 200,
        fineEvaluated: 200,
        preBudgetCandidates,
        embeddingInferenceCalls: 1
      });
      const endNs = process.hrtime.bigint();
      const micros = Number(endNs - startNs) / 1000;
      if (micros < bestMicros) bestMicros = micros;
    }

    expect(bestMicros).toBeLessThan(50);
  });

  // The degraded recall path (any non-null degradation_reason — warm/cold
  // cascade or recall_explainability_partial) must still carry the token
  // economy shape so bench coverage can prove every recall call was
  // instrumented. We exercise the cascade-engaged branch by giving the
  // harness empty HOT and WARM tiers and a single COLD candidate.
  // see also: packages/core/src/recall-service.ts (computeRecallTokenEconomy
  // call site, expandTierCascade).
  it("populates token_economy on degraded (cascade-engaged) recall paths", async () => {
    const coldOnlyMemory = createMemoryEntry({
      object_id: "11111111-1111-4111-8111-111111111111",
      storage_tier: "cold",
      activation_score: 0.4
    });
    const { dependencies } = createDependencies([coldOnlyMemory]);
    const service = new RecallService(dependencies);
    const result = await service.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "analyze"
    });
    expect(result.degradation_reason).not.toBeNull();
    expect(result.diagnostics?.token_economy).toEqual(
      expect.objectContaining({
        coarse_pool_size: result.diagnostics?.candidate_pool_count,
        fine_evaluated: result.diagnostics?.candidate_pool_count,
        embedding_inference_calls: 0
      })
    );
    // The diagnostics envelope itself must remain present so callers can
    // still read query_probes, candidates, and token accounting.
    expect(result.diagnostics).toBeDefined();
  });

  it("uses the unified path plane for direct (path_expansion) and multi-hop (graph_expansion) candidate generation", async () => {
    // graph_expansion and path_expansion now traverse the same PathRelation
    // plane. A direct hop-1 association is admitted on path_expansion; a hop-2
    // neighbor reached only by traversal is admitted on graph_expansion. The
    // double-count guard keeps a target on exactly one plane.
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
    // seed -> path-target (direct, path_expansion); seed -> graph-target
    // (direct path that the multi-hop traversal would also see, but the guard
    // keeps it on path_expansion). To prove graph_expansion still produces a
    // hop-2-only neighbor we route graph-target one hop beyond path-target.
    const seedToPathTarget = createPathRelation({
      path_id: "path-direct",
      sourceId: "seed-memory",
      targetId: "path-target",
      relationKind: "co_recalled",
      strength: 1
    });
    const pathTargetToGraphTarget = createPathRelation({
      path_id: "path-hop2",
      sourceId: "path-target",
      targetId: "graph-target",
      relationKind: "supports",
      strength: 1
    });
    const findByAnchors = vi.fn(async (_workspaceId: string, anchorRefs: readonly PathAnchorRef[]) => {
      const ids = new Set(
        anchorRefs.flatMap((ref) => (ref.kind === "object" ? [ref.object_id] : []))
      );
      const out: PathRelation[] = [];
      if (ids.has("seed-memory")) {
        out.push(seedToPathTarget);
      }
      if (ids.has("path-target")) {
        out.push(pathTargetToGraphTarget);
      }
      return out;
    });
    const pathExpansionPort: RecallServicePathExpansionPort = { findByAnchors };
    const service = new RecallService({
      ...dependencies,
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
    // path-target is a direct hop-1 association off the seed -> path_expansion.
    expect(result.diagnostics?.candidates.find((candidate) => candidate.object_id === "path-target")?.admission_planes)
      .toContain("path_expansion");
    // graph-target is reachable only via a second hop -> graph_expansion, and
    // the double-count guard keeps it off path_expansion.
    const graphTargetDiag = result.diagnostics?.candidates.find(
      (candidate) => candidate.object_id === "graph-target"
    );
    expect(graphTargetDiag?.admission_planes).toContain("graph_expansion");
    expect(graphTargetDiag?.admission_planes).not.toContain("path_expansion");
    expect(graphTargetDiag?.fused_rank_contribution_per_stream.graph_expansion).toBeGreaterThan(0.04);
  });

  it("excludes negative-bias paths from path_expansion positive candidates", async () => {
    // invariant: a negative path (recall_bias < 0) records suppression, so
    // its target is excluded from positive path_expansion candidates —
    // admitting it would amplify the suppressed memory.
    // see also: recall-service.ts isPathExcludedFromRecall.
    const memories = [
      createMemoryEntry({
        object_id: "seed-memory",
        content: "Deployment recall seed.",
        activation_score: 0.9
      }),
      createMemoryEntry({
        object_id: "path-target",
        content: "Path neighbor that the seed contradicts.",
        activation_score: 0.1,
        domain_tags: ["path"]
      })
    ];
    const { dependencies } = createDependencies(memories);
    // anti-patterns-lint-allow: structurally-exact PathRelation fixture +
    // policy override mirror the sibling path_expansion test on purpose so
    // tsc validates the discriminated-union literals per case.
    const negativePathRelation: PathRelation = {
      path_id: "path-neg-1",
      workspace_id: "workspace-1",
      anchors: {
        source_anchor: { kind: "object", object_id: "seed-memory" },
        target_anchor: { kind: "object", object_id: "path-target" }
      },
      constitution: {
        relation_kind: "contradicts",
        why_this_relation_exists: ["test negative relation"]
      },
      effect_vector: {
        salience: 1,
        // negative recall_bias = recallBiasSign(-1) * magnitude(0.4)
        recall_bias: -0.4,
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
    };
    const pathExpansionPort: RecallServicePathExpansionPort = {
      findByAnchors: vi.fn(async () => [negativePathRelation])
    };
    const service = new RecallService({
      ...dependencies,
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

    // path-target must NOT be admitted through path_expansion off the
    // negative path. If it appears at all (e.g. via another plane), its
    // admission_planes must not include path_expansion.
    const pathTarget = result.diagnostics?.candidates.find(
      (candidate) => candidate.object_id === "path-target"
    );
    expect(pathTarget?.admission_planes ?? []).not.toContain("path_expansion");
  });

  it("excludes recall-neutral exception_to paths (recall_bias == 0) from path_expansion positive candidates", async () => {
    // invariant: the exception_to marker carries recall_bias exactly 0. It
    // is a topology marker, not a positive association — the strict-positive
    // isPathRecallEligible gate must keep it out of positive path_expansion
    // just like the negative families. Pre-fix the `< 0` test admitted it.
    // see also: recall-service.ts isPathExcludedFromRecall.
    const memories = [
      createMemoryEntry({
        object_id: "seed-memory",
        content: "Deployment recall seed.",
        activation_score: 0.9
      }),
      createMemoryEntry({
        object_id: "path-target",
        content: "Path neighbor reached via an exception_to marker.",
        activation_score: 0.1,
        domain_tags: ["path"]
      })
    ];
    const { dependencies } = createDependencies(memories);
    // anti-patterns-lint-allow: structurally-exact PathRelation fixture +
    // policy override mirror the sibling path_expansion tests on purpose so
    // tsc validates the discriminated-union literals per case.
    const neutralPathRelation: PathRelation = {
      path_id: "path-neutral-1",
      workspace_id: "workspace-1",
      anchors: {
        source_anchor: { kind: "object", object_id: "seed-memory" },
        target_anchor: { kind: "object", object_id: "path-target" }
      },
      constitution: {
        relation_kind: "exception_to",
        why_this_relation_exists: ["test neutral relation"]
      },
      effect_vector: {
        salience: 1,
        // recall-neutral marker: recallBiasSign(0) * magnitude(0) = 0
        recall_bias: 0,
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
    };
    const pathExpansionPort: RecallServicePathExpansionPort = {
      findByAnchors: vi.fn(async () => [neutralPathRelation])
    };
    const service = new RecallService({
      ...dependencies,
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

    const pathTarget = result.diagnostics?.candidates.find(
      (candidate) => candidate.object_id === "path-target"
    );
    expect(pathTarget?.admission_planes ?? []).not.toContain("path_expansion");
  });

  it("actively suppresses a target via a reinforced (high-strength) negative path", async () => {
    // A plasticity-reinforced contradiction (recall_bias < 0, strength near 1)
    // demotes its target's fused score below an otherwise-equivalent peer that
    // carries no negative path. Both targets are lexical hits, so the only
    // ranking difference is the active suppression delta.
    const memories = [
      createMemoryEntry({
        object_id: "seed-memory",
        content: "deployment rollback procedure overview",
        activation_score: 0.9
      }),
      createMemoryEntry({
        object_id: "suppressed-target",
        content: "deployment rollback procedure detail one",
        activation_score: 0.5
      }),
      createMemoryEntry({
        object_id: "control-target",
        content: "deployment rollback procedure detail two",
        activation_score: 0.5
      })
    ];
    const { dependencies } = createDependencies(memories);
    const negativePath = createPathRelation({
      path_id: "path-neg-strong",
      sourceId: "seed-memory",
      targetId: "suppressed-target",
      relationKind: "contradicts",
      recallBias: -0.5,
      strength: 0.95
    });
    const findByAnchors = vi.fn(async (_workspaceId: string, anchorRefs: readonly PathAnchorRef[]) => {
      const ids = new Set(
        anchorRefs.flatMap((ref) => (ref.kind === "object" ? [ref.object_id] : []))
      );
      return ids.has("seed-memory") ? [negativePath] : [];
    });
    const service = new RecallService({
      ...dependencies,
      pathExpansionPort: { findByAnchors }
    });
    const basePolicy = service.buildDefaultPolicy("analyze", createTaskSurface().runtime_id);
    const policy = overridePolicy(basePolicy, {
      coarse_filter: {
        ...basePolicy.coarse_filter,
        semantic_supplement: { enabled: false, max_supplement: 0 }
      },
      fine_assessment: {
        ...basePolicy.fine_assessment,
        budgets: { max_total_tokens: 4000, max_entries: 5, per_dimension_limits: null }
      }
    });

    const result = await service.recall({
      taskSurface: { ...createTaskSurface(), display_name: "deployment rollback procedure detail" },
      workspaceId: "workspace-1",
      strategy: "analyze",
      policyOverride: policy
    });

    const suppressed = result.diagnostics?.candidates.find((c) => c.object_id === "suppressed-target");
    const control = result.diagnostics?.candidates.find((c) => c.object_id === "control-target");
    // The suppressed target must still be present (suppression demotes, it does
    // not remove), but it must rank strictly below the equivalent control.
    expect(suppressed).toBeDefined();
    expect(control).toBeDefined();
    expect(suppressed?.fused_score ?? 1).toBeLessThan(control?.fused_score ?? 0);
    expect(suppressed?.fused_rank ?? 0).toBeGreaterThan(control?.fused_rank ?? Number.MAX_SAFE_INTEGER);
  });

  it("does not let an attention_only negative path suppress even at high strength", async () => {
    // invariant: the governance gate (isPathGovernedForSuppression) blocks the
    // weaponizable suppression lane. strength is agent-pumpable through replayed
    // co-usage, so an attention_only negative seeded by agent-controllable
    // content must NOT demote a victim no matter how high strength climbs — only
    // recall_allowed / strictly_governed negatives reach the delta. Isolate by
    // recalling the same corpus twice (path wired vs not) and asserting the
    // target's fused score is identical.
    // see also: path-relation.ts isPathGovernedForSuppression.
    const memories = [
      createMemoryEntry({
        object_id: "seed-memory",
        content: "deployment rollback procedure overview",
        activation_score: 0.9
      }),
      createMemoryEntry({
        object_id: "victim-target",
        content: "deployment rollback procedure detail one",
        activation_score: 0.5
      })
    ];
    const weaponizedNegativePath = createPathRelation({
      path_id: "path-neg-attention-pumped",
      sourceId: "seed-memory",
      targetId: "victim-target",
      relationKind: "contradicts",
      recallBias: -0.5,
      // Far above PATH_SUPPRESSION_STRENGTH_FLOOR: strength alone would license a
      // full delta if governance were not the gate.
      strength: 0.95,
      stabilityClass: "stable",
      // Agent-reachable band: must never actively suppress.
      governanceClass: "attention_only"
    });

    const runRecall = async (wirePath: boolean): Promise<number> => {
      const { dependencies } = createDependencies(memories);
      const findByAnchors = vi.fn(async (_workspaceId: string, anchorRefs: readonly PathAnchorRef[]) => {
        const ids = new Set(
          anchorRefs.flatMap((ref) => (ref.kind === "object" ? [ref.object_id] : []))
        );
        return wirePath && ids.has("seed-memory") ? [weaponizedNegativePath] : [];
      });
      const service = new RecallService({
        ...dependencies,
        pathExpansionPort: { findByAnchors }
      });
      const basePolicy = service.buildDefaultPolicy("analyze", createTaskSurface().runtime_id);
      const policy = overridePolicy(basePolicy, {
        coarse_filter: {
          ...basePolicy.coarse_filter,
          semantic_supplement: { enabled: false, max_supplement: 0 }
        },
        fine_assessment: {
          ...basePolicy.fine_assessment,
          budgets: { max_total_tokens: 4000, max_entries: 5, per_dimension_limits: null }
        }
      });
      const result = await service.recall({
        taskSurface: { ...createTaskSurface(), display_name: "deployment rollback procedure detail" },
        workspaceId: "workspace-1",
        strategy: "analyze",
        policyOverride: policy
      });
      const target = result.diagnostics?.candidates.find((c) => c.object_id === "victim-target");
      expect(target).toBeDefined();
      return target?.fused_score ?? -1;
    };

    const withAttentionNegative = await runRecall(true);
    const withoutPath = await runRecall(false);
    // Governance gate rejects the attention_only negative: identical fused score.
    expect(withAttentionNegative).toBeCloseTo(withoutPath, 10);
  });

  it("caps stacked recall_allowed negatives so ganging cannot deepen the demotion", async () => {
    // invariant: PATH_SUPPRESSION_MAX_PER_TARGET. Multiple converging governed
    // negatives compound only up to one reinforced-supersession delta (0.27), so
    // ganging extra negatives onto the same victim cannot push its fused score
    // any lower than a single negative already does. Isolate the cap by running
    // the same corpus with three converging negatives vs one negative: the
    // victim's fused score must be identical (the cap clamps the stack), and the
    // victim must remain delivered (suppression demotes, never removes from the
    // ranked set).
    const buildMemories = () => [
      createMemoryEntry({
        object_id: "seed-one",
        content: "deployment rollback procedure overview alpha",
        activation_score: 0.9
      }),
      createMemoryEntry({
        object_id: "seed-two",
        content: "deployment rollback procedure overview beta",
        activation_score: 0.9
      }),
      createMemoryEntry({
        object_id: "seed-three",
        content: "deployment rollback procedure overview gamma",
        activation_score: 0.9
      }),
      createMemoryEntry({
        object_id: "victim-target",
        content: "deployment rollback procedure detail one",
        activation_score: 0.5
      })
    ];
    const allNegatives = ["seed-one", "seed-two", "seed-three"].map((seedId, index) =>
      createPathRelation({
        path_id: `path-neg-gang-${index}`,
        sourceId: seedId,
        targetId: "victim-target",
        relationKind: "supersedes",
        recallBias: -0.5,
        strength: 0.95,
        governanceClass: "recall_allowed"
      })
    );

    const runRecall = async (negatives: readonly PathRelation[]): Promise<{
      readonly delivered: boolean;
      readonly fusedScore: number;
    }> => {
      const { dependencies } = createDependencies(buildMemories());
      const findByAnchors = vi.fn(async (_workspaceId: string, anchorRefs: readonly PathAnchorRef[]) => {
        const ids = new Set(
          anchorRefs.flatMap((ref) => (ref.kind === "object" ? [ref.object_id] : []))
        );
        return negatives.filter((path) => {
          const source = path.anchors.source_anchor;
          return source.kind === "object" && ids.has(source.object_id);
        });
      });
      const service = new RecallService({
        ...dependencies,
        pathExpansionPort: { findByAnchors }
      });
      const basePolicy = service.buildDefaultPolicy("analyze", createTaskSurface().runtime_id);
      const policy = overridePolicy(basePolicy, {
        coarse_filter: {
          ...basePolicy.coarse_filter,
          semantic_supplement: { enabled: false, max_supplement: 0 }
        },
        fine_assessment: {
          ...basePolicy.fine_assessment,
          budgets: { max_total_tokens: 4000, max_entries: 5, per_dimension_limits: null }
        }
      });
      const result = await service.recall({
        taskSurface: { ...createTaskSurface(), display_name: "deployment rollback procedure detail" },
        workspaceId: "workspace-1",
        strategy: "analyze",
        policyOverride: policy
      });
      const victim = result.diagnostics?.candidates.find((c) => c.object_id === "victim-target");
      expect(victim).toBeDefined();
      return {
        delivered: result.candidates.some((candidate) => candidate.object_id === "victim-target"),
        fusedScore: victim?.fused_score ?? -1
      };
    };

    const single = await runRecall([allNegatives[0]!]);
    const ganged = await runRecall(allNegatives);
    // The cap clamps the stack to one delta: three converging negatives demote
    // the victim no more than one does.
    expect(ganged.fusedScore).toBeCloseTo(single.fusedScore, 10);
    // Suppression demotes, never removes: the victim is still delivered.
    expect(single.delivered).toBe(true);
    expect(ganged.delivered).toBe(true);
  });

  it("demotes a low-base victim to a floor residual without erasing it from the candidate set", async () => {
    // invariant: PATH_SUPPRESSION_RESIDUAL_FLOOR. A single full-strength
    // recall_allowed negative produces a delta (~0.27) that exceeds a low-base
    // victim's fused_score. Without the residual floor the subtraction would
    // drive the victim to 0 and drop it out of the candidate set (erasure).
    // The floor keeps a positive pre-suppression candidate present as a tail
    // candidate: still ranked, fused_score > 0, but strictly demoted below its
    // no-path baseline. see also: recall-service.ts applyPathSuppressionToFusionScores.
    const memories = [
      createMemoryEntry({
        object_id: "seed-memory",
        content: "deployment rollback procedure overview alpha beta gamma",
        activation_score: 0.9
      }),
      createMemoryEntry({
        object_id: "low-base-victim",
        // Minimal lexical overlap with the query so its fused_score lands below
        // the single-negative cap delta.
        content: "rollback note",
        activation_score: 0.1
      })
    ];
    const negativePath = createPathRelation({
      path_id: "path-neg-low-base",
      sourceId: "seed-memory",
      targetId: "low-base-victim",
      relationKind: "supersedes",
      recallBias: -0.5,
      strength: 0.95,
      governanceClass: "recall_allowed"
    });

    const runRecall = async (wirePath: boolean): Promise<{
      readonly fusedScore: number;
      readonly present: boolean;
    }> => {
      const { dependencies } = createDependencies(memories);
      const findByAnchors = vi.fn(async (_workspaceId: string, anchorRefs: readonly PathAnchorRef[]) => {
        const ids = new Set(
          anchorRefs.flatMap((ref) => (ref.kind === "object" ? [ref.object_id] : []))
        );
        return wirePath && ids.has("seed-memory") ? [negativePath] : [];
      });
      const service = new RecallService({
        ...dependencies,
        pathExpansionPort: { findByAnchors }
      });
      const basePolicy = service.buildDefaultPolicy("analyze", createTaskSurface().runtime_id);
      const policy = overridePolicy(basePolicy, {
        coarse_filter: {
          ...basePolicy.coarse_filter,
          semantic_supplement: { enabled: false, max_supplement: 0 }
        },
        fine_assessment: {
          ...basePolicy.fine_assessment,
          budgets: { max_total_tokens: 4000, max_entries: 5, per_dimension_limits: null }
        }
      });
      const result = await service.recall({
        taskSurface: { ...createTaskSurface(), display_name: "deployment rollback procedure overview" },
        workspaceId: "workspace-1",
        strategy: "analyze",
        policyOverride: policy
      });
      const victim = result.diagnostics?.candidates.find((c) => c.object_id === "low-base-victim");
      return {
        fusedScore: victim?.fused_score ?? -1,
        present: victim !== undefined
      };
    };

    const baseline = await runRecall(false);
    const suppressed = await runRecall(true);
    // Baseline below the cap delta: the subtraction alone would reach 0.
    expect(baseline.fusedScore).toBeGreaterThan(0);
    expect(baseline.fusedScore).toBeLessThan(0.27);
    // Suppressed: still a candidate, demoted below baseline, but floored above 0.
    expect(suppressed.present).toBe(true);
    expect(suppressed.fusedScore).toBeGreaterThan(0);
    expect(suppressed.fusedScore).toBeLessThan(baseline.fusedScore);
  });

  it("does not let a weak attention_only negative path move rankings", async () => {
    // A barely-formed negative association (strength below the suppression
    // floor) contributes zero delta. Isolate the effect by recalling the same
    // corpus twice — once with the weak negative path wired and once without —
    // and asserting the target's fused score is identical. invariant:
    // PATH_SUPPRESSION_STRENGTH_FLOOR. Comparing two runs of the same memory
    // (rather than two sibling memories) removes object-id-ordering noise.
    const memories = [
      createMemoryEntry({
        object_id: "seed-memory",
        content: "deployment rollback procedure overview",
        activation_score: 0.9
      }),
      createMemoryEntry({
        object_id: "weak-target",
        content: "deployment rollback procedure detail one",
        activation_score: 0.5
      })
    ];
    const weakNegativePath = createPathRelation({
      path_id: "path-neg-weak",
      sourceId: "seed-memory",
      targetId: "weak-target",
      relationKind: "contradicts",
      recallBias: -0.4,
      // attention_only co-occurrence band: below PATH_SUPPRESSION_STRENGTH_FLOOR.
      strength: 0.5,
      stabilityClass: "volatile",
      governanceClass: "attention_only"
    });
    const basePolicyPatch = {
      coarse_filter_semantic: { enabled: false, max_supplement: 0 }
    } as const;

    const runRecall = async (wirePath: boolean): Promise<number> => {
      const { dependencies } = createDependencies(memories);
      const findByAnchors = vi.fn(async (_workspaceId: string, anchorRefs: readonly PathAnchorRef[]) => {
        const ids = new Set(
          anchorRefs.flatMap((ref) => (ref.kind === "object" ? [ref.object_id] : []))
        );
        return wirePath && ids.has("seed-memory") ? [weakNegativePath] : [];
      });
      const service = new RecallService({
        ...dependencies,
        pathExpansionPort: { findByAnchors }
      });
      const basePolicy = service.buildDefaultPolicy("analyze", createTaskSurface().runtime_id);
      const policy = overridePolicy(basePolicy, {
        coarse_filter: {
          ...basePolicy.coarse_filter,
          semantic_supplement: basePolicyPatch.coarse_filter_semantic
        },
        fine_assessment: {
          ...basePolicy.fine_assessment,
          budgets: { max_total_tokens: 4000, max_entries: 5, per_dimension_limits: null }
        }
      });
      const result = await service.recall({
        taskSurface: { ...createTaskSurface(), display_name: "deployment rollback procedure detail" },
        workspaceId: "workspace-1",
        strategy: "analyze",
        policyOverride: policy
      });
      const target = result.diagnostics?.candidates.find((c) => c.object_id === "weak-target");
      expect(target).toBeDefined();
      return target?.fused_score ?? -1;
    };

    const withWeakPath = await runRecall(true);
    const withoutPath = await runRecall(false);
    // The weak negative path is below the strength floor, so it applies no
    // suppression: the target's fused score is unchanged versus the no-path run.
    expect(withWeakPath).toBeCloseTo(withoutPath, 10);
  });

  describe("governance manifestation HARD CEILING — truth boundary", () => {
    // invariant: the manifestation ceiling derives from a memory's INBOUND
    // recall-eligible PathRelations' governance band, but it must NOT trust an
    // agent-pumpable recall_allowed (one reached via the support_events_count
    // auto-promotion ladder) and must NOT vanish on a transient path-store read
    // error. see also: recall-service.ts collectGovernanceCeilings,
    //   path-manifestation-policy.ts memoryGovernanceCeiling.
    const VICTIM_LONG_CONTENT =
      "deployment rollback procedure detail one with enough body text to exceed the " +
      "one-hundred-and-sixty character preview clip so a capped band visibly truncates " +
      "the delivered preview while a full_eligible band serves the entire content body.";

    const runCeilingRecall = async (params: {
      readonly findByAnchors: RecallServicePathExpansionPort["findByAnchors"];
    }): Promise<Readonly<RecallCandidate> | undefined> => {
      const memories = [
        createMemoryEntry({
          object_id: "seed-memory",
          content: "deployment rollback procedure overview",
          activation_score: 0.9
        }),
        createMemoryEntry({
          object_id: "victim-target",
          content: VICTIM_LONG_CONTENT,
          // 0.95 lands in the full_eligible strength tier, so the delivered
          // manifestation equals the governance ceiling (clamp is a pure min).
          activation_score: 0.95
        })
      ];
      const { dependencies } = createDependencies(memories);
      const service = new RecallService({
        ...dependencies,
        pathExpansionPort: { findByAnchors: params.findByAnchors }
      });
      const basePolicy = service.buildDefaultPolicy("analyze", createTaskSurface().runtime_id);
      const policy = overridePolicy(basePolicy, {
        coarse_filter: {
          ...basePolicy.coarse_filter,
          semantic_supplement: { enabled: false, max_supplement: 0 }
        },
        fine_assessment: {
          ...basePolicy.fine_assessment,
          budgets: { max_total_tokens: 4000, max_entries: 5, per_dimension_limits: null }
        }
      });
      const result = await service.recall({
        taskSurface: { ...createTaskSurface(), display_name: "deployment rollback procedure detail one" },
        workspaceId: "workspace-1",
        strategy: "analyze",
        policyOverride: policy
      });
      return result.candidates.find((candidate) => candidate.object_id === "victim-target");
    };

    // Returns an inbound recall-eligible path target=victim-target only when the
    // victim id is among the ceiling-lookup anchors (the ceiling read passes
    // every admitted candidate id and keeps paths whose target is a candidate).
    const inboundPathFinder = (
      path: PathRelation
    ): RecallServicePathExpansionPort["findByAnchors"] =>
      vi.fn(async (_workspaceId: string, anchorRefs: readonly PathAnchorRef[]) => {
        const ids = new Set(
          anchorRefs.flatMap((ref) => (ref.kind === "object" ? [ref.object_id] : []))
        );
        return ids.has("victim-target") ? [path] : [];
      });

    it("Finding #2: an auto-promoted recall_allowed (pumped support, birth marker only) caps the victim at excerpt", async () => {
      // The inbound positive path climbed attention_only -> recall_allowed by
      // pumping support_events_count via agent report_context_usage receipts;
      // evidence_basis still carries only its co-usage birth marker. The ceiling
      // must treat it as attention_only (excerpt), NOT full_eligible, so preview
      // content is not over-surfaced.
      const pumpedPath = createPathRelation({
        path_id: "path-pos-pumped-recall-allowed",
        sourceId: "seed-memory",
        targetId: "victim-target",
        relationKind: "co_recalled",
        recallBias: 0.5,
        strength: 0.95,
        stabilityClass: "stable",
        governanceClass: "recall_allowed",
        evidenceBasis: ["recalls_edge_co_usage"]
      });
      const victim = await runCeilingRecall({ findByAnchors: inboundPathFinder(pumpedPath) });
      expect(victim).toBeDefined();
      expect(victim?.manifestation).toBe("excerpt");
      // Over-surfacing is actually prevented: the delivered preview is clipped,
      // not the full long body.
      expect(victim?.content_preview).not.toBe(VICTIM_LONG_CONTENT);
      expect(victim?.content_preview.length ?? 0).toBeLessThan(VICTIM_LONG_CONTENT.length);
    });

    it("Finding #2: a trusted-seed recall_allowed (signal_graph_reference) lifts the victim to full_eligible", async () => {
      // A recall_allowed BORN at that band by the system signal-graph seed is
      // trusted provenance; the legitimate path still serves full content.
      const trustedPath = createPathRelation({
        path_id: "path-pos-trusted-signal-graph",
        sourceId: "seed-memory",
        targetId: "victim-target",
        relationKind: "signal_graph_ref",
        recallBias: 0.5,
        strength: 0.95,
        stabilityClass: "stable",
        governanceClass: "recall_allowed",
        evidenceBasis: ["signal_graph_reference"]
      });
      const victim = await runCeilingRecall({ findByAnchors: inboundPathFinder(trustedPath) });
      expect(victim).toBeDefined();
      expect(victim?.manifestation).toBe("full_eligible");
      expect(victim?.content_preview).toBe(VICTIM_LONG_CONTENT);
    });

    it("Finding #2: a human/auto edge-accept recall_allowed (edge_proposal_accept:<id>) lifts the victim to full_eligible", async () => {
      const acceptPath = createPathRelation({
        path_id: "path-pos-edge-accept",
        sourceId: "seed-memory",
        targetId: "victim-target",
        relationKind: "supports",
        recallBias: 0.5,
        strength: 0.95,
        stabilityClass: "stable",
        governanceClass: "recall_allowed",
        evidenceBasis: ["edge_proposal_accept:edge_prop_xyz789"]
      });
      const victim = await runCeilingRecall({ findByAnchors: inboundPathFinder(acceptPath) });
      expect(victim).toBeDefined();
      expect(victim?.manifestation).toBe("full_eligible");
    });

    it("Finding #2: strictly_governed (user-set, not auto-reachable) lifts the victim to full_eligible regardless of evidence", async () => {
      const strictPath = createPathRelation({
        path_id: "path-pos-strict",
        sourceId: "seed-memory",
        targetId: "victim-target",
        relationKind: "supports",
        recallBias: 0.5,
        strength: 0.95,
        stabilityClass: "stable",
        governanceClass: "strictly_governed",
        evidenceBasis: ["recalls_edge_co_usage"]
      });
      const victim = await runCeilingRecall({ findByAnchors: inboundPathFinder(strictPath) });
      expect(victim).toBeDefined();
      expect(victim?.manifestation).toBe("full_eligible");
    });

    it("Finding #3: a thrown findByAnchors fails CLOSED — every candidate is capped to the LOWEST visibility band (hint), never over-surfaced", async () => {
      // A transient path-store read error must NOT lift a governed memory to its
      // full strength tier. The ceiling map is NOT empty-meaning-unrestricted on
      // throw: every candidate is capped to GOVERNANCE_CEILING_FAILSAFE_BAND
      // (hint). hint is the only band that is never an over-surface for ANY
      // governance class — a memory whose TRUE ceiling is hint (hint_only) is NOT
      // over-surfaced to excerpt on a read blip. At the lens hint renders a bare
      // `[memory ref: <id>]` (zero body); see the context-lens-assembler proof
      // test below. see also: recall-service.ts collectGovernanceCeilings (throw),
      //   path-manifestation-policy.ts GOVERNANCE_CEILING_FAILSAFE_BAND.
      const throwingFinder = vi.fn(async () => {
        throw new Error("transient path-store read failure");
      });
      const victim = await runCeilingRecall({ findByAnchors: throwingFinder });
      expect(victim).toBeDefined();
      // full_eligible strength tier capped to the fail-closed safe band (hint).
      expect(victim?.manifestation).toBe("hint");
      expect(victim?.content_preview).not.toBe(VICTIM_LONG_CONTENT);
      expect(victim?.content_preview.length ?? 0).toBeLessThan(VICTIM_LONG_CONTENT.length);
    });

    it("Finding #3: a hint_only true-ceiling memory is never surfaced above hint on the failure path", async () => {
      // The failsafe IS hint, so a memory whose TRUE governance ceiling is hint
      // (hint_only) cannot be over-surfaced by the throw branch: the capped band
      // equals its true ceiling exactly. This holds by construction — assert it so
      // raising GOVERNANCE_CEILING_FAILSAFE_BAND above hint (the latent over-surface)
      // re-fails here. see also: path-manifestation-policy.ts GOVERNANCE_MANIFESTATION_CEILING
      //   (hint_only -> hint), GOVERNANCE_CEILING_FAILSAFE_BAND.
      const hintOnlyPath = createPathRelation({
        path_id: "path-pos-hint-only",
        sourceId: "seed-memory",
        targetId: "victim-target",
        relationKind: "co_recalled",
        recallBias: 0.5,
        strength: 0.95,
        stabilityClass: "stable",
        governanceClass: "hint_only",
        evidenceBasis: ["recalls_edge_co_usage"]
      });
      // Throw on the governance read: the victim's true ceiling (hint_only -> hint)
      // and the failsafe band (hint) coincide, so it is at most hint either way.
      const throwingFinder = vi.fn(async () => {
        throw new Error("transient path-store read failure");
      });
      const onThrow = await runCeilingRecall({ findByAnchors: throwingFinder });
      expect(onThrow).toBeDefined();
      expect(onThrow?.manifestation).toBe("hint");
      // And when the read succeeds with the hint_only path, the ceiling is hint too:
      // the failsafe never surfaces a hint_only memory above its real ceiling.
      const onRead = await runCeilingRecall({ findByAnchors: inboundPathFinder(hintOnlyPath) });
      expect(onRead).toBeDefined();
      expect(onRead?.manifestation).toBe("hint");
    });

    it("Finding #3: an ABSENT pathExpansionPort stays OPEN — the victim reaches its full strength tier", async () => {
      // No governance plane deployed: the empty ceiling map legitimately means
      // unrestricted (full_eligible), distinct from the thrown-lookup case.
      const memories = [
        createMemoryEntry({
          object_id: "victim-target",
          content: VICTIM_LONG_CONTENT,
          activation_score: 0.95
        })
      ];
      const { dependencies } = createDependencies(memories);
      const service = new RecallService({ ...dependencies });
      const basePolicy = service.buildDefaultPolicy("analyze", createTaskSurface().runtime_id);
      const policy = overridePolicy(basePolicy, {
        coarse_filter: {
          ...basePolicy.coarse_filter,
          semantic_supplement: { enabled: false, max_supplement: 0 }
        },
        fine_assessment: {
          ...basePolicy.fine_assessment,
          budgets: { max_total_tokens: 4000, max_entries: 5, per_dimension_limits: null }
        }
      });
      const result = await service.recall({
        taskSurface: { ...createTaskSurface(), display_name: "deployment rollback procedure detail one" },
        workspaceId: "workspace-1",
        strategy: "analyze",
        policyOverride: policy
      });
      const victim = result.candidates.find((candidate) => candidate.object_id === "victim-target");
      expect(victim).toBeDefined();
      expect(victim?.manifestation).toBe("full_eligible");
      expect(victim?.content_preview).toBe(VICTIM_LONG_CONTENT);
    });
  });

  it("expands path-graph candidates across two hops with cycle-safe edge-type decay diagnostics", async () => {
    // The hop-2 traversal score MAGNITUDES (0.25 / 0.045) equal the static
    // EDGE_TYPE_RECALL_MODEL.contribution_weight basis because
    // graphTraversalScoreFromPath returns that basis and the hop_decay constants
    // are unchanged; traversal TOPOLOGY follows path direction_bias, not the
    // undirected edge plane (paths here are bidirectional_asymmetric so reach is
    // full). The merge moves the hop-1 direct association (seed -> hop1-derived)
    // onto the path_expansion plane, so it no longer counts in graph_expansion's
    // per_hop[0] / per_edge_type — the graph plane carries only the multi-hop
    // reach now.
    // see also: recall-service.ts graphTraversalScoreFromPath.
    const memories = [
      createMemoryEntry({
        object_id: "seed-memory",
        content: "Deployment recall seed.",
        activation_score: 0.9
      }),
      createMemoryEntry({
        object_id: "hop1-derived",
        content: "First hop derived graph neighbor.",
        activation_score: 0.1,
        domain_tags: ["graph-hop"]
      }),
      createMemoryEntry({
        object_id: "hop2-supported",
        content: "Second hop supported graph answer.",
        activation_score: 0.1,
        domain_tags: ["graph-hop"]
      }),
      createMemoryEntry({
        object_id: "hop2-recalled",
        content: "Second hop recalled graph answer.",
        activation_score: 0.1,
        domain_tags: ["graph-hop"]
      }),
      createMemoryEntry({
        object_id: "superseded-target",
        content: "Superseded graph target should not propagate.",
        activation_score: 0.1,
        domain_tags: ["graph-hop"]
      })
    ];
    const { dependencies } = createDependencies(memories);
    const seedToHop1 = createPathRelation({
      path_id: "path-derives",
      sourceId: "seed-memory",
      targetId: "hop1-derived",
      relationKind: "derives_from",
      strength: 1
    });
    // Negative-bias path off the seed: recall_bias < 0 makes it ineligible, so
    // the traversal must never follow it (mirrors the floored supersedes edge).
    const seedToSuperseded = createPathRelation({
      path_id: "path-supersedes",
      sourceId: "seed-memory",
      targetId: "superseded-target",
      relationKind: "supersedes",
      recallBias: -0.5,
      strength: 0.9
    });
    const hop1ToCycle = createPathRelation({
      path_id: "path-cycle",
      sourceId: "hop1-derived",
      targetId: "seed-memory",
      relationKind: "supports",
      strength: 1
    });
    const hop1ToSupported = createPathRelation({
      path_id: "path-supports",
      sourceId: "hop1-derived",
      targetId: "hop2-supported",
      relationKind: "supports",
      strength: 1
    });
    const hop1ToRecalled = createPathRelation({
      path_id: "path-recalls",
      sourceId: "hop1-derived",
      targetId: "hop2-recalled",
      relationKind: "recalls",
      strength: 1
    });
    const findByAnchors = vi.fn(async (_workspaceId: string, anchorRefs: readonly PathAnchorRef[]) => {
      const ids = new Set(
        anchorRefs.flatMap((ref) => (ref.kind === "object" ? [ref.object_id] : []))
      );
      const out: PathRelation[] = [];
      if (ids.has("seed-memory")) {
        out.push(seedToHop1, seedToSuperseded);
      }
      if (ids.has("hop1-derived")) {
        out.push(hop1ToCycle, hop1ToSupported, hop1ToRecalled);
      }
      return out;
    });
    const service = new RecallService({
      ...dependencies,
      pathExpansionPort: { findByAnchors }
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

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual(
      expect.arrayContaining(["seed-memory", "hop1-derived", "hop2-supported", "hop2-recalled"])
    );
    // hop1-derived is a direct association -> path_expansion plane.
    expect(
      result.diagnostics?.candidates.find((candidate) => candidate.object_id === "hop1-derived")?.admission_planes
    ).toContain("path_expansion");
    // Negative-bias path is never followed, so its target stays out of both
    // associative planes.
    expect(
      result.diagnostics?.candidates.find((candidate) => candidate.object_id === "superseded-target")
        ?.admission_planes ?? []
    ).not.toContain("graph_expansion");
    // graph_expansion carries only the two hop-2 neighbors now.
    expect(result.diagnostics?.graph_expansion_plane_count_per_hop).toEqual([0, 2]);
    expect(result.diagnostics?.graph_expansion_plane_count_per_edge_type).toEqual({
      derives_from: 0,
      recalls: 1,
      supports: 1
    });
    // score magnitude equals the static contribution_weight basis (0.25).
    expect(
      result.diagnostics?.candidates.find((candidate) => candidate.object_id === "hop2-supported")?.structural_score
    ).toBeCloseTo(0.25);
    expect(
      result.diagnostics?.candidates.find((candidate) => candidate.object_id === "hop2-recalled")?.structural_score
    ).toBeCloseTo(0.045);
    // The negative path's target is never used as a BFS anchor.
    const anchoredIds = findByAnchors.mock.calls.flatMap((call) =>
      call[1].flatMap((ref) => (ref.kind === "object" ? [ref.object_id] : []))
    );
    expect(anchoredIds).not.toContain("superseded-target");
  });

  it("does not count graph diagnostics for neighbors rejected by deterministic filters", async () => {
    // invariant: a path-backed neighbor whose dimension fails the deterministic
    // filter is never admitted to byId, so expandGraphFrontier (which only
    // traverses into admitted candidates) cannot fan it onto graph_expansion.
    // Wiring the unified pathExpansionPort exercises the real path-backed plane;
    // the retired graphExpansionPort no longer participates.
    const memories = [
      createMemoryEntry({
        object_id: "seed-memory",
        dimension: MemoryDimension.PROCEDURE,
        scope_class: ScopeClass.PROJECT,
        domain_tags: ["repo"],
        content: "Deployment recall seed.",
        activation_score: 0.9
      }),
      createMemoryEntry({
        object_id: "filtered-neighbor",
        dimension: MemoryDimension.PREFERENCE,
        scope_class: ScopeClass.PROJECT,
        domain_tags: ["repo"],
        content: "A graph neighbor that fails the deterministic dimension filter.",
        activation_score: 0.1
      })
    ];
    const { dependencies } = createDependencies(memories);
    const seedToFilteredNeighbor = createPathRelation({
      path_id: "path-filtered-neighbor",
      sourceId: "seed-memory",
      targetId: "filtered-neighbor",
      relationKind: "derives_from",
      directionBias: "bidirectional_asymmetric",
      strength: 1
    });
    const pathExpansionPort: RecallServicePathExpansionPort = {
      findByAnchors: vi.fn(async (_workspaceId: string, anchorRefs: readonly PathAnchorRef[]) => {
        const ids = new Set(
          anchorRefs.flatMap((ref) => (ref.kind === "object" ? [ref.object_id] : []))
        );
        return ids.has("seed-memory") || ids.has("filtered-neighbor")
          ? [seedToFilteredNeighbor]
          : [];
      })
    };
    const service = new RecallService({
      ...dependencies,
      pathExpansionPort
    });
    const basePolicy = service.buildDefaultPolicy("analyze", createTaskSurface().runtime_id);
    const policy = overridePolicy(basePolicy, {
      coarse_filter: {
        ...basePolicy.coarse_filter,
        deterministic_match: {
          ...basePolicy.coarse_filter.deterministic_match,
          dimension_filter: [MemoryDimension.PROCEDURE]
        },
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

    expect(result.candidates.map((candidate) => candidate.object_id)).toContain("seed-memory");
    const filteredNeighbor = result.diagnostics?.candidates.find(
      (candidate) => candidate.object_id === "filtered-neighbor"
    );
    expect(filteredNeighbor?.admission_planes ?? []).not.toContain("graph_expansion");
    expect(result.diagnostics?.graph_expansion_plane_count_per_hop).toEqual([0, 0]);
    expect(result.diagnostics?.graph_expansion_plane_count_per_edge_type).toEqual({
      derives_from: 0,
      recalls: 0,
      supports: 0
    });
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
        countInboundSupports: vi.fn(async () => {
          throw new Error("graph support unavailable");
        }),
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

  describe("structural delivery reserve", () => {
    // Build the anchor + lexical multi-stream decoys + a structural gold that
    // expands off the anchor via path_expansion. The anchor is the entity seed;
    // each decoy holds a strong path so the gold ranks LOW on the path_expansion
    // stream — a single-stream structural candidate with a poor stream rank is
    // exactly the burial reserveStructuralDeliverySlots rescues.
    const buildStructuralFixture = (params: {
      readonly decoyCount: number;
      readonly goldPathStrength: number;
    }) => {
      const anchor = createMemoryEntry({
        object_id: "memory-anchor",
        content: "MaterializationRouter binds memory creation strongly.",
        dimension: MemoryDimension.PROCEDURE,
        domain_tags: ["repo"]
      });
      const decoys = Array.from({ length: params.decoyCount }, (_unused, index) =>
        createMemoryEntry({
          object_id: `decoy-${index + 1}`,
          content: "MaterializationRouter binds memory creation strongly here.",
          dimension: MemoryDimension.PROCEDURE,
          domain_tags: ["repo"]
        })
      );
      const gold = createMemoryEntry({
        object_id: "memory-gold",
        content: "Quiet downstream consumer with no query overlap zzz.",
        dimension: MemoryDimension.FACT,
        domain_tags: ["unrelated-domain"],
        activation_score: 0.05
      });
      const findByAnchors: RecallServicePathExpansionPort["findByAnchors"] = vi.fn(
        async (_workspaceId: string, anchorRefs: readonly PathAnchorRef[]) => {
          const ids = new Set(
            anchorRefs.flatMap((ref) => (ref.kind === "object" ? [ref.object_id] : []))
          );
          if (!ids.has("memory-anchor")) {
            return [];
          }
          return [
            ...decoys.map((decoy, index) =>
              createPathRelation({
                path_id: `path-${decoy.object_id}`,
                sourceId: "memory-anchor",
                targetId: decoy.object_id,
                relationKind: "supports",
                recallBias: 1 - index * 0.05,
                strength: 1 - index * 0.05
              })
            ),
            createPathRelation({
              path_id: "path-gold",
              sourceId: "memory-anchor",
              targetId: "memory-gold",
              relationKind: "supports",
              recallBias: params.goldPathStrength,
              strength: params.goldPathStrength,
              stabilityClass: "normal"
            })
          ];
        }
      );
      return { anchor, decoys, gold, findByAnchors };
    };

    const buildStructuralService = (params: {
      readonly anchor: Readonly<MemoryEntry>;
      readonly decoys: readonly Readonly<MemoryEntry>[];
      readonly gold: Readonly<MemoryEntry>;
      readonly findByAnchors: RecallServicePathExpansionPort["findByAnchors"];
      readonly synthesisRows?: readonly SynthesisCapsule[];
    }) => {
      const memories = [params.anchor, ...params.decoys, params.gold];
      const { dependencies } = createDependencies(memories);
      const lexicalRows = [params.anchor, ...params.decoys].map((memory, index) => ({
        object_id: memory.object_id,
        normalized_rank: 1 - index * 0.02
      }));
      // The active lexical lane is searchByKeywordWithinObjectIds (preferred over
      // searchByKeyword when both are wired). The anchor + every decoy hold strong
      // lexical ranks; memory-gold holds the WEAKEST hit (0.04) so it ranks last
      // in the lexical_fts stream. Under the corrected I-1 contract a structural
      // gold the reserve rescues must be relevance-bearing (not a pure
      // membership-reached sibling), but the bottom-ranked 0.04 hit keeps the gold
      // topology-DOMINATED and buried below the flat cut — the decoys out-fuse it
      // on both the lexical and path lanes.
      const withinObjectIdRows = [
        { object_id: "memory-anchor", normalized_rank: 0.9 },
        ...params.decoys.map((decoy, index) => ({
          object_id: decoy.object_id,
          normalized_rank: 0.88 - index * 0.02
        })),
        { object_id: "memory-gold", normalized_rank: 0.04 }
      ];
      return new RecallService({
        ...dependencies,
        memoryRepo: {
          ...dependencies.memoryRepo,
          searchByKeyword: vi.fn(async () => lexicalRows),
          searchByKeywordWithinObjectIds: vi.fn(async (_workspaceId: string, query: string) =>
            query.toLowerCase().includes("materializationrouter") ? withinObjectIdRows : []
          )
        },
        pathExpansionPort: { findByAnchors: params.findByAnchors },
        entityExtractionPort: {
          extract: async () => [
            Object.freeze({
              surface: "MaterializationRouter",
              normalized: "materializationrouter",
              kind: "quoted" as const,
              confidence: 1.0
            })
          ]
        },
        ...(params.synthesisRows
          ? {
              synthesisSearchPort: {
                searchByKeyword: vi.fn(async () =>
                  params.synthesisRows!.map((row, index) => ({
                    object_id: row.object_id,
                    normalized_rank: 1 - index * 0.1
                  }))
                ),
                findByIds: vi.fn(async () => params.synthesisRows!)
              }
            }
          : {})
      });
    };

    const runStructuralRecall = (service: RecallService, maxEntries: number) => {
      const policy = overridePolicy(
        service.buildDefaultPolicy("chat", createTaskSurface().runtime_id),
        {
          // Widen the lexical supplement so a structural gold's bottom-ranked weak
          // lexical co-admission (its gold-blind relevance signal under the
          // corrected I-1 contract) is not dropped by the default top-N cut. The
          // gold still ranks last in the lexical_fts stream and stays buried.
          coarse_filter: {
            deterministic_match: { scope_filter: null, dimension_filter: null, domain_tag_filter: null },
            precomputed_rank: { max_candidates: 50, min_activation_score: 0.01 },
            semantic_supplement: { enabled: true, max_supplement: 20, embedding_enabled: false }
          },
          fine_assessment: {
            budgets: { max_entries: maxEntries, max_total_tokens: 40000, per_dimension_limits: null },
            conflict_awareness: false
          }
        }
      );
      return service.recall({
        taskSurface: {
          ...createTaskSurface(),
          display_name: "How does MaterializationRouter coordinate writes?"
        },
        workspaceId: "workspace-1",
        strategy: "chat",
        policyOverride: policy
      });
    };

    const buildCompositionSynthesis = (id: string): SynthesisCapsule => ({
      object_id: id,
      object_kind: "synthesis_capsule",
      schema_version: 1,
      lifecycle_state: "active",
      created_at: "2026-03-23T00:00:00.000Z",
      updated_at: "2026-03-23T00:00:00.000Z",
      created_by: "system",
      topic_key: `recall/${id}`,
      synthesis_type: "cross_evidence",
      summary: `Cross-evidence synthesis ${id}.`,
      evidence_refs: ["evidence-1"],
      source_memory_refs: [],
      workspace_id: "workspace-1",
      run_id: "run-1",
      synthesis_status: SynthesisStatus.WORKING
    });

    it("tail-places a structural-plane gold ranked below the flat delivery cut", async () => {
      const fixture = buildStructuralFixture({ decoyCount: 6, goldPathStrength: 0.05 });
      const service = buildStructuralService(fixture);

      const result = await runStructuralRecall(service, 5);
      const delivered = result.candidates;

      const goldDiagnostic = result.diagnostics?.candidates.find(
        (candidate) => candidate.object_id === "memory-gold"
      );
      // The gold is topology-DOMINATED (path_expansion) and carries a tiny lexical
      // co-admission (0.04) that satisfies the gold-blind relevance guard without
      // lifting it out of structural dominance. It still lands below the
      // entry-count cut on fused rank.
      expect(goldDiagnostic?.admission_planes).toContain("path_expansion");
      expect(goldDiagnostic?.admission_planes).toContain("lexical");
      const goldContributions = goldDiagnostic?.fused_rank_contribution_per_stream;
      expect((goldContributions?.path_expansion ?? 0) + (goldContributions?.graph_expansion ?? 0))
        .toBeGreaterThan(
          (goldContributions?.lexical_fts ?? 0) +
            (goldContributions?.trigram_fts ?? 0) +
            (goldContributions?.evidence_fts ?? 0)
        );
      expect(goldDiagnostic?.pre_budget_rank ?? 0).toBeGreaterThan(5);

      // The reserve tail-places the buried structural gold into delivery.
      expect(delivered.map((candidate) => candidate.object_id)).toContain("memory-gold");
      // Head slot is a pure multi-stream fusion winner, not a reserved tail row.
      const headDiagnostic = result.diagnostics?.candidates.find(
        (candidate) => candidate.object_id === delivered[0]?.object_id
      );
      expect(headDiagnostic?.admission_planes).toContain("lexical");
      // A weakest in-budget non-structural row yielded its slot to the reserve.
      expect(delivered.map((candidate) => candidate.object_id)).not.toContain("memory-anchor");
    });

    it("is a no-op when the structural candidate already sits inside the delivery window", async () => {
      // A lone structural candidate is rank-1 on its weight-3 stream, so it wins
      // a natural in-window slot; the reserve must not perturb that ordering.
      const fixture = buildStructuralFixture({ decoyCount: 2, goldPathStrength: 1 });
      const findByAnchorsSingle: RecallServicePathExpansionPort["findByAnchors"] = vi.fn(
        async (_workspaceId: string, anchorRefs: readonly PathAnchorRef[]) => {
          const ids = new Set(
            anchorRefs.flatMap((ref) => (ref.kind === "object" ? [ref.object_id] : []))
          );
          return ids.has("memory-anchor")
            ? [
                createPathRelation({
                  path_id: "path-gold",
                  sourceId: "memory-anchor",
                  targetId: "memory-gold",
                  relationKind: "supports"
                })
              ]
            : [];
        }
      );
      const service = buildStructuralService({ ...fixture, findByAnchors: findByAnchorsSingle });

      const result = await runStructuralRecall(service, 5);
      const delivered = result.candidates.map((candidate) => candidate.object_id);
      const goldDiagnostic = result.diagnostics?.candidates.find(
        (candidate) => candidate.object_id === "memory-gold"
      );

      expect(delivered).toContain("memory-gold");
      // Already in-window: its delivery rank equals its natural fused rank, so
      // no tail displacement occurred.
      expect(goldDiagnostic?.final_rank).toBe(goldDiagnostic?.pre_budget_rank);
      expect(goldDiagnostic?.pre_budget_rank ?? 99).toBeLessThanOrEqual(5);
    });

    it("composes synthesis and structural reserves within maxEntries leaving a pure-fusion head slot", async () => {
      const fixture = buildStructuralFixture({ decoyCount: 6, goldPathStrength: 0.05 });
      const synthesisRows = ["synthesis-1", "synthesis-2", "synthesis-3"].map(buildCompositionSynthesis);
      const service = buildStructuralService({ ...fixture, synthesisRows });

      const result = await runStructuralRecall(service, 5);
      const delivered = result.candidates;
      const kinds = delivered.map((candidate) => candidate.object_kind);
      const diagnosticsById = new Map(
        (result.diagnostics?.candidates ?? []).map((candidate) => [candidate.object_id, candidate])
      );
      // Both reserves run at maxEntries=5: the synthesis reserve evicts the
      // weakest in-window rows, then the structural reserve re-rescues the
      // strongest structural rows. Neither permanently evicts the other.
      const synthesisDelivered = delivered.filter(
        (candidate) => candidate.object_kind === "synthesis_capsule"
      );
      const structuralDelivered = delivered.filter((candidate) => {
        const diagnostic = diagnosticsById.get(candidate.object_id);
        return (
          candidate.object_kind === "memory_entry" &&
          (diagnostic?.admission_planes.includes("path_expansion") ?? false)
        );
      });

      // No overflow: delivery never exceeds the entry-count budget.
      expect(delivered.length).toBeLessThanOrEqual(5);
      // Both reserved planes coexist in the same delivery window.
      expect(synthesisDelivered.length).toBeGreaterThan(0);
      expect(structuralDelivered.length).toBeGreaterThan(0);
      // The combined reserve leaves >= 1 pure-fusion head slot: the head row is
      // a natural in-window lexical winner, neither a reserved synthesis nor a
      // tail-placed structural row.
      const head = delivered[0];
      expect(head?.object_kind).toBe("memory_entry");
      const headDiagnostic = head ? diagnosticsById.get(head.object_id) : undefined;
      expect(headDiagnostic?.admission_planes).toContain("lexical");
      expect(headDiagnostic?.pre_budget_rank).toBe(1);
      // Synthesis stays at the very tail; structural rows sit ahead of it, never
      // pushed out of the window by the structural reserve.
      expect(kinds[kinds.length - 1]).toBe("synthesis_capsule");
    });

    it("leaves synthesis-only reserve behavior unchanged when no structural candidate is buried", async () => {
      // Mirror of the synthesis reserve test: with the structural reserve wired
      // but no structural plane present, delivery must equal the synthesis-only
      // outcome (two top synthesis rows tail-placed below three memory_entry).
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
      const synthesisRows = ["synthesis-1", "synthesis-2", "synthesis-3"].map(buildCompositionSynthesis);
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

    // Flexible builder mirroring buildStructuralFixture: lexical multi-stream
    // decoys each holding a strong anchor->decoy path (so the golds rank LOW on
    // the shared path_expansion stream and land below the flat cut), plus N
    // golds with independent weak path strengths. Optional per-candidate extra
    // lexical rows let a structural gold carry a WEAK lexical co-admission, or a
    // filler carry a STRONG lexical hit on top of its path co-admission.
    const buildMultiGoldFixture = (params: {
      readonly decoyCount: number;
      // object_id -> path recall_bias/strength on the anchor->gold edge.
      readonly golds: ReadonlyArray<{ readonly id: string; readonly pathStrength: number }>;
      // Lexical-only candidates with NO path edge (graph/path contribution 0).
      readonly fillerIds?: readonly string[];
      // Extra lexical rows keyed by object_id (rank in [0,1]).
      readonly extraLexicalRanks?: Readonly<Record<string, number>>;
    }) => {
      const anchor = createMemoryEntry({
        object_id: "memory-anchor",
        content: "MaterializationRouter binds memory creation strongly.",
        dimension: MemoryDimension.PROCEDURE,
        domain_tags: ["repo"]
      });
      const decoys = Array.from({ length: params.decoyCount }, (_unused, index) =>
        createMemoryEntry({
          object_id: `decoy-${index + 1}`,
          content: "MaterializationRouter binds memory creation strongly here.",
          dimension: MemoryDimension.PROCEDURE,
          domain_tags: ["repo"]
        })
      );
      const golds = params.golds.map((gold) =>
        createMemoryEntry({
          object_id: gold.id,
          content: "Quiet downstream consumer with no query overlap zzz.",
          dimension: MemoryDimension.FACT,
          domain_tags: ["unrelated-domain"],
          activation_score: 0.05
        })
      );
      // Lexical-only fillers: no path edge, so graph/path contribution is 0 and
      // they are never structural-rescue candidates regardless of lexical rank.
      const fillers = (params.fillerIds ?? []).map((id) =>
        createMemoryEntry({
          object_id: id,
          content: "MaterializationRouter strong lexical filler match.",
          dimension: MemoryDimension.PROCEDURE,
          domain_tags: ["repo"]
        })
      );
      const findByAnchors: RecallServicePathExpansionPort["findByAnchors"] = vi.fn(
        async (_workspaceId: string, anchorRefs: readonly PathAnchorRef[]) => {
          const ids = new Set(
            anchorRefs.flatMap((ref) => (ref.kind === "object" ? [ref.object_id] : []))
          );
          if (!ids.has("memory-anchor")) {
            return [];
          }
          return [
            ...decoys.map((decoy, index) =>
              createPathRelation({
                path_id: `path-${decoy.object_id}`,
                sourceId: "memory-anchor",
                targetId: decoy.object_id,
                relationKind: "supports",
                recallBias: 1 - index * 0.05,
                strength: 1 - index * 0.05
              })
            ),
            ...params.golds.map((gold) =>
              createPathRelation({
                path_id: `path-${gold.id}`,
                sourceId: "memory-anchor",
                targetId: gold.id,
                relationKind: "supports",
                recallBias: gold.pathStrength,
                strength: gold.pathStrength,
                stabilityClass: "normal"
              })
            )
          ];
        }
      );
      const memories = [anchor, ...decoys, ...golds, ...fillers];
      const { dependencies } = createDependencies(memories);
      // Anchor is the entity-seed lexical hit. Per-candidate extra lexical ranks
      // layer on top via searchByKeywordWithinObjectIds so a structural gold can
      // carry a WEAK 0.04 hit or a filler a STRONG 0.95 hit. Candidates absent
      // from this map admit only on their path/structural plane.
      const lexicalRanks: Record<string, number> = {
        "memory-anchor": 0.9,
        ...(params.extraLexicalRanks ?? {})
      };
      const service = new RecallService({
        ...dependencies,
        memoryRepo: {
          ...dependencies.memoryRepo,
          searchByKeywordWithinObjectIds: vi.fn(
            async (_workspaceId: string, query: string, limit: number, candidateIds?: readonly string[]) =>
              query.toLowerCase().includes("materializationrouter")
                ? Object.entries(lexicalRanks)
                    .filter(
                      ([object_id]) => candidateIds === undefined || candidateIds.includes(object_id)
                    )
                    .map(([object_id, normalized_rank]) => ({ object_id, normalized_rank }))
                    .sort((left, right) => right.normalized_rank - left.normalized_rank)
                    .slice(0, limit)
                : []
          )
        },
        pathExpansionPort: { findByAnchors },
        entityExtractionPort: {
          extract: async () => [
            Object.freeze({
              surface: "MaterializationRouter",
              normalized: "materializationrouter",
              kind: "quoted" as const,
              confidence: 1.0
            })
          ]
        }
      });
      return { service, golds: golds.map((gold) => gold.object_id) };
    };

    const goldDiag = (
      result: Awaited<ReturnType<RecallService["recall"]>>,
      id: string
    ) => result.diagnostics?.candidates.find((candidate) => candidate.object_id === id);

    // Mirror the production gate from the candidate diagnostics so tests pin the
    // exact contract rather than a hand-guessed admission shape. structural =
    // graph/path topology lanes; lexical = the lexical/evidence-FTS/agreement
    // lanes; structural(generic)/existing_score/recency/activation are neutral
    // (excluded from both).
    // see also: recall-service.ts STRUCTURAL_FUSION_STREAMS / LEXICAL_LANE_FUSION_STREAMS.
    const structuralContribution = (
      diagnostic: ReturnType<typeof goldDiag>
    ): number => {
      const contributions = diagnostic?.fused_rank_contribution_per_stream;
      if (contributions === undefined) {
        return 0;
      }
      return contributions.graph_expansion + contributions.path_expansion;
    };
    const lexicalLaneContribution = (
      diagnostic: ReturnType<typeof goldDiag>
    ): number => {
      const contributions = diagnostic?.fused_rank_contribution_per_stream;
      if (contributions === undefined) {
        return 0;
      }
      return (
        contributions.lexical_fts +
        contributions.trigram_fts +
        contributions.synthesis_fts +
        contributions.evidence_fts +
        contributions.evidence_structural_agreement +
        contributions.source_proximity +
        contributions.source_evidence_agreement +
        contributions.subject_alignment +
        contributions.embedding_similarity +
        contributions.entity_seed
      );
    };
    const isStructuralDominant = (diagnostic: ReturnType<typeof goldDiag>): boolean => {
      const structural = structuralContribution(diagnostic);
      return structural > 0 && structural > lexicalLaneContribution(diagnostic);
    };

    it("does not rescue a buried structural gold when maxEntries clamps the reserve to zero", async () => {
      // At maxEntries=1 the reserve budget is maxEntries - 1 - reservedTail = 0,
      // so the single pure-fusion head slot must survive untouched and the
      // buried structural gold stays cut.
      const { service } = buildMultiGoldFixture({
        decoyCount: 6,
        golds: [{ id: "memory-gold", pathStrength: 0.05 }]
      });
      const result = await runStructuralRecall(service, 1);
      const delivered = result.candidates;
      expect(delivered.length).toBe(1);
      expect(delivered.map((candidate) => candidate.object_id)).not.toContain("memory-gold");
      // The surviving slot is the natural pure-fusion head (rank 1), not a
      // tail-placed reserve row.
      const headDiagnostic = goldDiag(result, delivered[0]!.object_id);
      expect(headDiagnostic?.pre_budget_rank).toBe(1);
    });

    it("respects the maxEntries=2 and 3 reserve boundary: no overflow, a pure-fusion head survives, reserve count clamps to the budget", async () => {
      const STRUCTURAL_DELIVERY_RESERVE = 2;
      for (const maxEntries of [2, 3]) {
        const { service } = buildMultiGoldFixture({
          decoyCount: 6,
          golds: [{ id: "memory-gold", pathStrength: 0.05 }]
        });
        const result = await runStructuralRecall(service, maxEntries);
        const delivered = result.candidates;
        const deliveredIds = delivered.map((candidate) => candidate.object_id);
        const diagnostics = result.diagnostics?.candidates ?? [];

        // No overflow of the entry-count budget.
        expect(delivered.length).toBeLessThanOrEqual(maxEntries);
        // >= 1 pure-fusion head slot survives (the natural rank-1 fusion winner).
        const headIds = new Set(deliveredIds);
        expect([...headIds].some((id) => goldDiag(result, id)?.pre_budget_rank === 1)).toBe(true);

        // The reserve places exactly min(STRUCTURAL_DELIVERY_RESERVE, buried,
        // maxEntries - 1) buried structural candidates, ranked by contribution,
        // and never displaces the rank-1 head.
        const buriedStructural = diagnostics
          .filter(
            (candidate) =>
              (candidate.pre_budget_rank ?? 0) > maxEntries && isStructuralDominant(candidate)
          )
          .sort((left, right) => structuralContribution(right) - structuralContribution(left));
        const expectedReserveCount = Math.min(
          STRUCTURAL_DELIVERY_RESERVE,
          buriedStructural.length,
          maxEntries - 1
        );
        const rescuedFromBuried = buriedStructural
          .slice(0, expectedReserveCount)
          .map((candidate) => candidate.object_id);
        for (const id of rescuedFromBuried) {
          expect(deliveredIds).toContain(id);
        }
        // The rank-1 head is never evicted by the reserve.
        const headId = diagnostics.find((candidate) => candidate.pre_budget_rank === 1)?.object_id;
        expect(headId).toBeDefined();
        expect(deliveredIds).toContain(headId!);
      }
    });

    it("rescues only the top STRUCTURAL_DELIVERY_RESERVE buried structural candidates ranked by structural contribution", async () => {
      // Three golds with descending path strength -> descending structural fusion
      // contribution. With more buried structural candidates than the reserve
      // budget, only the top STRUCTURAL_DELIVERY_RESERVE (2) by that signal earn
      // a slot; the rest stay cut. The expected rescued set is computed from the
      // diagnostics using the SAME structural-dominance + structural-contribution
      // ranking the production gate uses, so this pins the ranking signal as the
      // query-relevance-weighted structural fusion contribution rather than raw
      // connectivity or arbitrary order. The weakest buried structural candidate
      // is the "distractor" that loses its slot to the more query-relevant golds.
      const STRUCTURAL_DELIVERY_RESERVE = 2;
      // Each gold carries a tiny lexical co-admission (0.04) so it passes the
      // gold-blind query/evidence-relevance guard while staying topology-
      // dominated (its weak 0.04 lexical_fts term sits below its path
      // contribution). The decoys hold STRONG lexical hits (0.89-0.99) so the
      // golds rank last in the lexical_fts stream and stay buried below the flat
      // cut. A relevance-bearing structural gold is the genuine fan-in the
      // reserve rescues; a zero-relevance membership-only sibling is refused.
      const { service } = buildMultiGoldFixture({
        decoyCount: 6,
        golds: [
          { id: "gold-strong", pathStrength: 0.5 },
          { id: "gold-mid", pathStrength: 0.3 },
          { id: "gold-weak-distractor", pathStrength: 0.05 }
        ],
        extraLexicalRanks: {
          "decoy-1": 0.99,
          "decoy-2": 0.97,
          "decoy-3": 0.95,
          "decoy-4": 0.93,
          "decoy-5": 0.91,
          "decoy-6": 0.89,
          "gold-strong": 0.04,
          "gold-mid": 0.04,
          "gold-weak-distractor": 0.04
        }
      });
      const result = await runStructuralRecall(service, 5);
      const delivered = result.candidates.map((candidate) => candidate.object_id);
      const diagnostics = result.diagnostics?.candidates ?? [];

      // All three golds are buried below the flat cut (single-stream structural).
      for (const id of ["gold-strong", "gold-mid", "gold-weak-distractor"]) {
        expect(goldDiag(result, id)?.pre_budget_rank ?? 0).toBeGreaterThan(5);
      }

      // Buried structural-dominant candidates = those whose pre-budget rank is
      // beyond the window AND structural streams dominate the fused score.
      const buriedStructural = diagnostics
        .filter(
          (candidate) =>
            (candidate.pre_budget_rank ?? 0) > 5 && isStructuralDominant(candidate)
        )
        .sort((left, right) => structuralContribution(right) - structuralContribution(left));
      // More buried structural candidates than the reserve can hold.
      expect(buriedStructural.length).toBeGreaterThan(STRUCTURAL_DELIVERY_RESERVE);

      const expectedRescued = buriedStructural
        .slice(0, STRUCTURAL_DELIVERY_RESERVE)
        .map((candidate) => candidate.object_id);
      const expectedCut = buriedStructural
        .slice(STRUCTURAL_DELIVERY_RESERVE)
        .map((candidate) => candidate.object_id);

      // The top-2 by structural contribution are delivered; the rest stay cut.
      for (const id of expectedRescued) {
        expect(delivered).toContain(id);
      }
      for (const id of expectedCut) {
        expect(delivered).not.toContain(id);
      }
      // The descending path strengths make the golds the clearly ranked tail:
      // gold-strong and gold-mid out-contribute gold-weak-distractor, which is
      // the lowest-relevance structural candidate and must be the one cut.
      expect(
        structuralContribution(goldDiag(result, "gold-strong"))
      ).toBeGreaterThan(structuralContribution(goldDiag(result, "gold-weak-distractor")));
      expect(delivered).not.toContain("gold-weak-distractor");
    });

    it("rescues a structural gold co-admitted weakly on lexical, but not a strong-lexical filler", async () => {
      // The Important-fix regression pin. The genuine structural gold has real
      // path reach AND a tiny lexical co-admission (rank 0.04); admission-plane
      // membership and stream dominance are decoupled, so its fused score is
      // still graph/path-topology-dominated and it must be rescued. The filler
      // (filler-9 shape) has a STRONG lexical hit but NO graph/path reach, so its
      // topology contribution is zero and it competes fairly on the flat cut. The
      // old admission-plane gate dropped the weak-lexical gold (lexical plane
      // present -> excluded); the stream dominance gate rescues it while still
      // excluding the lexical-only filler.
      // Decoys carry strong lexical AND a strong path (multi-stream) so they
      // out-fuse the gold and keep it below the cut; the gold has a weak path
      // plus a tiny lexical hit (0.04). A widened max_supplement admits the
      // gold's low-ranked lexical hit so it genuinely co-admits on lexical while
      // staying buried. The filler has a strong lexical hit and NO path.
      const { service } = buildMultiGoldFixture({
        decoyCount: 6,
        golds: [{ id: "gold-weak-lexical", pathStrength: 0.05 }],
        fillerIds: ["filler-strong-lexical"],
        extraLexicalRanks: {
          "decoy-1": 0.99,
          "decoy-2": 0.97,
          "decoy-3": 0.95,
          "decoy-4": 0.93,
          "decoy-5": 0.91,
          "decoy-6": 0.89,
          "gold-weak-lexical": 0.04,
          "filler-strong-lexical": 0.95
        }
      });
      // Widen the lexical supplement so the gold's bottom-ranked weak hit is not
      // dropped by the default max_supplement top-N cut.
      const policy = overridePolicy(
        service.buildDefaultPolicy("chat", createTaskSurface().runtime_id),
        {
          coarse_filter: {
            deterministic_match: { scope_filter: null, dimension_filter: null, domain_tag_filter: null },
            precomputed_rank: { max_candidates: 50, min_activation_score: 0.01 },
            semantic_supplement: { enabled: true, max_supplement: 20, embedding_enabled: false }
          },
          fine_assessment: {
            budgets: { max_entries: 5, max_total_tokens: 40000, per_dimension_limits: null },
            conflict_awareness: false
          }
        }
      );
      const result = await service.recall({
        taskSurface: {
          ...createTaskSurface(),
          display_name: "How does MaterializationRouter coordinate writes?"
        },
        workspaceId: "workspace-1",
        strategy: "chat",
        policyOverride: policy
      });
      const delivered = result.candidates.map((candidate) => candidate.object_id);

      // The gold is co-admitted on BOTH a structural plane (path_expansion) AND
      // lexical, proving admission-plane membership and stream dominance are
      // decoupled. It is below the natural cut (the weak lexical hit does not
      // lift it past the path-buried region).
      const goldDiagnostic = goldDiag(result, "gold-weak-lexical");
      expect(goldDiagnostic?.admission_planes).toContain("path_expansion");
      expect(goldDiagnostic?.admission_planes).toContain("lexical");
      expect(goldDiagnostic?.pre_budget_rank ?? 0).toBeGreaterThan(5);
      // Its graph/path topology streams dominate its lexical-lane contribution.
      expect(isStructuralDominant(goldDiagnostic)).toBe(true);

      // The filler is lexical-dominated with zero graph/path topology reach.
      const fillerDiagnostic = goldDiag(result, "filler-strong-lexical");
      expect(fillerDiagnostic?.admission_planes).toContain("lexical");
      expect(structuralContribution(fillerDiagnostic)).toBe(0);
      expect(isStructuralDominant(fillerDiagnostic)).toBe(false);

      // Stream dominance threads the needle: the weak-lexical structural gold is
      // rescued; the strong-lexical filler is not.
      expect(delivered).toContain("gold-weak-lexical");
      expect(delivered).not.toContain("filler-strong-lexical");
    });

    it("composes the strong-lexical delivery-window reorder with a buried structural rescue", async () => {
      // A strong-lexical decoy sits in the delivery window and is reordered
      // forward by prioritizeStrongLexicalDeliveryWindowCandidates; a buried
      // structural gold is rescued into the tail at the same time. Both passes
      // run without evicting each other and without overflowing the budget.
      // memory-gold carries a tiny lexical co-admission (0.04) so it passes the
      // gold-blind relevance guard while staying topology-dominated; every decoy
      // holds a strong lexical hit so the gold ranks last in the lexical_fts
      // stream and stays buried, while decoy-1 (rank 1) is reordered forward into
      // the head window.
      const { service } = buildMultiGoldFixture({
        decoyCount: 6,
        golds: [{ id: "memory-gold", pathStrength: 0.05 }],
        extraLexicalRanks: {
          "decoy-1": 1,
          "decoy-2": 0.97,
          "decoy-3": 0.95,
          "decoy-4": 0.93,
          "decoy-5": 0.91,
          "decoy-6": 0.89,
          "memory-gold": 0.04
        }
      });
      const result = await runStructuralRecall(service, 5);
      const delivered = result.candidates;
      const deliveredIds = delivered.map((candidate) => candidate.object_id);

      expect(delivered.length).toBeLessThanOrEqual(5);
      // The structural gold is rescued into the window.
      expect(deliveredIds).toContain("memory-gold");
      // A strong-lexical decoy holds a head slot ahead of the tail-placed gold.
      const goldPosition = deliveredIds.indexOf("memory-gold");
      const strongLexicalPosition = deliveredIds.findIndex((id) => {
        const diagnostic = goldDiag(result, id);
        return (diagnostic?.admission_planes.includes("lexical") ?? false) && id !== "memory-gold";
      });
      expect(strongLexicalPosition).toBeGreaterThanOrEqual(0);
      expect(strongLexicalPosition).toBeLessThan(goldPosition);
      // The structural gold is a true tail row, not displacing the head slot.
      expect(goldDiag(result, delivered[0]!.object_id)?.pre_budget_rank).toBe(1);
    });
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
      // graph_expansion now traverses PathRelation rows. The entity anchor is
      // also a draft expansion seed, so its direct hop-1 neighbor is admitted
      // on path_expansion (the unified plane's direct lane); the double-count
      // guard keeps it off graph_expansion. The entity seed still fans into the
      // graph BFS (Pool B) — that reach drives the multi_seed_graph_fan_in
      // diagnostic — but the neighbor's winning plane is path_expansion.
      const findByAnchors = vi.fn(async (_workspaceId: string, anchorRefs: readonly PathAnchorRef[]) => {
        const ids = new Set(
          anchorRefs.flatMap((ref) => (ref.kind === "object" ? [ref.object_id] : []))
        );
        return ids.has("memory-anchor")
          ? [
              createPathRelation({
                path_id: "path-1",
                sourceId: "memory-anchor",
                targetId: "memory-neighbor",
                relationKind: "derives_from"
              })
            ]
          : [];
      });

      const service = new RecallService({
        ...dependencies,
        memoryRepo: {
          ...dependencies.memoryRepo,
          searchByKeywordWithinObjectIds
        },
        pathExpansionPort: {
          findByAnchors
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
      expect(neighborDiag?.admission_planes).toContain("path_expansion");

      expect(findByAnchors).toHaveBeenCalledWith(
        "workspace-1",
        expect.arrayContaining([{ kind: "object", object_id: "memory-anchor" }])
      );
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
      // Path-backed plane: a directed path memory-anchor -> memory-neighbor so
      // that IF the weak entity-only draft were (wrongly) selected as a graph
      // BFS seed, the traversal would fan forward into memory-neighbor on
      // graph_expansion. source_to_target keeps memory-neighbor from pulling
      // memory-anchor backward onto path_expansion, so the only way the neighbor
      // reaches graph_expansion is memory-anchor seeding the traversal — which
      // the weak-entity-only gate must prevent.
      const anchorToNeighbor = createPathRelation({
        path_id: "path-anchor-neighbor",
        sourceId: "memory-anchor",
        targetId: "memory-neighbor",
        relationKind: "derives_from",
        directionBias: "source_to_target",
        strength: 1
      });
      const findByAnchors = vi.fn(
        async (_workspaceId: string, anchorRefs: readonly PathAnchorRef[]) => {
          const ids = new Set(
            anchorRefs.flatMap((ref) => (ref.kind === "object" ? [ref.object_id] : []))
          );
          return ids.has("memory-anchor") || ids.has("memory-neighbor")
            ? [anchorToNeighbor]
            : [];
        }
      );

      const service = new RecallService({
        ...dependencies,
        memoryRepo: {
          ...dependencies.memoryRepo,
          searchByKeywordWithinObjectIds
        },
        pathExpansionPort: { findByAnchors },
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
      // invariant: the weak entity-only anchor must NEVER seed the path-backed
      // graph traversal, so its neighbor never reaches the graph_expansion plane.
      const neighborDiag = result.diagnostics?.candidates.find(
        (c) => c.object_id === "memory-neighbor"
      );
      expect(neighborDiag?.admission_planes ?? []).not.toContain("graph_expansion");
      // invariant: the weak entity-only anchor is excluded from
      // selectExpansionSeedDrafts, so it never seeds the path-backed traversal
      // (the neighbor-absent-from-graph_expansion assertion above is the
      // authoritative behavioral guarantee). A findByAnchors call carrying
      // memory-anchor no longer implies frontier seeding: the post-coarse
      // governance-ceiling read passes every admitted candidate id (including
      // this entity-seed-admitted anchor) for an INBOUND-governance lookup
      // keyed on each candidate's target_anchor, not a traversal seed.
      // see also: recall-service.ts collectGovernanceCeilings (ceiling read)
      //   vs expandGraphFrontier / addPathExpansionCandidates (seed reads).
      const anchorSeededNeighborOnGraphExpansion =
        (neighborDiag?.admission_planes ?? []).includes("graph_expansion");
      expect(anchorSeededNeighborOnGraphExpansion).toBe(false);
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
      const findByAnchors = vi.fn(async (_workspaceId: string, anchorRefs: readonly PathAnchorRef[]) => {
        const ids = new Set(
          anchorRefs.flatMap((ref) => (ref.kind === "object" ? [ref.object_id] : []))
        );
        return ids.has("memory-anchor")
          ? [
              createPathRelation({
                path_id: "path-1",
                sourceId: "memory-anchor",
                targetId: "memory-neighbor",
                relationKind: "derives_from"
              })
            ]
          : [];
      });

      const service = new RecallService({
        ...dependencies,
        memoryRepo: {
          ...dependencies.memoryRepo,
          searchByKeywordWithinObjectIds
        },
        pathExpansionPort: { findByAnchors },
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
      // With co-admission present, the weak entity confidence does not block
      // expansion. The neighbor is a direct hop-1 association off the anchor,
      // so the unified plane admits it on path_expansion (the double-count
      // guard keeps it off graph_expansion).
      const neighborDiag = result.diagnostics?.candidates.find(
        (c) => c.object_id === "memory-neighbor"
      );
      expect(neighborDiag?.admission_planes).toContain("path_expansion");
      expect(findByAnchors).toHaveBeenCalledWith(
        "workspace-1",
        expect.arrayContaining([{ kind: "object", object_id: "memory-anchor" }])
      );
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

    describe("multi-seed graph fan-in", () => {
      // see also: packages/core/src/recall-service.ts addGraphExpansionCandidates
      // Pool B branch and RecallMultiSeedGraphFanInDiagnostics. The per-seed
      // BFS now traverses PathRelation rows, so a fan-in neighbor is a path
      // source -> target whose relation_kind names the equivalent edge type.
      const pathStub = (
        id: string,
        source: string,
        target: string,
        relationKind = "derives_from"
      ): PathRelation =>
        createPathRelation({
          path_id: id,
          sourceId: source,
          targetId: target,
          relationKind
        });
      // Builds a findByAnchors mock from a source-id -> outgoing-paths map. The
      // mock returns every path anchored on any requested object id so the
      // batched multi-hop lookups resolve the right neighbors.
      const findByAnchorsFrom = (
        bySource: Readonly<Record<string, readonly PathRelation[]>>
      ) =>
        vi.fn(async (_workspaceId: string, anchorRefs: readonly PathAnchorRef[]) => {
          const ids = new Set(
            anchorRefs.flatMap((ref) => (ref.kind === "object" ? [ref.object_id] : []))
          );
          return Object.entries(bySource).flatMap(([sourceId, paths]) =>
            ids.has(sourceId) ? paths : []
          );
        });

      it("with zero entity-derived seeds emits no multi_seed_graph_fan_in diagnostic", async () => {
        // invariant: when no entity is extracted from the query, the pooled
        // legacy path drives graph_expansion and the multi_seed_graph_fan_in
        // surface stays undefined (regression protection).
        const memories = [
          createMemoryEntry({
            object_id: "memory-anchor",
            dimension: MemoryDimension.PROCEDURE,
            scope_class: ScopeClass.PROJECT,
            domain_tags: ["repo"],
            content: "anchor"
          })
        ];
        const { dependencies } = createDependencies(memories);
        const service = new RecallService({
          ...dependencies
          // entityExtractionPort intentionally unwired
        });

        const result = await service.recall({
          taskSurface: {
            ...createTaskSurface(),
            display_name: "neutral query"
          },
          workspaceId: "workspace-1",
          strategy: "chat"
        });

        expect(result.diagnostics?.multi_seed_graph_fan_in).toBeUndefined();
      });

      it("two non-overlapping entity seeds each fan independently with no dedup collisions", async () => {
        // invariant: each entity seed runs its own BFS so disjoint neighbor
        // sets land in the merged plane without dedup_collisions.
        const memories = [
          createMemoryEntry({
            object_id: "anchor-alpha",
            dimension: MemoryDimension.PROCEDURE,
            scope_class: ScopeClass.PROJECT,
            domain_tags: ["repo"],
            content: "AlphaRouter binds writes."
          }),
          createMemoryEntry({
            object_id: "anchor-beta",
            dimension: MemoryDimension.PROCEDURE,
            scope_class: ScopeClass.PROJECT,
            domain_tags: ["repo"],
            content: "BetaPlanner schedules tasks."
          }),
          createMemoryEntry({
            object_id: "neighbor-alpha",
            dimension: MemoryDimension.FACT,
            scope_class: ScopeClass.PROJECT,
            domain_tags: ["repo"],
            content: "consumer of AlphaRouter outcomes"
          }),
          createMemoryEntry({
            object_id: "neighbor-beta",
            dimension: MemoryDimension.FACT,
            scope_class: ScopeClass.PROJECT,
            domain_tags: ["repo"],
            content: "consumer of BetaPlanner outcomes"
          })
        ];
        const { dependencies } = createDependencies(memories);
        const searchByKeywordWithinObjectIds = vi.fn(
          async (_workspace: string, query: string) => {
            if (query === "AlphaRouter") {
              return [{ object_id: "anchor-alpha", normalized_rank: 0.9 }];
            }
            if (query === "BetaPlanner") {
              return [{ object_id: "anchor-beta", normalized_rank: 0.9 }];
            }
            return [];
          }
        );
        const findByAnchors = findByAnchorsFrom({
          "anchor-alpha": [pathStub("edge-a", "anchor-alpha", "neighbor-alpha")],
          "anchor-beta": [pathStub("edge-b", "anchor-beta", "neighbor-beta")]
        });

        const service = new RecallService({
          ...dependencies,
          memoryRepo: {
            ...dependencies.memoryRepo,
            searchByKeywordWithinObjectIds
          },
          pathExpansionPort: { findByAnchors },
          entityExtractionPort: {
            extract: async () => [
              Object.freeze({
                surface: "AlphaRouter",
                normalized: "alpharouter",
                kind: "quoted" as const,
                confidence: 1.0
              }),
              Object.freeze({
                surface: "BetaPlanner",
                normalized: "betaplanner",
                kind: "quoted" as const,
                confidence: 1.0
              })
            ]
          }
        });

        const result = await service.recall({
          taskSurface: {
            ...createTaskSurface(),
            display_name: "AlphaRouter and BetaPlanner coordination"
          },
          workspaceId: "workspace-1",
          strategy: "chat"
        });

        const fanIn = result.diagnostics?.multi_seed_graph_fan_in;
        expect(fanIn).toBeDefined();
        expect(fanIn?.distinct_seeds).toBe(2);
        expect(fanIn?.dedup_collisions).toBe(0);
        // Each seed produced 1 candidate so the distribution is degenerate.
        expect(fanIn?.candidates_per_seed_p50).toBe(1);
        expect(fanIn?.candidates_per_seed_p95).toBe(1);
      });

      it("overlapping entity seeds dedup by max score and report dedup_collisions", async () => {
        // invariant: when the same memory is reached from two distinct
        // entity seeds, the merger keeps a single graph_expansion admission
        // with the higher score and counts each extra arrival as a
        // dedup_collision. No double-scoring across entity paths.
        const memories = [
          createMemoryEntry({
            object_id: "anchor-alpha",
            dimension: MemoryDimension.PROCEDURE,
            scope_class: ScopeClass.PROJECT,
            domain_tags: ["repo"],
            content: "AlphaRouter binds writes."
          }),
          createMemoryEntry({
            object_id: "anchor-beta",
            dimension: MemoryDimension.PROCEDURE,
            scope_class: ScopeClass.PROJECT,
            domain_tags: ["repo"],
            content: "BetaPlanner schedules tasks."
          }),
          createMemoryEntry({
            object_id: "shared-neighbor",
            dimension: MemoryDimension.FACT,
            scope_class: ScopeClass.PROJECT,
            domain_tags: ["repo"],
            content: "downstream cross-cutting consumer"
          })
        ];
        const { dependencies } = createDependencies(memories);
        const searchByKeywordWithinObjectIds = vi.fn(
          async (_workspace: string, query: string) => {
            if (query === "AlphaRouter") {
              return [{ object_id: "anchor-alpha", normalized_rank: 0.9 }];
            }
            if (query === "BetaPlanner") {
              return [{ object_id: "anchor-beta", normalized_rank: 0.9 }];
            }
            return [];
          }
        );
        const findByAnchors = findByAnchorsFrom({
          "anchor-alpha": [pathStub("edge-a-shared", "anchor-alpha", "shared-neighbor")],
          "anchor-beta": [pathStub("edge-b-shared", "anchor-beta", "shared-neighbor")]
        });

        const service = new RecallService({
          ...dependencies,
          memoryRepo: {
            ...dependencies.memoryRepo,
            searchByKeywordWithinObjectIds
          },
          pathExpansionPort: { findByAnchors },
          entityExtractionPort: {
            extract: async () => [
              Object.freeze({
                surface: "AlphaRouter",
                normalized: "alpharouter",
                kind: "quoted" as const,
                confidence: 1.0
              }),
              Object.freeze({
                surface: "BetaPlanner",
                normalized: "betaplanner",
                kind: "quoted" as const,
                confidence: 1.0
              })
            ]
          }
        });

        const result = await service.recall({
          taskSurface: {
            ...createTaskSurface(),
            display_name: "AlphaRouter BetaPlanner shared consumer"
          },
          workspaceId: "workspace-1",
          strategy: "chat"
        });

        // The per-seed BFS still runs independently for each entity seed, so
        // the shared neighbor is reached twice and the merge records the
        // dedup_collision — this diagnostic is driven by Pool B traversal, not
        // by the final admit plane.
        const fanIn = result.diagnostics?.multi_seed_graph_fan_in;
        expect(fanIn).toBeDefined();
        expect(fanIn?.distinct_seeds).toBe(2);
        expect(fanIn?.dedup_collisions).toBeGreaterThanOrEqual(1);

        // The shared neighbor is a direct hop-1 association off both entity
        // anchors (which are themselves draft seeds), so the unified plane
        // admits it once on path_expansion; the double-count guard keeps it
        // off graph_expansion. Admission planes are a set, so it appears once.
        const sharedDiag = result.diagnostics?.candidates.find(
          (c) => c.object_id === "shared-neighbor"
        );
        expect(sharedDiag?.admission_planes).toContain("path_expansion");
        expect(sharedDiag?.admission_planes).not.toContain("graph_expansion");
        const planeOccurrences = (sharedDiag?.admission_planes ?? []).filter(
          (plane) => plane === "path_expansion"
        ).length;
        expect(planeOccurrences).toBe(1);
      });

      it("caps merged fan-in candidates at the plane cap when one seed overruns", async () => {
        // invariant: MULTI_SEED_GRAPH_FAN_OUT_CAP (= DYNAMIC_RECALL_PLANE_CAP
        // = 240) bounds the admitted set after merge. We synthesize 260
        // neighbors reachable from a single entity seed; the post-cap
        // admission count must not exceed 240.
        const FAN_OUT_OVERFLOW = 260;
        const PLANE_CAP = 240;
        const neighborMemories = Array.from({ length: FAN_OUT_OVERFLOW }, (_, i) =>
          createMemoryEntry({
            object_id: `neighbor-${i.toString().padStart(3, "0")}`,
            dimension: MemoryDimension.FACT,
            scope_class: ScopeClass.PROJECT,
            domain_tags: ["repo"],
            content: `neighbor ${i}`
          })
        );
        const memories = [
          createMemoryEntry({
            object_id: "fan-anchor",
            dimension: MemoryDimension.PROCEDURE,
            scope_class: ScopeClass.PROJECT,
            domain_tags: ["repo"],
            content: "FanRouter binds many."
          }),
          ...neighborMemories
        ];
        const { dependencies } = createDependencies(memories);
        const searchByKeywordWithinObjectIds = vi.fn(
          async (_workspace: string, query: string) => {
            if (query === "FanRouter") {
              return [{ object_id: "fan-anchor", normalized_rank: 0.9 }];
            }
            return [];
          }
        );
        const findByAnchors = findByAnchorsFrom({
          "fan-anchor": neighborMemories.map((neighbor, i) =>
            pathStub(`edge-${i}`, "fan-anchor", neighbor.object_id)
          )
        });

        const service = new RecallService({
          ...dependencies,
          memoryRepo: {
            ...dependencies.memoryRepo,
            searchByKeywordWithinObjectIds
          },
          pathExpansionPort: { findByAnchors },
          entityExtractionPort: {
            extract: async () => [
              Object.freeze({
                surface: "FanRouter",
                normalized: "fanrouter",
                kind: "quoted" as const,
                confidence: 1.0
              })
            ]
          }
        });

        const result = await service.recall({
          taskSurface: {
            ...createTaskSurface(),
            display_name: "FanRouter binding span"
          },
          workspaceId: "workspace-1",
          strategy: "chat"
        });

        // The 260 neighbors are direct hop-1 associations off the entity-seed
        // anchor, so the unified plane admits them on path_expansion under the
        // same DYNAMIC_RECALL_PLANE_CAP. graph_expansion stays empty (its hop-1
        // would double-count), and neither associative plane exceeds the cap.
        const pathExpansionCount = (result.diagnostics?.candidates ?? []).filter(
          (c) => c.admission_planes.includes("path_expansion")
        ).length;
        const graphExpansionCount = (result.diagnostics?.candidates ?? []).filter(
          (c) => c.admission_planes.includes("graph_expansion")
        ).length;
        expect(pathExpansionCount).toBeLessThanOrEqual(PLANE_CAP);
        expect(graphExpansionCount).toBeLessThanOrEqual(PLANE_CAP);
        // Sanity: the per-seed BFS still ran (the diagnostic surface confirms
        // fan-in is active even though admission routed to path_expansion).
        expect(result.diagnostics?.multi_seed_graph_fan_in?.distinct_seeds).toBe(1);
      });

      it("single entity seed records distinct_seeds=1 with degenerate distribution", async () => {
        // invariant: even a single entity-derived seed activates the
        // multi-seed code path (distinct_seeds = 1). p50 / p95 collapse
        // to the per-seed count and dedup_collisions = 0.
        const memories = [
          createMemoryEntry({
            object_id: "solo-anchor",
            dimension: MemoryDimension.PROCEDURE,
            scope_class: ScopeClass.PROJECT,
            domain_tags: ["repo"],
            content: "SoloRouter is unique."
          }),
          createMemoryEntry({
            object_id: "solo-neighbor",
            dimension: MemoryDimension.FACT,
            scope_class: ScopeClass.PROJECT,
            domain_tags: ["repo"],
            content: "consumer of SoloRouter"
          })
        ];
        const { dependencies } = createDependencies(memories);
        const searchByKeywordWithinObjectIds = vi.fn(
          async (_workspace: string, query: string) => {
            if (query === "SoloRouter") {
              return [{ object_id: "solo-anchor", normalized_rank: 0.9 }];
            }
            return [];
          }
        );
        const findByAnchors = findByAnchorsFrom({
          "solo-anchor": [pathStub("edge-solo", "solo-anchor", "solo-neighbor")]
        });

        const service = new RecallService({
          ...dependencies,
          memoryRepo: {
            ...dependencies.memoryRepo,
            searchByKeywordWithinObjectIds
          },
          pathExpansionPort: { findByAnchors },
          entityExtractionPort: {
            extract: async () => [
              Object.freeze({
                surface: "SoloRouter",
                normalized: "solorouter",
                kind: "quoted" as const,
                confidence: 1.0
              })
            ]
          }
        });

        const result = await service.recall({
          taskSurface: {
            ...createTaskSurface(),
            display_name: "SoloRouter binding scope"
          },
          workspaceId: "workspace-1",
          strategy: "chat"
        });

        const fanIn = result.diagnostics?.multi_seed_graph_fan_in;
        expect(fanIn).toBeDefined();
        expect(fanIn?.distinct_seeds).toBe(1);
        expect(fanIn?.dedup_collisions).toBe(0);
        expect(fanIn?.candidates_per_seed_p50).toBe(1);
        expect(fanIn?.candidates_per_seed_p95).toBe(1);
      });
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
    readonly collectWorkspaceNeighbors?: NonNullable<RecallServiceEmbeddingRecallPort["collectWorkspaceNeighbors"]>;
    readonly collectWorkspaceNeighborsWithMetadata?: NonNullable<
      RecallServiceEmbeddingRecallPort["collectWorkspaceNeighborsWithMetadata"]
    >;
    readonly findByIds?: NonNullable<RecallServiceMemoryRepoPort["findByIds"]>;
  }) {
    const { dependencies } = createDependencies([lexicallyAbsentMemory]);
    // `satisfies` validates the assembled ports against their precise shape
    // without widening, so missing / mistyped methods fail the typecheck gate
    // instead of being erased by an `as unknown as` cast.
    const memoryRepo = {
      ...dependencies.memoryRepo,
      ...(input.findByIds === undefined ? {} : { findByIds: input.findByIds })
    } satisfies RecallServiceMemoryRepoPort;
    const embeddingRecallService = {
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
        : { collectWorkspaceNeighbors: input.collectWorkspaceNeighbors }),
      ...(input.collectWorkspaceNeighborsWithMetadata === undefined
        ? {}
        : {
            collectWorkspaceNeighborsWithMetadata:
              input.collectWorkspaceNeighborsWithMetadata
          })
    } satisfies RecallServiceEmbeddingRecallPort;
    return new RecallService({
      ...dependencies,
      memoryRepo,
      embeddingRecallService
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

  it("counts coarse-injection query embeddings in token economy inference calls", async () => {
    const collectWorkspaceNeighborsWithMetadata = vi.fn(async () => ({
      hits: [
        Object.freeze({ object_id: lexicallyAbsentMemory.object_id, normalized_similarity: 0.95 })
      ],
      embedding_inference_calls: 1,
      query_embedding_cache_hit: false
    }));
    const findByIds = vi.fn(async () => [lexicallyAbsentMemory]);
    const service = buildEmbeddingScopedService({
      collectWorkspaceNeighborsWithMetadata,
      findByIds
    });

    const result = await service.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "analyze",
      policyOverride: buildPolicy(service, true)
    });

    expect(collectWorkspaceNeighborsWithMetadata).toHaveBeenCalledTimes(1);
    expect(result.diagnostics?.token_economy?.embedding_inference_calls).toBe(1);
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
