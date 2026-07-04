import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ControlPlaneObjectKind,
  FormationKind,
  MemoryDimension,
  RetentionPolicy,
  ScopeClass,
  SourceKind,
  StorageTier,
  type EventLogEntry,
  type MemoryEntry,
  type TaskObjectSurface
} from "@do-soul/alaya-protocol";
import {
  initDatabase,
  SqliteMemoryEntryRepo,
  SqlitePathRelationRepo,
  SqliteRunRepo,
  SqliteWorkspaceRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import {
  RunMode,
  RunState,
  WorkspaceKind,
  WorkspaceState,
  type PathRelation
} from "@do-soul/alaya-protocol";
import { GraphExploreService } from "../../path-graph/path-relations/graph-explore-service.js";
import { RecallService, type RecallServiceDependencies } from "../../recall/recall-service.js";

// Recall scoring must read per-memory inbound graph support from SQLite (the
// unified path plane), not from a constant or process-local cache.

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }
  databases.clear();
});

const MEM_TARGET = "00000000-0000-4000-8000-000000000001";
const MEM_SRC_A = "00000000-0000-4000-8000-000000000002";
const MEM_SRC_B = "00000000-0000-4000-8000-000000000003";
const MEM_ISOLATED = "00000000-0000-4000-8000-000000000004";

// graph_support is fed by GraphExploreService.countInbound* which now read the
// unified path plane (path_relations), not memory_graph_edges. This proves the
// recall-service wiring is alive on the path plane and survives the edge-table
// retirement. see also: packages/core/src/path-graph/graph-explore-service.ts.
describe("RecallService end-to-end with path-plane graph_support", () => {
  it("lifts score_factors.graph_support above 0 from inbound recall-eligible paths", async () => {
    const { database, memoryEntryRepo, pathRelationRepo } = await createRealStorage();

    await memoryEntryRepo.create(
      createMemoryEntry({ object_id: MEM_TARGET, content: "Use rtk pnpm for repo commands.", domain_tags: ["repo"] })
    );
    await memoryEntryRepo.create(
      createMemoryEntry({ object_id: MEM_ISOLATED, content: "Use rtk pnpm for repo commands.", domain_tags: ["repo"] })
    );

    // Two inbound recall-eligible recalls paths into MEM_TARGET: weighted sum
    // = 0.3 + 0.3 = 0.6; normalize at /3 → graph_support factor 0.2.
    pathRelationRepo.create(
      createPathFixture({ pathId: "path-recalls-1", sourceMemoryId: MEM_SRC_A, targetMemoryId: MEM_TARGET, relationKind: "recalls" })
    );
    pathRelationRepo.create(
      createPathFixture({ pathId: "path-recalls-2", sourceMemoryId: MEM_SRC_B, targetMemoryId: MEM_TARGET, relationKind: "recalls" })
    );
    // MEM_ISOLATED has no inbound paths → graph_support stays 0.

    const service = createServiceWithPathGraphSupport({
      memories: await memoryEntryRepo.findByWorkspaceId("workspace-1", StorageTier.HOT),
      pathRelationRepo
    });

    const result = await service.recall({
      taskSurface: createTaskSurface("rtk pnpm commands"),
      workspaceId: "workspace-1",
      runId: "run-1",
      strategy: "build"
    });

    const targetCandidate = result.candidates.find((c) => c.object_id === MEM_TARGET);
    const isolatedCandidate = result.candidates.find((c) => c.object_id === MEM_ISOLATED);

    expect(targetCandidate, "target memory should be among recall candidates").toBeDefined();
    expect(isolatedCandidate, "isolated memory should also be among recall candidates").toBeDefined();
    expect(targetCandidate?.score_factors?.graph_support).toBeGreaterThan(0);
    expect(isolatedCandidate?.score_factors?.graph_support ?? 0).toBe(0);

    database.close();
    databases.delete(database);
  });

  it("excludes active negative inbound paths from graph_support (positive-only)", async () => {
    const { database, memoryEntryRepo, pathRelationRepo } = await createRealStorage();

    await memoryEntryRepo.create(
      createMemoryEntry({ object_id: MEM_TARGET, content: "Old preference superseded.", domain_tags: ["repo"] })
    );

    // A single active negative (supersedes, recall_bias < 0) inbound path is
    // NOT counted; graph_support stays at the positive-only baseline of 0.
    pathRelationRepo.create(
      createPathFixture({
        pathId: "path-supersedes-1",
        sourceMemoryId: MEM_SRC_A,
        targetMemoryId: MEM_TARGET,
        relationKind: "supersedes",
        recallBias: -0.5
      })
    );

    const service = createServiceWithPathGraphSupport({
      memories: await memoryEntryRepo.findByWorkspaceId("workspace-1", StorageTier.HOT),
      pathRelationRepo
    });

    const result = await service.recall({
      taskSurface: createTaskSurface("preference"),
      workspaceId: "workspace-1",
      runId: "run-1",
      strategy: "build"
    });

    const targetCandidate = result.candidates.find((c) => c.object_id === MEM_TARGET);
    expect(targetCandidate?.score_factors?.graph_support ?? -1).toBe(0);

    database.close();
    databases.delete(database);
  });
});

