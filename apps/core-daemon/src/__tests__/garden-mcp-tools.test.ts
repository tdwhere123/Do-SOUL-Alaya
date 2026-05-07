import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  GardenEventType,
  GardenRole,
  GardenTaskKind,
  GardenTier,
  RunMode,
  RunState,
  SignalSource,
  WorkspaceKind,
  WorkspaceState,
  type CandidateMemorySignal,
  type GardenRoleValue,
  type GardenTaskDescriptor,
  type GardenTaskKindValue,
  type MemoryEntry
} from "@do-soul/alaya-protocol";
import { EventPublisher, SignalService } from "@do-soul/alaya-core";
import {
  initDatabase,
  SqliteEventLogRepo,
  SqliteGardenTaskRepo,
  SqliteRunRepo,
  SqliteSignalRepo,
  SqliteWorkspaceRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { createAlayaMcpServer } from "../mcp-server.js";
import {
  createMcpMemoryToolHandler,
  type McpMemoryToolCallContext,
  type McpMemoryToolHandlerDependencies
} from "../mcp-memory-tool-handler.js";

const harnesses = new Set<GardenMcpHarness>();

afterEach(async () => {
  for (const harness of harnesses) {
    await harness.close();
  }
  harnesses.clear();
});

describe("Garden MCP tools", () => {
  it("list returns pending only", async () => {
    const harness = await createGardenMcpHarness();
    harness.enqueueTask("task-pending");
    harness.enqueueTask("task-claimed");
    harness.gardenTaskRepo.claimAtomic("task-claimed", "worker-a", "2026-05-07T00:00:01.000Z");
    harness.enqueueTask("task-completed");
    harness.gardenTaskRepo.claimAtomic("task-completed", "worker-a", "2026-05-07T00:00:02.000Z");
    await harness.gardenTaskRepo.completeWithEvents(
      "task-completed",
      { status: "completed", completed_at: "2026-05-07T00:00:03.000Z" },
      []
    );

    const response = await harness.callTool<GardenListPendingTasksResponse>(
      "garden.list_pending_tasks",
      { limit: 10 }
    );

    expect(response.tasks.map((task) => task.task_id)).toEqual(["task-pending"]);
    expect(response.tasks[0]).not.toHaveProperty("claimed_at");
    expect(response.tasks[0]).not.toHaveProperty("claimed_by");
  });

  it("list respects workspace boundary", async () => {
    const harness = await createGardenMcpHarness();
    harness.enqueueTask("task-workspace-a", { workspace_id: "workspace-a" });
    harness.setContext({ workspaceId: "workspace-b" });

    const response = await harness.callTool<GardenListPendingTasksResponse>(
      "garden.list_pending_tasks",
      { limit: 10 }
    );

    expect(response.tasks).toEqual([]);
  });

  it("claim happy path echoes the task payload", async () => {
    const harness = await createGardenMcpHarness();
    harness.enqueueTask("task-claim", {
      payload: createTaskDescriptor({
        task_id: "task-claim",
        target_object_refs: ["memory-claim"]
      })
    });

    const listed = await harness.callTool<GardenListPendingTasksResponse>(
      "garden.list_pending_tasks",
      { limit: 10 }
    );
    expect(listed.tasks.map((task) => task.task_id)).toContain("task-claim");

    const response = await harness.callTool<GardenClaimTaskResponse>(
      "garden.claim_task",
      { task_id: "task-claim" }
    );

    expect(response).toMatchObject({
      status: "claimed",
      task_id: "task-claim",
      role: GardenRole.JANITOR,
      kind: GardenTaskKind.TTL_CLEANUP
    });
    expect(response.payload).toMatchObject({
      task_id: "task-claim",
      target_object_refs: ["memory-claim"]
    });
  });

  it("claim already-claimed returns the current task snapshot", async () => {
    const harness = await createGardenMcpHarness();
    harness.enqueueTask("task-already-claimed");

    await harness.callTool<GardenClaimTaskResponse>(
      "garden.claim_task",
      { task_id: "task-already-claimed" }
    );
    const response = await harness.callTool<GardenClaimTaskResponse>(
      "garden.claim_task",
      { task_id: "task-already-claimed" }
    );

    expect(response).toMatchObject({
      status: "already_claimed",
      task_id: "task-already-claimed",
      role: GardenRole.JANITOR,
      kind: GardenTaskKind.TTL_CLEANUP
    });
  });

  it("claim cross-workspace returns already_claimed without leaking the foreign payload", async () => {
    const harness = await createGardenMcpHarness();
    harness.enqueueTask("task-foreign", {
      workspace_id: "workspace-a",
      payload: createTaskDescriptor({
        task_id: "task-foreign",
        workspace_id: "workspace-a",
        target_object_refs: ["secret-foreign-memory"]
      })
    });
    harness.setContext({ workspaceId: "workspace-b" });

    const response = await harness.callTool<GardenClaimTaskResponse>(
      "garden.claim_task",
      { task_id: "task-foreign" }
    );

    expect(response).toEqual({
      status: "already_claimed",
      task_id: "task-foreign",
      role: "unknown",
      kind: "unknown",
      payload: null
    });
    expect(harness.getGardenTask("task-foreign").status).toBe("pending");
  });

  it("complete with candidate_signals appends Garden completion and records signals through the review queue", async () => {
    const harness = await createGardenMcpHarness();
    harness.enqueueTask("task-complete-signals", {
      role: GardenRole.LIBRARIAN,
      kind: GardenTaskKind.PATH_PLASTICITY_UPDATE,
      payload: createTaskDescriptor({
        task_id: "task-complete-signals",
        task_kind: GardenTaskKind.PATH_PLASTICITY_UPDATE,
        required_tier: GardenTier.TIER_2
      })
    });
    await harness.callTool<GardenClaimTaskResponse>(
      "garden.claim_task",
      { task_id: "task-complete-signals" }
    );
    const signal = createCandidateSignal({
      signal_id: "signal-garden-complete",
      raw_payload: { observation: "Host worker extracted a reusable preference." }
    });

    const response = await harness.callTool<GardenCompleteTaskResponse>(
      "garden.complete_task",
      {
        task_id: "task-complete-signals",
        status: "completed",
        result_envelope: {
          candidate_signals: [signal],
          notes: "Host worker completed extraction."
        }
      }
    );

    expect(response).toEqual({
      task_id: "task-complete-signals",
      status: "completed",
      events_appended: 1
    });
    const completedEvents = await harness.eventLogRepo.queryByType(
      GardenEventType.SOUL_GARDEN_TASK_COMPLETED
    );
    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0]?.payload_json).toMatchObject({
      task_id: "task-complete-signals",
      success: true,
      candidate_signals_count: 1
    });
    await expect(harness.signalRepo.getById("signal-garden-complete")).resolves.toMatchObject({
      signal_id: "signal-garden-complete",
      workspace_id: "workspace-a"
    });
  });

  it("complete with status failed stores last_error_text", async () => {
    const harness = await createGardenMcpHarness();
    harness.enqueueTask("task-failed");
    await harness.callTool<GardenClaimTaskResponse>(
      "garden.claim_task",
      { task_id: "task-failed" }
    );

    const response = await harness.callTool<GardenCompleteTaskResponse>(
      "garden.complete_task",
      {
        task_id: "task-failed",
        status: "failed",
        last_error_text: "host extraction timed out"
      }
    );

    expect(response).toEqual({
      task_id: "task-failed",
      status: "failed",
      events_appended: 1
    });
    expect(harness.getGardenTask("task-failed")).toMatchObject({
      status: "failed",
      last_error_text: "host extraction timed out"
    });
  });
});

