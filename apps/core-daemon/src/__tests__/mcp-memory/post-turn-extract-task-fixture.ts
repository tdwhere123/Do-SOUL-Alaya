import { expect, vi } from "vitest";
import {
  GardenRole,
  GardenTaskKind,
  RunMode,
  RunState,
  SignalSource,
  WorkspaceKind,
  WorkspaceState,
  type CandidateMemorySignal,
  type ContextDeliveryRecord,
  type RuntimeGardenComputeConfig
} from "@do-soul/alaya-protocol";
import { EventPublisher, SignalService } from "@do-soul/alaya-core";
import type { GardenComputeProvider } from "@do-soul/alaya-soul";
import {
  createGardenBackgroundDataPorts,
  initDatabase,
  SqliteEventLogRepo,
  SqliteGardenTaskRepo,
  SqliteHandoffGapRepo,
  SqliteHealthJournalRepo,
  SqlitePathGraphSnapshotRepo,
  SqlitePathRelationRepo,
  SqliteRunRepo,
  SqliteSignalRepo,
  SqliteWorkspaceRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import type { BackgroundServiceConfig } from "../../background/bootstrap.js";
import { createGardenRuntime } from "../../garden/runtime.js";
import { buildGardenTaskSignalId } from "../../garden/index.js";
import {
  createMcpMemoryToolHandler,
  type McpMemoryToolCallContext,
  type McpMemoryToolCallResult,
  type McpMemoryToolHandler,
  type McpMemoryToolHandlerDependencies
} from "../../mcp-memory/tool-handler.js";

const harnesses = new Set<ClosableHarness>();

export function cleanupPostTurnExtractHarnesses(): void {
  for (const harness of harnesses) {
    harness.close();
  }
  harnesses.clear();
}

export interface ClosableHarness {
  close(): void;
}

export interface HandlerHarness extends ClosableHarness {
  readonly database: StorageDatabase;
  readonly gardenTaskRepo: SqliteGardenTaskRepo;
  readonly handler: McpMemoryToolHandler;
}

export interface RoutingHarness extends ClosableHarness {
  readonly database: StorageDatabase;
  readonly eventLogRepo: SqliteEventLogRepo;
  readonly eventPublisher: EventPublisher;
  readonly gardenTaskRepo: SqliteGardenTaskRepo;
  readonly runRepo: SqliteRunRepo;
  readonly signalRepo: SqliteSignalRepo;
  readonly signalService: SignalService;
  readonly runtimeNotifier: { notifyEntry(entry: unknown): void };
  enqueuePostTurnTask(overrides?: {
    readonly id?: string;
    readonly payload?: PostTurnPayload;
    readonly created_at?: string;
  }): void;
  runScheduler(): Promise<void>;
}

export interface GardenListPendingTasksOutput {
  readonly tasks: readonly {
    readonly task_id: string;
    readonly role: string;
    readonly kind: string;
    readonly payload: unknown;
  }[];
}

export interface PostTurnPayload {
  readonly task_id?: string;
  readonly task_kind?: string;
  readonly required_tier?: string;
  readonly run_id: string;
  readonly target_object_refs?: readonly string[];
  readonly priority?: number;
  readonly created_at?: string;
  readonly turn_index: number;
  readonly workspace_id: string;
  readonly turn_digest: {
    readonly last_messages: readonly {
      readonly role: string;
      readonly content_excerpt: string;
    }[];
    readonly context_manifest: {
      readonly delivered_object_ids: readonly string[];
    };
  };
}

export async function createHandlerHarness(options: {
  readonly delivery?: ContextDeliveryRecord | null;
} = {}): Promise<HandlerHarness> {
  const base = await createSqliteHarnessBase();
  const handler = createMcpMemoryToolHandler(createMcpDeps(base, options));
  const harness = {
    ...base,
    handler
  };
  harnesses.add(harness);
  return harness;
}

export async function createRoutingHarness(options: {
  readonly provider_kind: RuntimeGardenComputeConfig["provider_kind"];
  readonly officialCompile?: GardenComputeProvider["compile"];
  readonly localCompile?: GardenComputeProvider["compile"];
}): Promise<RoutingHarness> {
  const base = await createSqliteHarnessBase();
  const signalService = new SignalService({
    eventLogRepo: base.eventLogRepo,
    signalRepo: base.signalRepo,
    runtimeNotifier: base.runtimeNotifier
  });
  const officialProvider = createProvider(
    "official_api",
    options.officialCompile ?? vi.fn(async () => [])
  );
  const localProvider = createProvider(
    "local_heuristics",
    options.localCompile ?? vi.fn(async () => [])
  );
  const runtime = createGardenRuntime({
    databaseConnection: base.database.connection,
    backlogThresholds: {
      warning_queue_depth: 100,
      warning_rearm_depth: 50,
      snapshot_interval_ms: 1000
    },
    eventLogRepo: base.eventLogRepo,
    eventPublisher: base.eventPublisher,
    gardenDataPorts: createGardenBackgroundDataPorts(base.database),
    healthJournalRepo: new SqliteHealthJournalRepo(base.database),
    handoffGapRepo: new SqliteHandoffGapRepo(base.database),
    orphanDetectionEnabled: false,
    orphanRadarRepo: null,
    pathGraphSnapshotRepo: new SqlitePathGraphSnapshotRepo(base.database),
    pathRelationRepo: new SqlitePathRelationRepo(base.database),
    configService: {
      getRuntimeGardenComputeConfig: async () =>
        ({
          provider_kind: options.provider_kind,
          model_id: "test-model",
          provider_url: null,
          secret_ref: options.provider_kind === "official_api" ? "env:ALAYA_TEST_GARDEN_KEY" : null,
          enabled: options.provider_kind !== "host_worker"
        }) satisfies RuntimeGardenComputeConfig
    },
    officialApiGardenProvider: officialProvider,
    localHeuristicsProvider: localProvider,
    signalReceiver: signalService,
    strongRefService: {
      isProtected: vi.fn(async () => false)
    } as unknown as Parameters<typeof createGardenRuntime>[0]["strongRefService"],
    workspaceRepo: base.workspaceRepo
  });
  const harness: RoutingHarness = {
    ...base,
    signalService,
    enqueuePostTurnTask(overrides = {}) {
      base.gardenTaskRepo.enqueue({
        id: overrides.id ?? "post-turn-task-1",
        workspace_id: "workspace-1",
        role: GardenRole.LIBRARIAN,
        kind: GardenTaskKind.POST_TURN_EXTRACT,
        payload: overrides.payload ?? createPostTurnPayload(),
        // Default to "just enqueued" so host_worker rows stay within the
        // in-process fallback wait window — the host worker gets first claim.
        // The bounded-fallback test below enqueues with an explicitly aged
        // created_at to exercise the zero-cloud heuristic fallback path.
        created_at: overrides.created_at ?? new Date().toISOString()
      });
    },
    async runScheduler() {
      await getService(runtime, "GardenScheduler").task();
    }
  };
  harnesses.add(harness);
  return harness;
}

async function createSqliteHarnessBase() {
  const database = initDatabase({ filename: ":memory:" });
  const workspaceRepo = new SqliteWorkspaceRepo(database);
  const runRepo = new SqliteRunRepo(database);
  const eventLogRepo = new SqliteEventLogRepo(database);
  const signalRepo = new SqliteSignalRepo(database);
  const runtimeNotifier = {
    notify: vi.fn(),
    notifyEntry: vi.fn()
  };
  const eventPublisher = new EventPublisher({
    eventLogRepo,
    runHotStateService: { apply: vi.fn() },
    runtimeNotifier
  });
  const gardenTaskRepo = new SqliteGardenTaskRepo(database.connection, eventPublisher);
  await seedWorkspaceRun(workspaceRepo, runRepo);
  return {
    database,
    eventLogRepo,
    eventPublisher,
    gardenTaskRepo,
    runRepo,
    runtimeNotifier,
    signalRepo,
    workspaceRepo,
    close() {
      database.close();
    }
  };
}

async function seedWorkspaceRun(
  workspaceRepo: SqliteWorkspaceRepo,
  runRepo: SqliteRunRepo
): Promise<void> {
  await workspaceRepo.create({
    workspace_id: "workspace-1",
    name: "workspace-1",
    root_path: "/tmp/workspace-1",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    workspace_state: WorkspaceState.ACTIVE
  });
  await seedRun(runRepo, "run-1");
}

export async function seedRun(runRepo: SqliteRunRepo, runId: string): Promise<void> {
  await runRepo.create({
    run_id: runId,
    workspace_id: "workspace-1",
    title: runId,
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: null
  });
}

export function createMcpDeps(base: {
  readonly eventPublisher: EventPublisher;
  readonly gardenTaskRepo: SqliteGardenTaskRepo;
  readonly signalRepo: SqliteSignalRepo;
  readonly eventLogRepo: SqliteEventLogRepo;
  readonly runtimeNotifier: { notifyEntry(entry: unknown): void };
}, options: {
  readonly delivery?: ContextDeliveryRecord | null;
} = {}): McpMemoryToolHandlerDependencies {
  const signalService = new SignalService({
    eventLogRepo: base.eventLogRepo,
    signalRepo: base.signalRepo,
    runtimeNotifier: base.runtimeNotifier
  });
  return {
    now: () => "2026-05-07T00:10:00.000Z",
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
      findByIdScoped: async (objectId, workspaceId) =>
        workspaceId === "workspace-1" ? createMemoryEntry({ object_id: objectId }) : null,
      update: async () => createMemoryEntry()
    },
    signalService: {
      receiveSignal: async (signal) => await signalService.receiveSignal(signal)
    },
    graphExploreService: {
      exploreOneHop: async () => []
    },
    sessionOverrideService: {
      apply: async () => ({ runtime_id: "override-1" })
    },
    trustStateRecorder: {
      recordDelivery: async (input) => ({ ...input, audit_event_id: "event-delivery" }),
      recordUsage: async (input) => ({ ...input, audit_event_id: "event-usage" }),
      findDeliveryById: async () => options.delivery === undefined ? createDeliveryRecord() : options.delivery
    },
    eventPublisher: base.eventPublisher,
    gardenTaskRepo: base.gardenTaskRepo
  };
}

