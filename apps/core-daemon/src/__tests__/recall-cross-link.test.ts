import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EventPublisher,
  MemoryService,
  type RuntimeNotifier
} from "@do-soul/alaya-core";
import {
  FormationKind,
  MemoryDimension,
  ScopeClass,
  SourceKind,
  StorageTier,
  type MemoryEntry
} from "@do-soul/alaya-protocol";
import {
  initDatabase,
  SqliteEventLogRepo,
  SqliteMemoryEntryRepo,
  SqliteTrustStateRepo,
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

  it("never fails the report when the graph edge port throws", async () => {
    const harness = await createHarness([MEM_A, MEM_B]);
    harness.graphEdgePort.createEdge.mockRejectedValueOnce(new Error("edge db down"));

    // Must still resolve OK — graph edges are supplementary, not load-bearing.
    const result = await reportUsed(harness, [MEM_A, MEM_B]);

    expect(result).toMatchObject({ ok: true });
  });
});

async function createHarness(memoryIds: readonly string[]) {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);
  const eventLogRepo = new SqliteEventLogRepo(database);
  const memoryEntryRepo = new SqliteMemoryEntryRepo(database);
  const trustStateRepo = new SqliteTrustStateRepo(database);
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

  const graphEdgePort = {
    createEdge: vi.fn(async () => undefined)
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
    generateId: () => "00000000-0000-4000-8000-000000000001"
  });

  return { handler, graphEdgePort };
}

async function reportUsed(
  harness: Awaited<ReturnType<typeof createHarness>>,
  usedObjectIds: readonly string[]
) {
  return await reportUsage(harness, "used", usedObjectIds);
}

async function reportUsage(
  harness: Awaited<ReturnType<typeof createHarness>>,
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
