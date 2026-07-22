import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { expect } from "vitest";
import {
  EdgeClassifyTaskPayloadSchema,
  GardenRole,
  GardenTaskKind,
  GardenTier,
  RunMode,
  RunState,
  WorkspaceKind,
  WorkspaceState,
  type CandidateMemorySignal,
  type EdgeClassifyTaskPayload,
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
import { createAlayaMcpServer } from "../../mcp/mcp-server.js";
import {
  createMcpMemoryToolHandler,
  type McpMemoryToolCallContext,
  type McpMemoryToolHandlerDependencies
} from "../../mcp-memory/tool-handler.js";
import type {
  PostTurnSignalReceiveResult,
  PostTurnSignalReceiver
} from "../../garden/post-turn-extract/signal-receiver.js";

const harnesses = new Set<GardenMcpHarness>();

export async function cleanupGardenMcpHarnesses(): Promise<void> {
  for (const harness of harnesses) {
    await harness.close();
  }
  harnesses.clear();
}

export interface GardenListPendingTasksResponse {
  readonly tasks: readonly {
    readonly task_id: string;
    readonly role: string;
    readonly kind: string;
    readonly created_at: string;
    readonly payload: unknown;
  }[];
}

export interface GardenClaimTaskResponse {
  readonly status: "claimed" | "already_claimed";
  readonly task_id: string;
  readonly role: string;
  readonly kind: string;
  readonly payload: unknown;
}

export interface GardenCompleteTaskResponse {
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

interface GardenMcpReceiveSignalContext {
  readonly gardenTaskRepo: SqliteGardenTaskRepo;
  readonly signalService: SignalService;
}

export interface GardenMcpHarnessOptions {
  readonly now?: () => string;
  readonly receiveSignal?: (
    signal: CandidateMemorySignal,
    context: GardenMcpReceiveSignalContext
  ) => Promise<PostTurnSignalReceiveResult>;
  readonly hasCreatedEvidence?: PostTurnSignalReceiver["hasCreatedEvidence"];
  readonly omitPostTurnSignalReceiver?: boolean;
  readonly completeWithEvents?: (
    taskId: string,
    result: Parameters<SqliteGardenTaskRepo["completeWithEvents"]>[1],
    events: Parameters<SqliteGardenTaskRepo["completeWithEvents"]>[2],
    claimedBy: string,
    original: SqliteGardenTaskRepo["completeWithEvents"]
  ) => Promise<void>;
  readonly applyVerdict?: NonNullable<
    McpMemoryToolHandlerDependencies["edgeVerdictApplier"]
  >["applyVerdict"];
}

export interface GardenMcpHarness {
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
      readonly payload: unknown;
      readonly created_at: string;
    }>
  ): void;
  getGardenTask(taskId: string): GardenTaskDbRow;
  setContext(overrides: Partial<McpMemoryToolCallContext>): void;
}