export async function recall(
  handler: McpMemoryToolHandler,
  overrides: Partial<{
    readonly query: string;
    readonly recent_turn: string;
    readonly context: McpMemoryToolCallContext;
  }> = {}
): Promise<McpMemoryToolCallResult> {
  return await handler.call({
    toolName: "soul.recall",
    arguments: {
      query: overrides.query ?? "recall test query",
      scope_class: null,
      dimension: null,
      domain_tags: null,
      max_results: 5,
      ...(overrides.recent_turn === undefined ? {} : { recent_turn: overrides.recent_turn })
    },
    context: overrides.context ?? defaultContext()
  });
}

export async function reportUsage(
  handler: McpMemoryToolHandler,
  overrides: Partial<{
    readonly turn_index: number;
    readonly usage_state: "used" | "skipped" | "not_applicable";
    readonly used_object_ids: readonly string[];
    readonly delivered_objects: readonly {
      readonly object_id: string;
      readonly usage_status: "used" | "skipped" | "not_applicable";
    }[];
    readonly last_messages: readonly {
      readonly role: string;
      readonly content_excerpt: string;
    }[];
    readonly context: McpMemoryToolCallContext;
  }> = {}
): Promise<McpMemoryToolCallResult> {
  const deliveredObjects =
    overrides.delivered_objects ?? [{ object_id: "memory-a", usage_status: "used" }] as const;
  const usedObjectIds = overrides.used_object_ids ??
    deliveredObjects
      .filter((object) => object.usage_status === "used")
      .map((object) => object.object_id);
  return await handler.call({
    toolName: "soul.report_context_usage",
    arguments: {
      delivery_id: "delivery-1",
      usage_state: overrides.usage_state ?? "used",
      used_object_ids: usedObjectIds,
      delivered_objects: deliveredObjects,
      turn_index: overrides.turn_index ?? 1,
      turn_digest: {
        last_messages:
          overrides.last_messages ?? [
            { role: "user", content_excerpt: "Remember that I prefer pnpm." },
            { role: "assistant", content_excerpt: "I used the project preference." }
          ]
      },
      reason: "post-turn extract test"
    },
    context: overrides.context ?? defaultContext()
  });
}

