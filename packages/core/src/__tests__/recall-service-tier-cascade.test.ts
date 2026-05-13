import { describe, expect, it, vi } from "vitest";
import {
  ControlPlaneObjectKind,
  MemoryDimension,
  ObjectLifecycleState,
  ProjectMappingState,
  RetentionPolicy,
  ScopeClass,
  StorageTier,
  type EventLogEntry,
  type MemoryEntry,
  type ProjectMappingAnchor,
  type RecallPolicy,
  type Slot,
  type TaskObjectSurface
} from "@do-soul/alaya-protocol";
import {
  COLD_CASCADE_DECAY,
  MIN_RECALL_RESULTS,
  WARM_CASCADE_DECAY
} from "../recall-service-helpers.js";
import { RecallService, type RecallServiceDependencies } from "../recall-service.js";

function createTaskSurface(): TaskObjectSurface {
  return {
    runtime_id: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
    object_kind: ControlPlaneObjectKind.TASK_OBJECT_SURFACE,
    task_surface_ref: null,
    expires_at: "2026-05-07T00:30:00.000Z",
    derived_from: null,
    retention_policy: RetentionPolicy.SESSION_ONLY,
    surface_kind: "chat",
    display_name: "deployment rules",
    context_refs: []
  };
}

function createMemoryEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    object_id: "memory-1",
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: ObjectLifecycleState.ACTIVE,
    created_at: "2026-05-07T00:00:00.000Z",
    updated_at: "2026-05-07T00:00:00.000Z",
    created_by: "system",
    dimension: MemoryDimension.PROCEDURE,
    source_kind: "user",
    formation_kind: "explicit",
    scope_class: ScopeClass.PROJECT,
    content: "Remember deployment rules for this repository.",
    domain_tags: ["deployment"],
    evidence_refs: [],
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    storage_tier: StorageTier.HOT,
    activation_score: 0.8,
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

function createAnchor(overrides: Partial<ProjectMappingAnchor> = {}): ProjectMappingAnchor {
  return {
    object_id: "mapping-1",
    object_kind: "project_mapping_anchor",
    schema_version: 1,
    lifecycle_state: ObjectLifecycleState.ACTIVE,
    created_at: "2026-05-07T00:00:00.000Z",
    updated_at: "2026-05-07T00:00:00.000Z",
    created_by: "user_action",
    global_object_id: "memory-1",
    project_id: "workspace-1",
    workspace_id: "workspace-1",
    mapping_state: ProjectMappingState.SUGGESTED,
    accepted_by: null,
    last_transition_at: "2026-05-07T00:00:00.000Z",
    ...overrides
  };
}

