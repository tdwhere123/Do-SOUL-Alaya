import { describe, expect, it, vi } from "vitest";
import {
  ControlPlaneObjectKind,
  MemoryDimension,
  ObjectLifecycleState,
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
import { RecallService, type RecallServiceDependencies } from "../recall-service.js";

function createTaskSurface(): TaskObjectSurface {
  return {
    runtime_id: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
    object_kind: ControlPlaneObjectKind.TASK_OBJECT_SURFACE,
    task_surface_ref: null,
    expires_at: "2026-03-29T00:30:00.000Z",
    derived_from: null,
    retention_policy: RetentionPolicy.SESSION_ONLY,
    surface_kind: "analyze",
    display_name: "Check global recall mapping",
    context_refs: []
  };
}

function createMemoryEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    object_id: "memory-1",
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: ObjectLifecycleState.ACTIVE,
    created_at: "2026-03-20T00:00:00.000Z",
    updated_at: "2026-03-20T00:00:00.000Z",
    created_by: "system",
    dimension: MemoryDimension.PROCEDURE,
    source_kind: "user",
    formation_kind: "explicit",
    scope_class: ScopeClass.PROJECT,
    content: "Memory content",
    domain_tags: ["repo"],
    evidence_refs: ["evidence-1"],
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    storage_tier: "hot",
    activation_score: 0.8,
    retention_score: 0.8,
    manifestation_state: null,
    retention_state: "working",
    decay_profile: "stable",
    confidence: 0.9,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: 2,
    contradiction_count: 0,
    superseded_by: null,
    ...overrides
  };
}

function createAnchor(overrides: Partial<ProjectMappingAnchor> = {}): ProjectMappingAnchor {
  return {
    object_id: "mapping-1",
    object_kind: "project_mapping_anchor",
    schema_version: 1,
    lifecycle_state: ObjectLifecycleState.ACTIVE,
    created_at: "2026-03-29T00:00:00.000Z",
    updated_at: "2026-03-29T00:00:00.000Z",
    created_by: "user_action",
    global_object_id: "memory-1",
    project_id: "workspace-1",
    workspace_id: "workspace-1",
    mapping_state: ProjectMappingState.SUGGESTED,
    accepted_by: null,
    last_transition_at: "2026-03-29T00:00:00.000Z",
    ...overrides
  };
}