export function postTurnRows(gardenTaskRepo: SqliteGardenTaskRepo) {
  return gardenTaskRepo
    .peekPending(GardenRole.LIBRARIAN, "workspace-1", 20)
    .filter((row) => row.kind === GardenTaskKind.POST_TURN_EXTRACT);
}

function createProvider(
  provider_kind: GardenComputeProvider["provider_kind"],
  compile: GardenComputeProvider["compile"]
): GardenComputeProvider {
  return { provider_kind, compile };
}

export function createPostTurnPayload(overrides: Partial<PostTurnPayload> = {}): PostTurnPayload {
  const payload: PostTurnPayload = {
    task_id: "post-turn-task-1",
    task_kind: GardenTaskKind.POST_TURN_EXTRACT,
    required_tier: "tier_2",
    run_id: "run-1",
    target_object_refs: ["memory-a"],
    priority: 20,
    created_at: "2026-05-07T00:00:00.000Z",
    turn_index: 3,
    workspace_id: "workspace-1",
    turn_digest: {
      last_messages: [
        { role: "user", content_excerpt: "I prefer pnpm commands in this repo." },
        { role: "assistant", content_excerpt: "Acknowledged and applied." }
      ],
      context_manifest: {
        delivered_object_ids: ["memory-a"]
      }
    }
  };
  return { ...payload, ...overrides };
}