function createDependencies(params: {
  readonly hot?: readonly MemoryEntry[];
  readonly warm?: readonly MemoryEntry[];
  readonly cold?: readonly MemoryEntry[];
  readonly slots?: readonly Slot[];
  readonly projectMappings?: readonly ProjectMappingAnchor[];
  readonly graphSupportPort?: RecallServiceDependencies["graphSupportPort"];
} = {}): {
  readonly dependencies: RecallServiceDependencies;
  readonly findByWorkspaceIdSpy: ReturnType<typeof vi.fn>;
} {
  const byTier = new Map<StorageTier, readonly MemoryEntry[]>([
    [StorageTier.HOT, params.hot ?? []],
    [StorageTier.WARM, params.warm ?? []],
    [StorageTier.COLD, params.cold ?? []]
  ]);
  const findByWorkspaceIdSpy = vi.fn(async (_workspaceId: string, tier?: StorageTier) => {
    return byTier.get(tier ?? StorageTier.HOT) ?? [];
  });

  return {
    dependencies: {
      now: () => "2026-05-07T00:00:00.000Z",
      generateRuntimeId: () => "85b3671a-d8d8-4848-9e5c-07d0a89f5ae9",
      memoryRepo: {
        findByWorkspaceId: findByWorkspaceIdSpy,
        findByDimension: vi.fn(async () => []),
        findByScopeClass: vi.fn(async () => [])
      },
      slotRepo: {
        findByWorkspace: vi.fn(async () => params.slots ?? [])
      },
      eventLogRepo: {
        append: vi.fn(async (event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => ({
          event_id: `event-${event.event_type}`,
          created_at: "2026-05-07T00:00:00.000Z",
          revision: 0,
          ...event
        })),
        queryByEntity: vi.fn(async () => [])
      },
      graphSupportPort: params.graphSupportPort,
      projectMappingPort: {
        findByWorkspace: vi.fn(async () => params.projectMappings ?? [])
      }
    },
    findByWorkspaceIdSpy
  };
}

function buildPolicy(service: RecallService, maxEntries = 10): RecallPolicy {
  const basePolicy = service.buildDefaultPolicy("chat", createTaskSurface().runtime_id);
  return {
    ...basePolicy,
    coarse_filter: {
      ...basePolicy.coarse_filter,
      deterministic_match: {
        scope_filter: null,
        dimension_filter: null,
        domain_tag_filter: null
      },
      precomputed_rank: {
        max_candidates: 50,
        min_activation_score: null
      },
      semantic_supplement: {
        enabled: false,
        max_supplement: 0
      }
    },
    fine_assessment: {
      conflict_awareness: false,
      budgets: {
        max_entries: maxEntries,
        max_total_tokens: 10_000,
        per_dimension_limits: null
      }
    }
  };
}

async function recallWith(params: Parameters<typeof createDependencies>[0], maxEntries = 10) {
  const { dependencies, findByWorkspaceIdSpy } = createDependencies(params);
  const service = new RecallService(dependencies);
  const result = await service.recall({
    taskSurface: createTaskSurface(),
    workspaceId: "workspace-1",
    strategy: "chat",
    policyOverride: buildPolicy(service, maxEntries)
  });
  return { result, findByWorkspaceIdSpy };
}

describe("RecallService tier cascade", () => {
  it("keeps the HOT-only fast path output identical when HOT reaches threshold", async () => {
    const hot = Array.from({ length: MIN_RECALL_RESULTS }, (_, index) =>
      createMemoryEntry({
        object_id: `hot-${index}`,
        activation_score: 0.9 - index * 0.01,
        storage_tier: StorageTier.HOT
      })
    );

    const graphSupportSpy = vi.fn(async () => 0);
    const control = await recallWith({ hot });
    const cascade = await recallWith({
      hot,
      warm: [createMemoryEntry({ object_id: "warm-unused", storage_tier: StorageTier.WARM })],
      cold: [createMemoryEntry({ object_id: "cold-unused", storage_tier: StorageTier.COLD })],
      graphSupportPort: {
        countInboundSupports: graphSupportSpy,
        countInboundEdgesWeighted: graphSupportSpy
      }
    });

    expect(cascade.findByWorkspaceIdSpy).toHaveBeenCalledTimes(1);
    expect(cascade.findByWorkspaceIdSpy).toHaveBeenCalledWith("workspace-1", StorageTier.HOT);
    expect(graphSupportSpy).toHaveBeenCalledTimes(MIN_RECALL_RESULTS);
    expect(cascade.result).toEqual(control.result);
    expect(cascade.result.degradation_reason).toBeNull();
    expect(cascade.result.candidates.flatMap((candidate) => candidate.source_channels ?? [])).not.toContain("warm_cascade");
    expect(cascade.result.candidates.flatMap((candidate) => candidate.source_channels ?? [])).not.toContain("cold_cascade");
  });

  it("uses WARM once when HOT is empty and decays delivered relevance", async () => {
    const baseline = await recallWith({
      hot: [createMemoryEntry({ object_id: "candidate-0", activation_score: 0.8 })]
    });
    // Reviewer-final F2: assert collectSupplementaryData runs exactly
    // once on the cascade path. Pre-fix (M5 only), the HOT-only assess
    // would have called the spy MIN_RECALL_RESULTS times, then the
    // cascade-merged assess would have called it again — totalling
    // 2 × MIN_RECALL_RESULTS calls. After the I2 fix, the HOT-only
    // assess is gone and the spy is called exactly once per candidate
    // on the final merged filter.
    const cascadeGraphSpy = vi.fn(async () => 0);
    const warm = await recallWith({
      warm: Array.from({ length: 3 }, (_, index) =>
        createMemoryEntry({
          object_id: `candidate-${index}`,
          storage_tier: StorageTier.WARM,
          activation_score: 0.8
        })
      ),
      graphSupportPort: {
        countInboundSupports: cascadeGraphSpy,
        countInboundEdgesWeighted: cascadeGraphSpy
      }
    }, 3);

    expect(warm.findByWorkspaceIdSpy).toHaveBeenCalledTimes(2);
    expect(warm.findByWorkspaceIdSpy).toHaveBeenNthCalledWith(1, "workspace-1", StorageTier.HOT);
    expect(warm.findByWorkspaceIdSpy).toHaveBeenNthCalledWith(2, "workspace-1", StorageTier.WARM);
    // 3 WARM candidates merged through the final assess, no HOT-only assess.
    expect(cascadeGraphSpy).toHaveBeenCalledTimes(3);
    expect(warm.result.degradation_reason).toBe("warm_cascade_engaged");
    expect(warm.result.candidates).toHaveLength(3);
    const candidate = warm.result.candidates.find((entry) => entry.object_id === "candidate-0");
    expect(candidate?.source_channels).toContain("warm_cascade");
    expect(candidate?.relevance_score).toBeCloseTo(
      (baseline.result.candidates[0]?.relevance_score ?? 0) * WARM_CASCADE_DECAY
    );
  });

  it("uses COLD when HOT and WARM are empty and decays delivered relevance", async () => {
    const baseline = await recallWith({
      hot: [createMemoryEntry({ object_id: "candidate", activation_score: 0.8 })]
    });
    const cold = await recallWith({
      cold: [
        createMemoryEntry({
          object_id: "candidate",
          storage_tier: StorageTier.COLD,
          activation_score: 0.8
        })
      ]
    });

    expect(cold.findByWorkspaceIdSpy).toHaveBeenCalledTimes(3);
    expect(cold.findByWorkspaceIdSpy).toHaveBeenNthCalledWith(3, "workspace-1", StorageTier.COLD);
    expect(cold.result.degradation_reason).toBe("cold_cascade_engaged");
    expect(cold.result.candidates).toHaveLength(1);
    expect(cold.result.candidates[0]?.source_channels).toContain("cold_cascade");
    expect(cold.result.candidates[0]?.relevance_score).toBeCloseTo(
      (baseline.result.candidates[0]?.relevance_score ?? 0) * COLD_CASCADE_DECAY
    );
  });

  it("does not touch COLD when HOT plus WARM reaches the threshold", async () => {
    const hot = Array.from({ length: 2 }, (_, index) =>
      createMemoryEntry({ object_id: `hot-${index}`, activation_score: 0.9 - index * 0.01 })
    );
    const warm = Array.from({ length: 4 }, (_, index) =>
      createMemoryEntry({
        object_id: `warm-${index}`,
        storage_tier: StorageTier.WARM,
        activation_score: 0.8 - index * 0.01
      })
    );

    const { result, findByWorkspaceIdSpy } = await recallWith({
      hot,
      warm,
      cold: Array.from({ length: 10 }, (_, index) =>
        createMemoryEntry({ object_id: `cold-${index}`, storage_tier: StorageTier.COLD })
      )
    });

    expect(findByWorkspaceIdSpy).toHaveBeenCalledTimes(2);
    expect(findByWorkspaceIdSpy).not.toHaveBeenCalledWith("workspace-1", StorageTier.COLD);
    expect(result.degradation_reason).toBe("warm_cascade_engaged");
    expect(result.candidates).toHaveLength(6);
  });

  it("keeps protected WARM constraints included when HOT is empty", async () => {
    const { result } = await recallWith({
      warm: [
        createMemoryEntry({
          object_id: "warm-constraint",
          storage_tier: StorageTier.WARM,
          dimension: MemoryDimension.CONSTRAINT,
          activation_score: 0.01
        })
      ]
    });

    expect(result.candidates.map((candidate) => candidate.object_id)).toContain("warm-constraint");
    expect(result.candidates.find((candidate) => candidate.object_id === "warm-constraint")?.source_channels).toContain("warm_cascade");
  });

  it("keeps cascade results inside max_entries budget", async () => {
    const { result } = await recallWith({
      warm: Array.from({ length: 10 }, (_, index) =>
        createMemoryEntry({
          object_id: `warm-${index}`,
          storage_tier: StorageTier.WARM,
          activation_score: 0.9 - index * 0.01
        })
      )
    }, 3);

    expect(result.candidates).toHaveLength(3);
    expect(result.candidates.every((candidate) => candidate.source_channels?.includes("warm_cascade"))).toBe(true);
  });

  it("applies project-mapping exclusions to cascaded non-project entries", async () => {
    const { result } = await recallWith({
      warm: [
        createMemoryEntry({
          object_id: "global-rejected",
          storage_tier: StorageTier.WARM,
          scope_class: ScopeClass.GLOBAL_DOMAIN,
          activation_score: 0.9
        }),
        createMemoryEntry({
          object_id: "project-warm",
          storage_tier: StorageTier.WARM,
          activation_score: 0.8
        })
      ],
      projectMappings: [
        createAnchor({
          object_id: "mapping-rejected",
          global_object_id: "global-rejected",
          mapping_state: ProjectMappingState.REJECTED
        })
      ]
    });

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual(["project-warm"]);
  });
});
