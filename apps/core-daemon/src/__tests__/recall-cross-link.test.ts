import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EventPublisher,
  GraphExploreService,
  MemoryService,
  RecallService,
  type RecallServiceDependencies,
  type RuntimeNotifier
} from "@do-soul/alaya-core";
import {
  ControlPlaneObjectKind,
  FormationKind,
  MemoryDimension,
  RetentionPolicy,
  RunMode,
  RunState,
  ScopeClass,
  SourceKind,
  StorageTier,
  WorkspaceKind,
  WorkspaceState,
  type MemoryEntry,
  type TaskObjectSurface
} from "@do-soul/alaya-protocol";
import {
  initDatabase,
  SqliteEventLogRepo,
  SqliteMemoryEntryRepo,
  SqliteMemoryGraphEdgeRepo,
  SqliteRunRepo,
  SqliteTrustStateRepo,
  SqliteWorkspaceRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { createMcpMemoryToolHandler } from "../mcp-memory-tool-handler.js";
import { createTrustStateRecorder } from "../trust-state.js";

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }
  databases.clear();
});

const MEM_A = "11111111-aaaa-4aaa-8aaa-000000000001";
const MEM_B = "11111111-aaaa-4aaa-8aaa-000000000002";
const MEM_C = "11111111-aaaa-4aaa-8aaa-000000000003";

describe("recall cross-link: report_context_usage(used) writes RECALLS edges", () => {
  it("writes one RECALLS edge per ordered pair when 2 memories are reported used", async () => {
    const harness = await createHarness([MEM_A, MEM_B]);

    await reportUsed(harness, [MEM_A, MEM_B]);

    // 2 memories → 2 ordered pairs (A→B, B→A); each edge fire-and-forget.
    expect(harness.graphEdgePort.createEdge).toHaveBeenCalledTimes(2);
    const pairs = harness.graphEdgePort.createEdge.mock.calls.map((call) => ({
      source: call[0].sourceMemoryId,
      target: call[0].targetMemoryId,
      edgeType: call[0].edgeType
    }));
    expect(pairs).toEqual(
      expect.arrayContaining([
        { source: MEM_A, target: MEM_B, edgeType: "recalls" },
        { source: MEM_B, target: MEM_A, edgeType: "recalls" }
      ])
    );
  });

  it("writes N*(N-1) RECALLS edges for 3 used memories", async () => {
    const harness = await createHarness([MEM_A, MEM_B, MEM_C]);

    await reportUsed(harness, [MEM_A, MEM_B, MEM_C]);

    expect(harness.graphEdgePort.createEdge).toHaveBeenCalledTimes(6);
    for (const call of harness.graphEdgePort.createEdge.mock.calls) {
      expect(call[0].edgeType).toBe("recalls");
      expect(call[0].sourceMemoryId).not.toBe(call[0].targetMemoryId);
      expect(call[0].workspaceId).toBe("workspace-1");
    }
  });

  it("skips cross-link when only 1 memory is reported used", async () => {
    const harness = await createHarness([MEM_A]);

    await reportUsed(harness, [MEM_A]);

    expect(harness.graphEdgePort.createEdge).not.toHaveBeenCalled();
  });

  it("skips cross-link for skipped/not_applicable reports (no used_object_ids semantics)", async () => {
    const harness = await createHarness([MEM_A, MEM_B]);

    await reportUsage(harness, "skipped", []);

    expect(harness.graphEdgePort.createEdge).not.toHaveBeenCalled();
  });

  it("emits an observable warning when used_object_ids exceeds the fan-out cap", async () => {
    // Create 10 memories so the used report exceeds MAX_CROSS_LINK_FANOUT = 8.
    const memoryIds = Array.from({ length: 10 }, (_, idx) =>
      `11111111-aaaa-4aaa-8aaa-0000000000${(idx + 1).toString().padStart(2, "0")}`
    );
    const warn = vi.fn();
    const harness = await createHarness(memoryIds, { warn });

    await reportUsed(harness, memoryIds);

    // 8 ordered × 7 cross targets = 56 edge writes; truncation warned once.
    expect(harness.graphEdgePort.createEdge).toHaveBeenCalledTimes(56);
    expect(warn).toHaveBeenCalledWith(
      "mcp-memory-tool-handler: cross-link truncated to fanout cap",
      expect.objectContaining({
        usedObjectCount: 10,
        truncatedTo: 8,
        droppedCount: 2
      })
    );
  });

  it("persists RECALLS edges that a later recall reads as graph_support", async () => {
    const harness = await createHarness([MEM_A, MEM_B, MEM_C], { realGraphEdges: true });

    await reportUsed(harness, [MEM_A, MEM_B]);

    const persistedEdges = await harness.graphEdgeRepo.findByWorkspace("workspace-1");
    expect(persistedEdges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source_memory_id: MEM_A,
          target_memory_id: MEM_B,
          edge_type: "recalls"
        }),
        expect.objectContaining({
          source_memory_id: MEM_B,
          target_memory_id: MEM_A,
          edge_type: "recalls"
        })
      ])
    );

    const recallService = createRecallServiceWithPersistedGraph(harness);
    const result = await recallService.recall({
      taskSurface: createTaskSurface("seed memory"),
      workspaceId: "workspace-1",
      runId: "run-1",
      strategy: "build"
    });

    const candidateA = result.candidates.find((candidate) => candidate.object_id === MEM_A);
    const candidateB = result.candidates.find((candidate) => candidate.object_id === MEM_B);
    const candidateC = result.candidates.find((candidate) => candidate.object_id === MEM_C);

    expect(candidateA?.score_factors?.graph_support).toBeGreaterThan(0);
    expect(candidateB?.score_factors?.graph_support).toBeGreaterThan(0);
    expect(candidateC?.score_factors?.graph_support ?? 0).toBe(0);
  });

  it("never fails the report when the graph edge port throws", async () => {
    const harness = await createHarness([MEM_A, MEM_B]);
    harness.graphEdgePort.createEdge.mockRejectedValueOnce(new Error("edge db down"));

    // Must still resolve OK — graph edges are supplementary, not load-bearing.
    const result = await reportUsed(harness, [MEM_A, MEM_B]);

    expect(result).toMatchObject({ ok: true });
  });
});