export function createSignal(overrides: Partial<CandidateMemorySignal> = {}): CandidateMemorySignal {
  return {
    signal_id: "signal-post-turn",
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    source: SignalSource.GARDEN_COMPILE,
    signal_kind: "potential_preference",
    signal_state: "emitted",
    object_kind: "memory_entry",
    scope_hint: "project",
    domain_tags: ["test"],
    confidence: 0.9,
    evidence_refs: ["memory-a"],
    source_memory_refs: [],
    supersedes_refs: [],
    exception_to_refs: [],
    contradicts_refs: [],
    incompatible_with_refs: [],
    raw_payload: { observation: "post-turn extraction test" },
    created_at: "2026-05-07T00:11:00.000Z",
    ...overrides
  };
}

function createMemoryEntry(overrides: Partial<ReturnType<typeof createMemoryEntryBase>> = {}) {
  return {
    ...createMemoryEntryBase(),
    ...overrides
  } as const;
}

function createMemoryEntryBase() {
  return {
    // Widened from the "memory-a" literal so callers can override with a
    // dynamic object_id (e.g. findByIdScoped echoing its argument).
    object_id: "memory-a" as string,
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-05-07T00:00:00.000Z",
    updated_at: "2026-05-07T00:00:00.000Z",
    created_by: "test",
    dimension: "preference",
    source_kind: "user",
    formation_kind: "explicit",
    scope_class: "project",
    content: "Use pnpm.",
    domain_tags: [],
    evidence_refs: [],
    workspace_id: "workspace-1",
    run_id: "run-1",
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
    superseded_by: null
  } as const;
}

export function createDeliveryRecord(
  overrides: Partial<ContextDeliveryRecord> = {}
): ContextDeliveryRecord {
  return {
    delivery_id: "delivery-1",
    agent_target: "codex",
    workspace_id: "workspace-1",
    run_id: "run-1",
    // Both memory-a and memory-b are served by this delivery so a usage report
    // that cites either id stays a subset of the server-side delivered set.
    // see also: mcp-memory/tool-handler.ts validateReportedRecallHits.
    delivered_object_ids: ["memory-a", "memory-b"],
    delivered_at: "2026-05-07T00:00:00.000Z",
    audit_event_id: "event-delivery",
    ...overrides
  };
}

export function defaultContext(): McpMemoryToolCallContext {
  return {
    workspaceId: "workspace-1",
    runId: "run-1",
    agentTarget: "codex",
    sessionId: "post-turn-extract-test-session",
    surfaceId: "post-turn-extract-test"
  };
}

export function noRunContext(): McpMemoryToolCallContext {
  return {
    ...defaultContext(),
    runId: null,
    sessionId: "mcp-session-without-run"
  };
}

export function sessionRunContext(): McpMemoryToolCallContext {
  return {
    ...defaultContext(),
    runId: "mcp-session-run-1",
    sessionId: "mcp-session-run-1"
  };
}

function getService(runtime: ReturnType<typeof createGardenRuntime>, name: string): BackgroundServiceConfig {
  const services = (runtime.backgroundManager as unknown as {
    readonly services: readonly BackgroundServiceConfig[];
  }).services;
  const service = services.find((candidate) => candidate.name === name);
  if (service === undefined) {
    throw new Error(`Missing background service ${name}.`);
  }
  return service;
}

export function unwrapOk<T>(result: McpMemoryToolCallResult): T {
  expect(result).toMatchObject({ ok: true });
  return (result as Extract<McpMemoryToolCallResult, { ok: true }>).output as T;
}

export const gardenTaskSignalId = buildGardenTaskSignalId;