async function createRealStorage() {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);
  const workspaceRepo = new SqliteWorkspaceRepo(database);
  const runRepo = new SqliteRunRepo(database);
  const memoryEntryRepo = new SqliteMemoryEntryRepo(database);
  const pathRelationRepo = new SqlitePathRelationRepo(database);

  // FK seed: path_relations references workspaces; memories reference runs.
  await workspaceRepo.create({
    workspace_id: "workspace-1",
    name: "workspace one",
    root_path: "/tmp/ws1",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    workspace_state: WorkspaceState.ACTIVE
  });
  await runRepo.create({
    run_id: "run-1",
    workspace_id: "workspace-1",
    title: "run one",
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: null
  });

  return { database, memoryEntryRepo, pathRelationRepo };
}

function createServiceWithPathGraphSupport(input: {
  readonly memories: readonly Readonly<MemoryEntry>[];
  readonly pathRelationRepo: SqlitePathRelationRepo;
}): RecallService {
  const { memories, pathRelationRepo } = input;
  const append = vi.fn(
    async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">): Promise<EventLogEntry> => ({
      event_id: `event-${entry.event_type}`,
      created_at: "2026-05-13T00:00:00.000Z",
      revision: 0,
      ...entry
    })
  );

  // The real wiring under test: graphSupportPort -> GraphExploreService ->
  // SqlitePathRelationRepo.findByTargetAnchor (the path plane). The service is
  // path-only.
  const graphExploreService = new GraphExploreService({
    pathRepo: pathRelationRepo,
    eventLogRepo: { append }
  });

  const deps: RecallServiceDependencies = {
    now: () => "2026-05-13T00:00:00.000Z",
    generateRuntimeId: () => "85b3671a-d8d8-4848-9e5c-07d0a89f5ae9",
    memoryRepo: {
      findByWorkspaceId: vi.fn(async () => memories),
      findByDimension: vi.fn(async () => memories),
      findByScopeClass: vi.fn(async () => memories),
      searchByKeyword: vi.fn(async () =>
        memories.map((m) => ({ object_id: m.object_id, normalized_rank: 1 }))
      )
    } as RecallServiceDependencies["memoryRepo"],
    slotRepo: {
      findByWorkspace: vi.fn(async () => [])
    },
    eventLogRepo: {
      append,
      queryByEntity: vi.fn(async () => [])
    },
    graphSupportPort: {
      countInboundSupports: graphExploreService.countInboundSupports.bind(graphExploreService),
      countInboundEdgesWeighted: graphExploreService.countInboundEdgesWeighted.bind(graphExploreService),
      countInboundRecalls: graphExploreService.countInboundRecalls.bind(graphExploreService)
    }
  };

  return new RecallService(deps);
}

function createPathFixture(overrides: {
  readonly pathId: string;
  readonly sourceMemoryId: string;
  readonly targetMemoryId: string;
  readonly relationKind: string;
  readonly recallBias?: number;
}): PathRelation {
  return {
    path_id: overrides.pathId,
    workspace_id: "workspace-1",
    anchors: {
      source_anchor: { kind: "object", object_id: overrides.sourceMemoryId },
      target_anchor: { kind: "object", object_id: overrides.targetMemoryId }
    },
    constitution: {
      relation_kind: overrides.relationKind,
      why_this_relation_exists: ["test_evidence"]
    },
    effect_vector: {
      salience: 0.5,
      recall_bias: overrides.recallBias ?? 0.5,
      verification_bias: 0,
      unfinishedness_bias: 0,
      default_manifestation_preference: "lens_entry"
    },
    plasticity_state: {
      strength: 0.5,
      direction_bias: "bidirectional_asymmetric",
      stability_class: "stable",
      support_events_count: 1,
      contradiction_events_count: 0
    },
    lifecycle: {
      status: "active",
      retirement_rule: "manual"
    },
    legitimacy: {
      evidence_basis: ["test_evidence"],
      governance_class: "recall_allowed"
    },
    created_at: "2026-05-13T00:00:00.000Z",
    updated_at: "2026-05-13T00:00:00.000Z"
  };
}

function createTaskSurface(displayName: string): TaskObjectSurface {
  return {
    runtime_id: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
    object_kind: ControlPlaneObjectKind.TASK_OBJECT_SURFACE,
    task_surface_ref: null,
    expires_at: "2026-05-13T00:30:00.000Z",
    derived_from: null,
    retention_policy: RetentionPolicy.SESSION_ONLY,
    surface_kind: "build",
    display_name: displayName,
    context_refs: []
  };
}

function createMemoryEntry(overrides: Partial<MemoryEntry>): MemoryEntry {
  return {
    object_id: "memory-default",
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-05-13T00:00:00.000Z",
    updated_at: "2026-05-13T00:00:00.000Z",
    created_by: "recall-with-edges-test",
    dimension: MemoryDimension.PROCEDURE,
    source_kind: SourceKind.USER,
    formation_kind: FormationKind.EXPLICIT,
    scope_class: ScopeClass.PROJECT,
    content: "default content",
    domain_tags: ["repo"],
    evidence_refs: [],
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    storage_tier: StorageTier.HOT,
    activation_score: 0.7,
    retention_score: 0.8,
    manifestation_state: "full_eligible",
    retention_state: "consolidated",
    decay_profile: "stable",
    confidence: 0.9,
    last_used_at: "2026-05-12T00:00:00.000Z",
    last_hit_at: "2026-05-12T00:00:00.000Z",
    reinforcement_count: 0,
    contradiction_count: 0,
    superseded_by: null,
    ...overrides
  };
}