export async function createGardenMcpHarness(
  options: GardenMcpHarnessOptions = {}
): Promise<GardenMcpHarness> {
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
  const originalCompleteWithEvents = gardenTaskRepo.completeWithEvents.bind(gardenTaskRepo);
  const handlerGardenTaskRepo: NonNullable<McpMemoryToolHandlerDependencies["gardenTaskRepo"]> = {
    enqueue: gardenTaskRepo.enqueue.bind(gardenTaskRepo),
    findById: gardenTaskRepo.findById.bind(gardenTaskRepo),
    peekPending: gardenTaskRepo.peekPending.bind(gardenTaskRepo),
    claimAtomic: gardenTaskRepo.claimAtomic.bind(gardenTaskRepo),
    completeWithEvents: async (taskId, result, events, claimedBy) => {
      if (options.completeWithEvents !== undefined) {
        await options.completeWithEvents(taskId, result, events, claimedBy, originalCompleteWithEvents);
        return;
      }
      await originalCompleteWithEvents(taskId, result, events, claimedBy);
    },
    beginCompletionAttempt: gardenTaskRepo.beginCompletionAttempt.bind(gardenTaskRepo),
    refreshClaim: gardenTaskRepo.refreshClaim.bind(gardenTaskRepo),
    releaseClaim: gardenTaskRepo.releaseClaim.bind(gardenTaskRepo),
    countByKind: gardenTaskRepo.countByKind.bind(gardenTaskRepo)
  };
  const receiveSignal: NonNullable<GardenMcpHarnessOptions["receiveSignal"]> =
    options.receiveSignal ?? (async (signal) => await signalService.receiveSignal(signal));
  const context: McpMemoryToolCallContext = {
    workspaceId: "workspace-a",
    runId: "run-a",
    agentTarget: "garden-worker",
    sessionId: "garden-mcp-tools-test-session",
    surfaceId: "garden-mcp-tools-test"
  };
  await seedWorkspaceRun(workspaceRepo, runRepo, "workspace-a", "run-a");
  await seedWorkspaceRun(workspaceRepo, runRepo, "workspace-b", "run-b");
  let client: Client | null = null;
  let server: Server | null = null;

  const deps: McpMemoryToolHandlerDependencies = {
    now: options.now ?? (() => "2026-05-07T00:10:00.000Z"),
    generateId: () => "00000000-0000-4000-8000-000000000001",
    recallService: {
      recall: async () => ({
        candidates: [],
        active_constraints: [],
        active_constraints_count: 0,
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
      receiveSignal: async (signal) =>
        await receiveSignal(signal, {
          gardenTaskRepo,
          signalService
        })
    },
    ...(options.omitPostTurnSignalReceiver === true
      ? {}
      : {
          postTurnSignalReceiver: {
            receiveSignal: async (signal) =>
              await receiveSignal(signal, { gardenTaskRepo, signalService }),
            hasCreatedEvidence: options.hasCreatedEvidence ?? (async () => true)
          }
        }),
    graphExploreService: {
      exploreOneHop: async () => []
    },
    sessionOverrideService: {
      apply: async () => ({ runtime_id: "override-garden-test" })
    },
    trustStateRecorder: {
      recordDelivery: async (input) => ({ ...input, audit_event_id: "event-delivery" }),
      recordUsage: async (input) => ({ ...input, audit_event_id: "event-usage" }),
      findDeliveryById: async () => null
    },
    eventPublisher,
    gardenTaskRepo: handlerGardenTaskRepo,
    ...(options.applyVerdict === undefined
      ? {}
      : { edgeVerdictApplier: { applyVerdict: options.applyVerdict } })
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
        const errorText = (result.content as readonly { readonly text?: unknown }[] | undefined)
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

export function createTaskDescriptor(overrides: Partial<GardenTaskDescriptor> = {}): GardenTaskDescriptor {
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

export function createEdgeClassifyPayload(overrides: {
  readonly taskId: string;
  readonly sourceObjectId?: string;
  readonly neighborObjectId?: string;
  readonly sourceSignalId?: string | null;
}): EdgeClassifyTaskPayload {
  return EdgeClassifyTaskPayloadSchema.parse({
    task_id: overrides.taskId,
    task_kind: GardenTaskKind.EDGE_CLASSIFY,
    required_tier: GardenTier.TIER_2,
    run_id: "run-a",
    workspace_id: "workspace-a",
    priority: 30,
    created_at: "2026-05-07T00:00:00.000Z",
    dimension: "fact",
    scope_class: "project",
    source_memory: {
      object_id: overrides.sourceObjectId ?? "memory-source",
      content: "RTK wrapper is required for shell commands.",
      domain_tags: ["rtk", "workflow"]
    },
    neighbor_memory: {
      object_id: overrides.neighborObjectId ?? "memory-neighbor",
      content: "Repository shell commands must use the RTK wrapper.",
      domain_tags: ["rtk", "workflow"]
    },
    source_signal_id: overrides.sourceSignalId === undefined ? "signal-1" : overrides.sourceSignalId
  });
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