async function createHarness(
  memoryIds: readonly string[],
  options: {
    readonly realGraphEdges?: boolean;
    readonly warn?: (message: string, meta: Record<string, unknown>) => void;
  } = {}
) {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);
  const eventLogRepo = new SqliteEventLogRepo(database);
  const memoryEntryRepo = new SqliteMemoryEntryRepo(database);
  const graphEdgeRepo = new SqliteMemoryGraphEdgeRepo(database);
  const runRepo = new SqliteRunRepo(database);
  const trustStateRepo = new SqliteTrustStateRepo(database);
  const workspaceRepo = new SqliteWorkspaceRepo(database);
  const runtimeNotifier: RuntimeNotifier = {
    notify: () => {},
    notifyEntry: () => {}
  };
  const eventPublisher = new EventPublisher({
    eventLogRepo,
    runHotStateService: { apply: () => {} },
    runtimeNotifier
  });
  const trustStateRecorder = createTrustStateRecorder({
    eventPublisher,
    repo: trustStateRepo,
    ready: true,
    clock: () => "2026-05-07T00:00:00.000Z"
  });
  const memoryService = new MemoryService({
    memoryEntryRepo,
    evidenceService: { findById: async () => ({ object_id: "evidence-1" }) },
    eventLogRepo,
    runtimeNotifier,
    now: () => "2026-05-07T00:00:00.000Z"
  });

  await workspaceRepo.create({
    workspace_id: "workspace-1",
    name: "workspace one",
    root_path: "/tmp/workspace-1",
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

  for (const id of memoryIds) {
    await memoryEntryRepo.create(createMemoryEntry(id));
  }
  await trustStateRecorder.recordDelivery({
    delivery_id: "delivery-cross-link",
    agent_target: "codex",
    workspace_id: "workspace-1",
    run_id: "run-1",
    delivered_object_ids: memoryIds,
    delivered_at: "2026-05-07T00:00:00.000Z"
  });

  let edgeCounter = 0;
  const graphExploreService = new GraphExploreService({
    memoryRepo: memoryEntryRepo,
    edgeRepo: graphEdgeRepo,
    eventLogRepo,
    runtimeNotifier,
    now: () => "2026-05-07T00:00:01.000Z",
    generateId: () => `00000000-0000-4000-8000-${(++edgeCounter).toString().padStart(12, "0")}`
  });

  const graphEdgePort = {
    createEdge: vi.fn(async (params: Parameters<GraphExploreService["addEdge"]>[0]) => {
      if (options.realGraphEdges === true) {
        await graphExploreService.addEdge(params);
      }
    })
  };

  const handler = createMcpMemoryToolHandler({
    recallService: {
      recall: vi.fn(async () => ({
        candidates: [],
        total_scanned: 0,
        coarse_filter_count: 0,
        fine_assessment_count: 0
      }))
    },
    memoryService: {
      findById: memoryService.findById.bind(memoryService),
      findByIdScoped: memoryService.findByIdScoped.bind(memoryService),
      update: memoryService.update.bind(memoryService),
      validateUpdate: memoryService.validateUpdate.bind(memoryService)
    },
    signalService: {
      receiveSignal: vi.fn(async (signal) => ({ signal }))
    },
    graphExploreService: {
      exploreOneHop: vi.fn(async () => [])
    },
    graphEdgePort,
    sessionOverrideService: {
      apply: vi.fn(async () => ({ runtime_id: "override-1" }))
    },
    trustStateRecorder,
    eventPublisher,
    memoryEntryRepo,
    now: () => "2026-05-07T00:00:01.000Z",
    generateId: () => "00000000-0000-4000-8000-000000000001",
    ...(options.warn === undefined ? {} : { warn: options.warn })
  });

  return { eventLogRepo, graphEdgePort, graphEdgeRepo, handler, memoryEntryRepo };
}

type ReportHarness = Pick<Awaited<ReturnType<typeof createHarness>>, "handler">;

async function reportUsed(
  harness: ReportHarness,
  usedObjectIds: readonly string[]
) {
  return await reportUsage(harness, "used", usedObjectIds);
}

async function reportUsage(
  harness: ReportHarness,
  usageState: "used" | "skipped" | "not_applicable",
  usedObjectIds: readonly string[]
) {
  return await harness.handler.call({
    toolName: "soul.report_context_usage",
    arguments: {
      delivery_id: "delivery-cross-link",
      usage_state: usageState,
      used_object_ids: usedObjectIds,
      reason: "cross-link test"
    },
    context: {
      workspaceId: "workspace-1",
      runId: "run-1",
      agentTarget: "codex",
      sessionId: "recall-cross-link-session"
    }
  });
}

function createRecallServiceWithPersistedGraph(
  harness: Pick<Awaited<ReturnType<typeof createHarness>>, "eventLogRepo" | "graphEdgeRepo" | "memoryEntryRepo">
): RecallService {
  const deps: RecallServiceDependencies = {
    now: () => "2026-05-07T00:00:02.000Z",
    generateRuntimeId: () => "00000000-0000-4000-8000-000000000099",
    memoryRepo: harness.memoryEntryRepo,
    slotRepo: {
      findByWorkspace: vi.fn(async () => [])
    },
    eventLogRepo: {
      append: harness.eventLogRepo.append.bind(harness.eventLogRepo),
      queryByEntity: vi.fn(async () => [])
    },
    graphSupportPort: {
      countInboundSupports: harness.graphEdgeRepo.countInboundSupports.bind(harness.graphEdgeRepo),
      countInboundEdgesWeighted: harness.graphEdgeRepo.countInboundEdgesWeighted.bind(harness.graphEdgeRepo)
    }
  };

  return new RecallService(deps);
}

function createTaskSurface(displayName: string): TaskObjectSurface {
  return {
    runtime_id: "00000000-0000-4000-8000-000000000098",
    object_kind: ControlPlaneObjectKind.TASK_OBJECT_SURFACE,
    task_surface_ref: null,
    expires_at: "2026-05-07T00:30:00.000Z",
    derived_from: null,
    retention_policy: RetentionPolicy.SESSION_ONLY,
    surface_kind: "build",
    display_name: displayName,
    context_refs: []
  };
}

function createMemoryEntry(objectId: string): MemoryEntry {
  return {
    object_id: objectId,
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-05-07T00:00:00.000Z",
    updated_at: "2026-05-07T00:00:00.000Z",
    created_by: "recall-cross-link-test",
    dimension: MemoryDimension.PREFERENCE,
    source_kind: SourceKind.USER,
    formation_kind: FormationKind.EXPLICIT,
    scope_class: ScopeClass.PROJECT,
    content: `seed memory ${objectId}`,
    domain_tags: ["recall"],
    evidence_refs: [],
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    storage_tier: StorageTier.HOT,
    activation_score: 0.5,
    retention_score: 0.9,
    manifestation_state: "excerpt",
    retention_state: "working",
    decay_profile: "stable",
    confidence: 1,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: 0,
    contradiction_count: 0,
    superseded_by: null
  };
}
