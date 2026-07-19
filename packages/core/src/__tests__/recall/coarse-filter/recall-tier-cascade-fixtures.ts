import { vi } from "vitest";
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
import { RecallService, type RecallServiceDependencies } from
  "../../../recall/recall-service.js";

type TierCascadeFixtureParams = Readonly<{
  readonly hot?: readonly MemoryEntry[];
  readonly warm?: readonly MemoryEntry[];
  readonly cold?: readonly MemoryEntry[];
  readonly slots?: readonly Slot[];
  readonly projectMappings?: readonly ProjectMappingAnchor[];
  readonly graphSupportPort?: RecallServiceDependencies["graphSupportPort"];
  readonly findByWorkspaceId?: RecallServiceDependencies["memoryRepo"]["findByWorkspaceId"];
  readonly findRecallTierWindow?: NonNullable<
    RecallServiceDependencies["memoryRepo"]["findRecallTierWindow"]
  >;
  readonly warn?: RecallServiceDependencies["warn"];
}>;

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

export function createMemoryEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
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

export function createAnchor(
  overrides: Partial<ProjectMappingAnchor> = {}
): ProjectMappingAnchor {
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

function createDependencies(params: TierCascadeFixtureParams = {}): {
  readonly dependencies: RecallServiceDependencies;
  readonly findByWorkspaceIdSpy: ReturnType<typeof vi.fn>;
  readonly warnSpy: ReturnType<typeof vi.fn>;
} {
  const findByWorkspaceIdSpy = vi.fn(
    params.findByWorkspaceId ?? createDefaultFindByWorkspaceId(params)
  );
  const warnSpy = vi.fn(params.warn ?? (() => undefined));
  return {
    dependencies: {
      now: () => "2026-05-07T00:00:00.000Z",
      generateRuntimeId: () => "85b3671a-d8d8-4848-9e5c-07d0a89f5ae9",
      memoryRepo: createMemoryRepo(params, findByWorkspaceIdSpy),
      warn: warnSpy,
      slotRepo: { findByWorkspace: vi.fn(async () => params.slots ?? []) },
      eventLogRepo: createEventLogRepo(),
      graphSupportPort: params.graphSupportPort,
      projectMappingPort: {
        findByWorkspace: vi.fn(async () => params.projectMappings ?? [])
      }
    },
    findByWorkspaceIdSpy,
    warnSpy
  };
}

function createDefaultFindByWorkspaceId(
  params: TierCascadeFixtureParams
): RecallServiceDependencies["memoryRepo"]["findByWorkspaceId"] {
  const byTier = new Map<StorageTier, readonly MemoryEntry[]>([
    [StorageTier.HOT, params.hot ?? []],
    [StorageTier.WARM, params.warm ?? []],
    [StorageTier.COLD, params.cold ?? []]
  ]);
  return async (
    _workspaceId: string,
    tier?: StorageTier,
    page?: { readonly limit: number; readonly offset: number }
  ) => {
    const entries = byTier.get(tier ?? StorageTier.HOT) ?? [];
    return page === undefined
      ? entries
      : entries.slice(page.offset, page.offset + page.limit);
  };
}

function createMemoryRepo(
  params: TierCascadeFixtureParams,
  findByWorkspaceId: RecallServiceDependencies["memoryRepo"]["findByWorkspaceId"]
): RecallServiceDependencies["memoryRepo"] {
  return {
    findByWorkspaceId,
    ...(params.findRecallTierWindow === undefined
      ? {}
      : { findRecallTierWindow: vi.fn(params.findRecallTierWindow) }),
    findByDimension: vi.fn(async () => []),
    findByScopeClass: vi.fn(async () => [])
  };
}

function createEventLogRepo(): RecallServiceDependencies["eventLogRepo"] {
  return {
    append: vi.fn(async (
      event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">
    ) => ({
      event_id: `event-${event.event_type}`,
      created_at: "2026-05-07T00:00:00.000Z",
      revision: 0,
      ...event
    })),
    queryByEntity: vi.fn(async () => [])
  };
}

function buildPolicy(service: RecallService, maxEntries: number): RecallPolicy {
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

export async function recallWith(
  params: TierCascadeFixtureParams,
  maxEntries = 10
) {
  const { dependencies, findByWorkspaceIdSpy, warnSpy } = createDependencies(params);
  const service = new RecallService(dependencies);
  const result = await service.recall({
    taskSurface: createTaskSurface(),
    workspaceId: "workspace-1",
    strategy: "chat",
    policyOverride: buildPolicy(service, maxEntries)
  });
  return { result, findByWorkspaceIdSpy, warnSpy };
}
