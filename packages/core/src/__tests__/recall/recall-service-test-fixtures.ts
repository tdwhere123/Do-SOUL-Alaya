import { vi } from "vitest";
import {
  ControlPlaneObjectKind,
  MemoryDimension,
  ObjectLifecycleState,
  ProjectMappingState,
  RetentionPolicy,
  ScopeClass,
  type EventLogEntry,
  type MemoryEntry,
  type PathRelation,
  type ProjectMappingAnchor,
  type RecallPolicy,
  type SoulActiveConstraint,
  type Slot,
  type TaskObjectSurface
} from "@do-soul/alaya-protocol";
import type {
  RecallServiceDependencies,
  RecallServiceFieldDeps
} from "../../recall/recall-service.js";
import { createSeededTestOnlyInMemoryFieldQuerySession } from
  "../../recall/runtime/query/field-query-session.js";
import { fieldContractSha256 } from "../../shared/field-hash.js";

export async function createSourceBoundRecallFixture(
  register: (database: import("@do-soul/alaya-storage").StorageDatabase) => void
) {
  const { openSourceSlice, NOW } = await import("./conditional-field/vertical/source-slice.js");
  const { readersFor } = await import("./conditional-field-oracle/bound-producer.js");
  const { RecallService } = await import("../../recall/recall-service.js");
  const { MemoryService } = await import("../../memory/memory-service.js");
  const { createBoundedActiveConstraintsReader } = await import("../../../../../apps/core-daemon/src/runtime/recall-read-worker/active-constraints.js");
  const { SqliteClaimFormRepo } = await import("@do-soul/alaya-storage");
  const slice = await openSourceSlice(register);
  const readConstraints = createBoundedActiveConstraintsReader(slice.database);
  const dependencies: RecallServiceDependencies & RecallServiceFieldDeps = {
    ...createDependencies([]).dependencies,
    now: () => NOW,
    defaultPolicyDecorator: (policy) => policy,
    memoryRepo: slice.storage.memoryEntryRepo,
    eventLogRepo: slice.storage.eventLogRepo,
    observerReaders: readersFor(slice),
    activeConstraintsPort: {
      readBounded: async (request) => readConstraints(request),
      findActiveConstraints: async () => { throw new Error("target fixture must use bounded constraints"); }
    }
  };
  const service = new RecallService(dependencies);
  async function writeSource(input: {
    readonly objectId: string;
    readonly content: string;
    readonly workspaceId?: string;
    readonly dimension?: MemoryEntry["dimension"];
    readonly scopeClass?: MemoryEntry["scope_class"];
    readonly domainTags?: readonly string[];
    readonly createdAt?: string;
  }) {
    const writer = new MemoryService({
      now: () => input.createdAt ?? NOW,
      generateObjectId: () => input.objectId,
      memoryEntryRepo: slice.memoryEntryRepo,
      eventLogRepo: slice.storage.eventLogRepo,
      evidenceService: {
        findById: async (id) => slice.storage.evidenceCapsuleRepo.findById(id),
        findByIds: async (workspaceId, ids) => slice.storage.evidenceCapsuleRepo.findByIds(workspaceId, ids)
      },
      runtimeNotifier: { notifyEntry: async () => {} }
    });
    return writer.create({ created_by: "user_action", dimension: input.dimension ?? MemoryDimension.FACT,
      source_kind: "user", formation_kind: "explicit", scope_class: input.scopeClass ?? ScopeClass.PROJECT,
      content: input.content, domain_tags: input.domainTags ?? [], evidence_refs: [],
      workspace_id: input.workspaceId ?? "workspace-1", run_id: "run-1", surface_id: null });
  }
  return { ...slice, dependencies, service, writeSource, claimFormRepo: new SqliteClaimFormRepo(slice.database) };
}
import { RECALL_FUSION_STREAMS } from "../../recall/delivery/fusion-delivery-streams.js";
import type {
  RecallFusionBreakdown,
  RecallFusionStreamContributions,
  RecallFusionStreamRanks
} from "../../recall/runtime/recall-service-types.js";

export function buildEmptyRecallFusionBreakdown(objectId: string): Readonly<RecallFusionBreakdown> {
  return Object.freeze({
    candidate_key: `workspace_local:memory_entry:${objectId}`,
    object_id: objectId,
    object_kind: "memory_entry",
    origin_plane: "workspace_local",
    per_stream_rank: Object.freeze(Object.fromEntries(
      RECALL_FUSION_STREAMS.map((stream) => [stream, null])
    )) as RecallFusionStreamRanks,
    fused_rank: Number.MAX_SAFE_INTEGER,
    fused_score: 0,
    fused_rank_contribution_per_stream: Object.freeze(Object.fromEntries(
      RECALL_FUSION_STREAMS.map((stream) => [stream, 0])
    )) as RecallFusionStreamContributions
  });
}

export function createTaskSurface(): TaskObjectSurface {
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

export function createPreparedQueryHandle(queryId: string) {
  return {
    queryId,
    // invariant: stubs mirror the cache-miss path so
    // RecallTokenEconomy.embedding_inference_calls reads as 1 when the
    // snapshot is `provider_returned`.
    // see also: packages/core/src/recall/diagnostics.ts:computeRecallTokenEconomy
    cacheHit: false,
    getSnapshot: () =>
      ({
        status: "pending"
      }) as const
  };
}

export function createMemoryEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
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
// see also: packages/core/src/recall/graph-expansion.ts:graphTraversalScoreFromPath
export function createPathRelation(overrides: {
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

export function createActiveConstraint(memory: Readonly<MemoryEntry>): SoulActiveConstraint {
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

export function createSlot(overrides: Partial<Slot> = {}): Slot {
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

export function createAnchor(overrides: Partial<ProjectMappingAnchor> = {}): ProjectMappingAnchor {
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

export function createDependencies(
  memories: readonly MemoryEntry[],
  slots: readonly Slot[] = [],
  // Maps claim object_id -> source_object_refs (backing memory IDs).
  claimSourceRefs: Readonly<Record<string, readonly string[]>> = {},
  activeConstraints: readonly Readonly<SoulActiveConstraint>[] = []
): {
  readonly dependencies: RecallServiceDependencies & RecallServiceFieldDeps;
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
      testOnlyAllowInMemoryFieldQuerySession: true,
      fieldQuerySession: createSeededTestOnlyInMemoryFieldQuerySession(
        fieldContractSha256,
        "workspace-1"
      ),
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
      defaultPolicyDecorator: (policy) => withFineDeliveryPath(policy, "legacy"),
      claimResolverPort: {
        findByIds: vi.fn(async (_workspaceId: string, ids: readonly string[]) =>
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

export function overridePolicy(base: Readonly<RecallPolicy>, patch: Partial<RecallPolicy>): RecallPolicy {
  return {
    ...base,
    ...patch,
    coarse_filter: patch.coarse_filter ?? base.coarse_filter,
    fine_assessment: patch.fine_assessment ?? base.fine_assessment
  };
}

export function withFineDeliveryPath(
  policy: Readonly<RecallPolicy>,
  path: "legacy" | "canonical"
): RecallPolicy {
  if (path === "legacy") {
    process.env.ALAYA_RECALL_ALLOW_LEGACY_DELIVERY = "1";
  }
  return {
    ...policy,
    fine_assessment: {
      ...policy.fine_assessment,
      delivery_path: path
    }
  };
}