function createDependencies(
  memories: readonly MemoryEntry[],
  slots: readonly Slot[] = [],
  overrides: Partial<RecallServiceDependencies> = {}
): {
  readonly dependencies: RecallServiceDependencies;
  readonly appendSpy: ReturnType<typeof vi.fn>;
  readonly findByWorkspaceIdSpy: ReturnType<typeof vi.fn>;
} {
  const appendSpy = vi.fn(async (event: Omit<EventLogEntry, "event_id" | "created_at">) => ({
    event_id: `event-${event.event_type}`,
    created_at: "2026-03-29T00:00:00.000Z",
    ...event
  }));
  const findByWorkspaceIdSpy = vi.fn(async () => memories);

  return {
    dependencies: {
      now: () => "2026-03-29T00:00:00.000Z",
      generateRuntimeId: () => "85b3671a-d8d8-4848-9e5c-07d0a89f5ae9",
      memoryRepo: {
        findByWorkspaceId: findByWorkspaceIdSpy,
        findByDimension: vi.fn(async (_workspaceId, dimension) =>
          memories.filter((entry) => entry.dimension === dimension)
        ),
        findByScopeClass: vi.fn(async (_workspaceId, scopeClass) =>
          memories.filter((entry) => entry.scope_class === scopeClass)
        )
      },
      slotRepo: {
        findByWorkspace: vi.fn(async () => slots)
      },
      eventLogRepo: {
        append: appendSpy,
        queryByEntity: vi.fn(async () => [])
      },
      ...overrides
    },
    appendSpy,
    findByWorkspaceIdSpy
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

describe("RecallService global project-mapping filter", () => {
  it("fetches anchors once, excludes rejected globals, and marks suggested plus probationary globals as advisory", async () => {
    const memories = [
      createMemoryEntry({
        object_id: "project-memory",
        scope_class: ScopeClass.PROJECT
      }),
      createMemoryEntry({
        object_id: "global-accepted",
        scope_class: ScopeClass.GLOBAL_DOMAIN
      }),
      createMemoryEntry({
        object_id: "global-adapted",
        scope_class: ScopeClass.GLOBAL_DOMAIN
      }),
      createMemoryEntry({
        object_id: "global-suggested",
        scope_class: ScopeClass.GLOBAL_DOMAIN
      }),
      createMemoryEntry({
        object_id: "global-probationary",
        scope_class: ScopeClass.GLOBAL_DOMAIN
      }),
      createMemoryEntry({
        object_id: "global-rejected",
        scope_class: ScopeClass.GLOBAL_DOMAIN
      })
    ];
    const findByWorkspace = vi.fn(async () => [
      createAnchor({
        object_id: "mapping-accepted",
        global_object_id: "global-accepted",
        mapping_state: ProjectMappingState.ACCEPTED
      }),
      createAnchor({
        object_id: "mapping-adapted",
        global_object_id: "global-adapted",
        mapping_state: ProjectMappingState.ADAPTED
      }),
      createAnchor({
        object_id: "mapping-suggested",
        global_object_id: "global-suggested",
        mapping_state: ProjectMappingState.SUGGESTED
      }),
      createAnchor({
        object_id: "mapping-probationary",
        global_object_id: "global-probationary",
        mapping_state: ProjectMappingState.PROBATIONARY
      }),
      createAnchor({
        object_id: "mapping-rejected",
        global_object_id: "global-rejected",
        mapping_state: ProjectMappingState.REJECTED
      })
    ]);
    const { dependencies } = createDependencies(memories, [], {
      projectMappingPort: {
        findByWorkspace
      }
    });
    const service = new RecallService(dependencies);
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

    expect(findByWorkspace).toHaveBeenCalledTimes(1);
    expect(findByWorkspace).toHaveBeenCalledWith("workspace-1");
    expect(result.candidates.map((candidate) => candidate.object_id).sort()).toEqual([
      "global-accepted",
      "global-adapted",
      "global-probationary",
      "global-suggested",
      "project-memory"
    ]);
    expect(
      result.candidates.find((candidate) => candidate.object_id === "global-accepted")?.is_advisory
    ).toBe(false);
    expect(
      result.candidates.find((candidate) => candidate.object_id === "global-adapted")?.is_advisory
    ).toBe(false);
    expect(
      result.candidates.find((candidate) => candidate.object_id === "global-suggested")?.is_advisory
    ).toBe(true);
    expect(
      result.candidates.find((candidate) => candidate.object_id === "global-probationary")
        ?.is_advisory
    ).toBe(true);
    expect(result.candidates.some((candidate) => candidate.object_id === "global-rejected")).toBe(
      false
    );
    expect(result.candidates.every((candidate) => candidate.origin_plane === "workspace_local")).toBe(
      true
    );
  });

  it("reduces advisory scores by removing scope_match from the base weight", async () => {
    const memories = [
      createMemoryEntry({
        object_id: "global-accepted",
        scope_class: ScopeClass.GLOBAL_DOMAIN,
        activation_score: 0.8
      }),
      createMemoryEntry({
        object_id: "global-suggested",
        scope_class: ScopeClass.GLOBAL_DOMAIN,
        activation_score: 0.8
      })
    ];
    const { dependencies } = createDependencies(memories, [], {
      projectMappingPort: {
        findByWorkspace: vi.fn(async () => [
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
        ])
      }
    });
    const service = new RecallService(dependencies);
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

    const accepted = result.candidates.find((candidate) => candidate.object_id === "global-accepted");
    const advisory = result.candidates.find((candidate) => candidate.object_id === "global-suggested");

    expect(accepted?.relevance_score).toBeGreaterThan(advisory?.relevance_score ?? 0);
    expect((accepted?.relevance_score ?? 0) - (advisory?.relevance_score ?? 0)).toBeCloseTo(0.144);
    expect(accepted?.is_advisory).toBe(false);
    expect(advisory?.is_advisory).toBe(true);
  });

  it("preserves existing behavior when the project mapping port is absent", async () => {
    const memories = [
      createMemoryEntry({
        object_id: "global-unmapped",
        scope_class: ScopeClass.GLOBAL_DOMAIN,
        activation_score: 0.9
      })
    ];
    const { dependencies } = createDependencies(memories);
    const service = new RecallService(dependencies);
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

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].object_id).toBe("global-unmapped");
    expect(result.candidates[0].is_advisory).toBeUndefined();
    expect(result.candidates[0].origin_plane).toBe("workspace_local");
  });

});