interface GardenListPendingTasksResponse {
  readonly tasks: readonly {
    readonly task_id: string;
    readonly role: string;
    readonly kind: string;
    readonly created_at: string;
    readonly payload: unknown;
  }[];
}

interface GardenClaimTaskResponse {
  readonly status: "claimed" | "already_claimed";
  readonly task_id: string;
  readonly role: string;
  readonly kind: string;
  readonly payload: unknown;
}

interface GardenCompleteTaskResponse {
  readonly task_id: string;
  readonly status: "completed" | "failed";
  readonly events_appended: number;
}

interface GardenTaskDbRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly status: string;
  readonly claimed_by: string | null;
  readonly claimed_at: string | null;
  readonly completed_at: string | null;
  readonly last_error_text: string | null;
}

interface GardenMcpHarness {
  readonly database: StorageDatabase;
  readonly eventLogRepo: SqliteEventLogRepo;
  readonly gardenTaskRepo: SqliteGardenTaskRepo;
  readonly signalRepo: SqliteSignalRepo;
  callTool<TOutput>(toolName: string, args: Record<string, unknown>): Promise<TOutput>;
  close(): Promise<void>;
  enqueueTask(
    taskId: string,
    overrides?: Partial<{
      readonly workspace_id: string;
      readonly role: GardenRoleValue;
      readonly kind: GardenTaskKindValue;
      readonly payload: GardenTaskDescriptor;
      readonly created_at: string;
    }>
  ): void;
  getGardenTask(taskId: string): GardenTaskDbRow;
  setContext(overrides: Partial<McpMemoryToolCallContext>): void;
}

