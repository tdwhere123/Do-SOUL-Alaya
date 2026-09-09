import {
  ControlPlaneObjectKind,
  MemoryDimension,
  RetentionPolicy,
  ScopeClass,
  type MemoryEntry,
  type PathRelation,
  type TaskObjectSurface
} from "@do-soul/alaya-protocol";
import type {
  RecallServiceDependencies,
  RecallServiceFieldDeps
} from "../../recall/recall-service.js";

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
    ...createDependencies().dependencies,
    now: () => NOW,
    defaultPolicyDecorator: (policy) => policy,
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
      runtimeNotifier: { notifyEntry: async () => { } }
    });
    return writer.create({
      created_by: "user_action", dimension: input.dimension ?? MemoryDimension.FACT,
      source_kind: "user", formation_kind: "explicit", scope_class: input.scopeClass ?? ScopeClass.PROJECT,
      content: input.content, domain_tags: input.domainTags ?? [], evidence_refs: [],
      workspace_id: input.workspaceId ?? "workspace-1", run_id: "run-1", surface_id: null
    });
  }
  return { ...slice, dependencies, service, writeSource, claimFormRepo: new SqliteClaimFormRepo(slice.database) };
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

export function createDependencies(): {
  readonly dependencies: RecallServiceDependencies & RecallServiceFieldDeps;
} {
  return {
    dependencies: {
      now: () => "2026-03-23T00:00:00.000Z",
      generateRuntimeId: () => "85b3671a-d8d8-4848-9e5c-07d0a89f5ae9"
    }
  };
}
