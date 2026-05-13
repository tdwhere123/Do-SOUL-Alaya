import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ControlPlaneObjectKind,
  FormationKind,
  MemoryDimension,
  MemoryGraphEdgeType,
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
  SqliteMemoryGraphEdgeRepo,
  SqliteRunRepo,
  SqliteWorkspaceRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { RunMode, RunState, WorkspaceKind, WorkspaceState } from "@do-soul/alaya-protocol";
import { RecallService, type RecallServiceDependencies } from "../recall-service.js";

// Recall scoring must read per-memory inbound graph edges from SQLite, not
// from a constant or process-local cache.

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

describe("RecallService end-to-end with real memory_graph_edges", () => {
  it("lifts score_factors.graph_support above 0 when inbound RECALLS edges exist", async () => {
    const { database, memoryEntryRepo, graphEdgeRepo } = await createRealStorage();

    // Seed: 2 memories that the recall keyword should pick up.
    await memoryEntryRepo.create(
      createMemoryEntry({
        object_id: MEM_TARGET,
        content: "Use rtk pnpm for repo commands.",
        domain_tags: ["repo"]
      })
    );
    await memoryEntryRepo.create(
      createMemoryEntry({
        object_id: MEM_ISOLATED,
        content: "Use rtk pnpm for repo commands.",
        domain_tags: ["repo"]
      })
    );
    // Edge sources (don't need to be in recall candidates themselves).
    await memoryEntryRepo.create(
      createMemoryEntry({
        object_id: MEM_SRC_A,
        content: "Earlier recall hit anchor",
        domain_tags: ["history"]
      })
    );
    await memoryEntryRepo.create(
      createMemoryEntry({
        object_id: MEM_SRC_B,
        content: "Earlier recall hit anchor",
        domain_tags: ["history"]
      })
    );

    // 2 inbound RECALLS edges to MEM_TARGET → weighted sum = 0.6;
    // normalize at /3 → graph_support factor 0.2.
    await graphEdgeRepo.create({
      edge_id: "edge-recalls-1",
      source_memory_id: MEM_SRC_A,
      target_memory_id: MEM_TARGET,
      edge_type: MemoryGraphEdgeType.RECALLS,
      workspace_id: "workspace-1",
      created_at: "2026-05-13T00:00:00.000Z"
    });
    await graphEdgeRepo.create({
      edge_id: "edge-recalls-2",
      source_memory_id: MEM_SRC_B,
      target_memory_id: MEM_TARGET,
      edge_type: MemoryGraphEdgeType.RECALLS,
      workspace_id: "workspace-1",
      created_at: "2026-05-13T00:00:01.000Z"
    });
    // MEM_ISOLATED has 0 inbound edges → its graph_support stays 0.

    const service = createServiceWithRealGraphSupport({
      memories: await memoryEntryRepo.findByWorkspaceId("workspace-1", StorageTier.HOT),
      graphEdgeRepo
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

    // The headline acceptance: graph_support is non-zero for the memory
    // that has inbound RECALLS edges in the real storage path.
    expect(targetCandidate?.score_factors?.graph_support).toBeGreaterThan(0);

    // And remains 0 for a sibling memory with no inbound edges — proving
    // the value came through the per-memory query, not a constant.
    expect(isolatedCandidate?.score_factors?.graph_support ?? 0).toBe(0);

    database.close();
    databases.delete(database);
  });

  it("supersedes inbound edges count as negative weight but clamp to 0 (documented limitation)", async () => {
    const { database, memoryEntryRepo, graphEdgeRepo } = await createRealStorage();

    await memoryEntryRepo.create(
      createMemoryEntry({
        object_id: MEM_TARGET,
        content: "Old preference superseded.",
        domain_tags: ["repo"]
      })
    );
    await memoryEntryRepo.create(
      createMemoryEntry({
        object_id: MEM_SRC_A,
        content: "Newer preference",
        domain_tags: ["repo"]
      })
    );

    // One supersedes edge: weight = -0.5; normalizeGraphSupport clamps to 0
    // (the documented floor-at-zero limitation).
    await graphEdgeRepo.create({
      edge_id: "edge-sup-1",
      source_memory_id: MEM_SRC_A,
      target_memory_id: MEM_TARGET,
      edge_type: MemoryGraphEdgeType.SUPERSEDES,
      workspace_id: "workspace-1",
      created_at: "2026-05-13T00:00:00.000Z"
    });

    const service = createServiceWithRealGraphSupport({
      memories: await memoryEntryRepo.findByWorkspaceId("workspace-1", StorageTier.HOT),
      graphEdgeRepo
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
  const graphEdgeRepo = new SqliteMemoryGraphEdgeRepo(database);

  // FK seed: memory_graph_edges references workspaces; memories reference runs.
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

  return { database, memoryEntryRepo, graphEdgeRepo };
}

function createServiceWithRealGraphSupport(input: {
  readonly memories: readonly Readonly<MemoryEntry>[];
  readonly graphEdgeRepo: SqliteMemoryGraphEdgeRepo;
}): RecallService {
  const { memories, graphEdgeRepo } = input;
  const append = vi.fn(
    async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">): Promise<EventLogEntry> => ({
      event_id: `event-${entry.event_type}`,
      created_at: "2026-05-13T00:00:00.000Z",
      revision: 0,
      ...entry
    })
  );

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
    // The real wiring under test: countInboundEdgesWeighted goes through
    // the actual SqliteMemoryGraphEdgeRepo SQL aggregation, not a mock.
    graphSupportPort: {
      countInboundSupports: graphEdgeRepo.countInboundSupports.bind(graphEdgeRepo),
      countInboundEdgesWeighted: graphEdgeRepo.countInboundEdgesWeighted.bind(graphEdgeRepo)
    }
  };

  return new RecallService(deps);
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