async function createGardenMcpHarness(): Promise<GardenMcpHarness> {
  const database = initDatabase({ filename: ":memory:" });
  const eventLogRepo = new SqliteEventLogRepo(database);
  const workspaceRepo = new SqliteWorkspaceRepo(database);
  const runRepo = new SqliteRunRepo(database);
  const signalRepo = new SqliteSignalRepo(database);
  const runtimeNotifier = {
    notify: () => {},
    notifyEntry: () => {}
  };
  const eventPublisher = new EventPublisher({
    eventLogRepo,
    runHotStateService: { apply: () => {} },
    runtimeNotifier
  });
  const gardenTaskRepo = new SqliteGardenTaskRepo(database.connection, eventPublisher);
  const signalService = new SignalService({
    eventLogRepo,
    signalRepo,
    runtimeNotifier
  });
  const context: McpMemoryToolCallContext = {
    workspaceId: "workspace-a",
    runId: "run-a",
    agentTarget: "garden-worker",
    surfaceId: "garden-mcp-tools-test"
  };
  await seedWorkspaceRun(workspaceRepo, runRepo, "workspace-a", "run-a");
  await seedWorkspaceRun(workspaceRepo, runRepo, "workspace-b", "run-b");
  let client: Client | null = null;
  let server: Server | null = null;

  const deps: McpMemoryToolHandlerDependencies & { readonly gardenTaskRepo: SqliteGardenTaskRepo } = {
    now: () => "2026-05-07T00:10:00.000Z",
    generateId: () => "00000000-0000-4000-8000-000000000001",
    recallService: {
      recall: async () => ({
        candidates: [],
        total_scanned: 0,
        coarse_filter_count: 0,
        fine_assessment_count: 0
      })
    },
    memoryService: {
      findById: async () => null,
      findByIdScoped: async () => null,
      update: async () => createMemoryEntry()
    },
    signalService: {
      receiveSignal: async (signal) => await signalService.receiveSignal(signal)
    },
    graphExploreService: {
      exploreOneHop: async () => []
    },
    sessionOverrideService: {
      apply: async () => ({ runtime_id: "override-garden-test" })
    },
    trustStateRecorder: {
      recordDelivery: async (input) => ({ ...input, audit_event_id: "event-delivery" }),
      recordUsage: async (input) => ({ ...input, audit_event_id: "event-usage" })
    },
    eventPublisher,
    gardenTaskRepo
  };
  const handler = createMcpMemoryToolHandler(deps);
  server = createAlayaMcpServer({
    memoryToolHandler: handler,
    contextProvider: () => context
  });
  client = new Client(
    { name: "garden-mcp-tools-test", version: "test" },
    { capabilities: {} }
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const harness: GardenMcpHarness = {
    database,
    eventLogRepo,
    gardenTaskRepo,
    signalRepo,
    async callTool<TOutput>(toolName: string, args: Record<string, unknown>): Promise<TOutput> {
      if (client === null) {
        throw new Error("MCP client is closed.");
      }
      const result = await client.callTool({ name: toolName, arguments: args });
      if (result.isError === true) {
        const errorText = result.content
          ?.map((item) => ("text" in item && typeof item.text === "string" ? item.text : ""))
          .join("\n");
        throw new Error(`Tool call failed for ${toolName}: ${errorText}`);
      }
      const structuredContent = result.structuredContent as
        | Readonly<{ ok: true; output: TOutput }>
        | undefined;
      expect(structuredContent).toMatchObject({ ok: true });
      return structuredContent!.output;
    },
    async close() {
      await client?.close();
      await server?.close();
      database.close();
      client = null;
      server = null;
    },
    enqueueTask(taskId, overrides = {}) {
      const workspaceId = overrides.workspace_id ?? "workspace-a";
      const role = overrides.role ?? GardenRole.JANITOR;
      const kind = overrides.kind ?? GardenTaskKind.TTL_CLEANUP;
      gardenTaskRepo.enqueue({
        id: taskId,
        workspace_id: workspaceId,
        role,
        kind,
        payload:
          overrides.payload ??
          createTaskDescriptor({
            task_id: taskId,
            task_kind: kind,
            workspace_id: workspaceId
          }),
        created_at: overrides.created_at ?? "2026-05-07T00:00:00.000Z"
      });
    },
    getGardenTask(taskId) {
      const row = database.connection
        .prepare(
          `SELECT id, workspace_id, status, claimed_by, claimed_at, completed_at, last_error_text
           FROM garden_tasks
           WHERE id = ?`
        )
        .get(taskId) as GardenTaskDbRow | undefined;
      if (row === undefined) {
        throw new Error(`Missing Garden task ${taskId}`);
      }
      return row;
    },
    setContext(overrides) {
      Object.assign(context, overrides);
    }
  };

  harnesses.add(harness);
  return harness;
}

async function seedWorkspaceRun(
  workspaceRepo: SqliteWorkspaceRepo,
  runRepo: SqliteRunRepo,
  workspaceId: string,
  runId: string
): Promise<void> {
  await workspaceRepo.create({
    workspace_id: workspaceId,
    name: workspaceId,
    root_path: `/tmp/${workspaceId}`,
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    workspace_state: WorkspaceState.ACTIVE
  });
  await runRepo.create({
    run_id: runId,
    workspace_id: workspaceId,
    title: runId,
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: null
  });
}

function createTaskDescriptor(overrides: Partial<GardenTaskDescriptor> = {}): GardenTaskDescriptor {
  return {
    task_id: "task-1",
    task_kind: GardenTaskKind.TTL_CLEANUP,
    required_tier: GardenTier.TIER_0,
    workspace_id: "workspace-a",
    run_id: "run-a",
    target_object_refs: ["memory-1"],
    priority: 10,
    created_at: "2026-05-07T00:00:00.000Z",
    ...overrides
  };
}

function createCandidateSignal(overrides: Partial<CandidateMemorySignal> = {}): CandidateMemorySignal {
  return {
    signal_id: "signal-garden-1",
    workspace_id: "workspace-a",
    run_id: "run-a",
    surface_id: "garden-mcp-tools-test",
    source: SignalSource.GARDEN_COMPILE,
    signal_kind: "potential_preference",
    signal_state: "emitted",
    object_kind: "memory_entry",
    scope_hint: "project",
    domain_tags: ["garden"],
    confidence: 0.9,
    evidence_refs: ["memory-1"],
    raw_payload: { observation: "host worker signal" },
    created_at: "2026-05-07T00:00:00.000Z",
    ...overrides
  };
}

function createMemoryEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    object_id: "memory-1",
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-05-07T00:00:00.000Z",
    updated_at: "2026-05-07T00:00:00.000Z",
    created_by: "garden-test",
    dimension: "preference",
    source_kind: "user",
    formation_kind: "explicit",
    scope_class: "project",
    content: "Garden test memory.",
    domain_tags: [],
    evidence_refs: [],
    workspace_id: "workspace-a",
    run_id: "run-a",
    surface_id: null,
    storage_tier: "hot",
    activation_score: 0.5,
    retention_score: 0.5,
    manifestation_state: "excerpt",
    retention_state: "working",
    decay_profile: "stable",
    confidence: 1,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: 0,
    contradiction_count: 0,
    superseded_by: null,
    ...overrides
  };
}
