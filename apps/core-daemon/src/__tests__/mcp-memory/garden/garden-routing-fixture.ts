import { stubRecallIndex } from "../tool/mcp-memory-tool-handler-fixture.js";
import { expect, vi } from "vitest";
import {
  GardenTaskKind,
  RunMode,
  RunState,
  LegacyCandidateMemorySignalSchema,
  SignalSource,
  WorkspaceKind,
  WorkspaceState,
  SourceStatementRequestSchema,
  type ContextDeliveryRecord,
  type HostScopedReference,
  type HostSessionCaptureResponse,
  type HostSessionMessage,
  type LegacyCandidateMemorySignal,
  type RuntimeGardenComputeConfig,
  type SourceStatement,
  type SourceStatementMessage,
  type SourceStatementRequest
} from "@do-soul/alaya-protocol";
import {
  EventPublisher,
  fieldContractSha256,
  SignalService
} from "@do-soul/alaya-core";
import { extractSourceStatementRequest, type GardenComputeProvider } from "@do-soul/alaya-soul";
import {
  createGardenBackgroundDataPorts,
  initDatabase,
  SqliteEventLogRepo,
  SqliteEvidenceCapsuleRepo,
  SqliteFieldSourceRecordRepo,
  SqliteGardenTaskRepo,
  SqliteHandoffGapRepo,
  SqliteHealthJournalRepo,
  SqlitePathGraphSnapshotRepo,
  SqlitePathRelationRepo,
  SqliteRunRepo,
  SqliteSignalRepo,
  SqliteSourceRootRecallReader,
  SqliteWorkspaceRepo,
  type GardenTaskRow,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { hostSessionContainerKey } from "@do-soul/alaya-protocol";
import { createDaemonFieldRepos } from "../../../runtime/field/field-repos.js";
import { createSqliteFieldFormationStores } from "../../../runtime/field/sqlite-field-formation-stores.js";
import type { BackgroundServiceConfig } from "../../../background/bootstrap.js";
import { createGardenRuntime } from "../../../garden/runtime/runtime.js";
import type { PostTurnSignalReceiver } from "../../../garden/post-turn-extract/signal-receiver.js";
import {
  createDaemonHostSessionCapture, MCP_HOST_SESSION_ISSUER, type HostSessionCapture
} from "../../../garden/host-session/host-session-capture.js";
import {
  createMcpMemoryToolHandler,
  type McpMemoryToolCallContext,
  type McpMemoryToolCallResult,
  type McpMemoryToolHandler,
  type McpMemoryToolHandlerDependencies
} from "../../../mcp-memory/tool/tool-handler.js";
import {
  createDeliveryRecord,
  createMemoryEntry,
  defaultContext,
  gardenTaskSignalId,
  noRunContext,
  sessionRunContext,
  unwrapOk
} from "./garden-routing-record-fixture.js";

export {
  createDeliveryRecord,
  defaultContext,
  gardenTaskSignalId,
  noRunContext,
  sessionRunContext,
  unwrapOk
} from "./garden-routing-record-fixture.js";

const harnesses = new Set<ClosableHarness>();

export function cleanupGardenRoutingHarnesses(): void {
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
  readonly hostSessionCapture: HostSessionCapture;
  /** Captures one complete host turn through the MCP issuer; its round root is admitted at once. */
  captureTurn(options?: Readonly<{ messages?: readonly HostSessionMessage[]; runId?: string;
    container?: HostScopedReference; closesTail?: boolean }>): Promise<HostSessionCaptureResponse>;
  /** Round root ids of the default container in round order. */
  roundRoots(): readonly string[];
  runScheduler(): Promise<void>;
  /** Moves the runtime clock forward, e.g. past the statement session idle interval. */
  advance(ms: number): void;
  sessionTasks(): readonly GardenTaskRow[];
}

export interface GardenListPendingTasksOutput {
  readonly tasks: readonly {
    readonly task_id: string;
    readonly role: string;
    readonly kind: string;
    readonly payload: unknown;
  }[];
}

export const ROUTING_CONTAINER: HostScopedReference = { scope: "routing-host", id: "conversation-1" };

/** The default captured turn: a user preference and the assistant's acknowledgement. */
export function routingTurn(overrides: Readonly<{ user?: string; first?: number; hostReportedAt?: string }> = {}):
  readonly HostSessionMessage[] {
  const first = overrides.first ?? 0;
  const at = overrides.hostReportedAt === undefined ? {} : { host_reported_at: overrides.hostReportedAt };
  return [
    { message_id: `message-${first}`, position: first, role: "user", completeness: "complete", fidelity: "original_bytes",
      content: overrides.user ?? "I prefer pnpm commands in this repo.", ...at },
    { message_id: `message-${first + 1}`, position: first + 1, role: "assistant", completeness: "complete",
      fidelity: "original_bytes", content: "Acknowledged and applied.", ...at }
  ];
}

export async function createHandlerHarness(options: {
  readonly delivery?: ContextDeliveryRecord | null;
  readonly filename?: string;
} = {}): Promise<HandlerHarness> {
  const base = await createSqliteHarnessBase(options.filename);
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
  readonly now?: () => string;
  readonly officialExtract?: StatementExtract;
  readonly localExtract?: StatementExtract;
  readonly receiveSignal?: PostTurnSignalReceiver["receiveSignal"];
}): Promise<RoutingHarness> {
  const base = await createSqliteHarnessBase();
  const baseNow = options.now ?? (() => "2026-05-07T00:10:00.000Z");
  let offsetMs = 0;
  const now = () => offsetMs === 0 ? baseNow() : new Date(Date.parse(baseNow()) + offsetMs).toISOString();
  const signalService = new SignalService({
    eventLogRepo: base.eventLogRepo,
    signalRepo: base.signalRepo,
    runtimeNotifier: base.runtimeNotifier
  });
  const officialProvider = createProvider("official_api", options.officialExtract);
  const localProvider = createProvider("local_heuristics", options.localExtract);
  const hostSessionCapture = hostSessionCaptureFor(base, now);
  const runtime = createGardenRuntime({
    now,
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
    // The routing fixture isolates task dispatch from materialization.
    signalReceiver: {
      receiveSignal: options.receiveSignal ?? ((signal) => signalService.receiveSignal(signal))
    } satisfies PostTurnSignalReceiver,
    hostSessionCaptureFor: () => hostSessionCapture,
    strongRefService: {
      isProtected: vi.fn(async () => false)
    } as unknown as Parameters<typeof createGardenRuntime>[0]["strongRefService"],
    workspaceRepo: base.workspaceRepo
  });
  const harness: RoutingHarness = {
    ...base,
    signalService,
    hostSessionCapture,
    async captureTurn(captureOptions = {}) {
      return await hostSessionCapture.capture({ workspaceId: "workspace-1", runId: captureOptions.runId ?? "run-1",
        issuer: MCP_HOST_SESSION_ISSUER, request: { container: captureOptions.container ?? ROUTING_CONTAINER,
          messages: captureOptions.messages ?? routingTurn(),
          ...(captureOptions.closesTail === undefined ? {} : { closes_tail: captureOptions.closesTail }) } });
    },
    roundRoots() {
      return base.gardenTaskRepo.statementSessions.rounds("workspace-1", hostSessionContainerKey(ROUTING_CONTAINER, fieldContractSha256))
        .map(round => round.root_id);
    },
    async runScheduler() {
      await getService(runtime, "GardenScheduler").task();
    },
    advance(ms) {
      offsetMs += ms;
    },
    sessionTasks() {
      return (base.database.connection.prepare(`SELECT id FROM garden_tasks WHERE kind = ?
        ORDER BY json_extract(payload_json, '$.chunk_index'), id`).all(GardenTaskKind.SOURCE_STATEMENT_SESSION) as { id: string }[])
        .map(row => base.gardenTaskRepo.findById(row.id)!);
    }
  };
  harnesses.add(harness);
  return harness;
}

function hostSessionCaptureFor(base: Readonly<{ database: StorageDatabase; eventLogRepo: SqliteEventLogRepo;
  gardenTaskRepo: SqliteGardenTaskRepo }>, now: () => string) {
  return createDaemonHostSessionCapture({ eventLogRepo: base.eventLogRepo, runtimeNotifier: { notifyEntry: () => undefined },
    gardenTaskRepo: base.gardenTaskRepo, now, warn: () => undefined,
    stores: createSqliteFieldFormationStores({ repos: createDaemonFieldRepos({ database: base.database }),
      database: base.database }) });
}

async function createSqliteHarnessBase(filename = ":memory:") {
  const database = initDatabase({ filename });
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
  readonly database: StorageDatabase;
  readonly eventPublisher: EventPublisher;
  readonly gardenTaskRepo: SqliteGardenTaskRepo;
  readonly signalRepo: SqliteSignalRepo;
  readonly eventLogRepo: SqliteEventLogRepo;
  readonly runtimeNotifier: { notifyEntry(entry: unknown): void };
}, options: {
  readonly delivery?: ContextDeliveryRecord | null;
  readonly hostSessionCapture?: HostSessionCapture;
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
        index: stubRecallIndex([]),
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
    postTurnSignalReceiver: {
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
    gardenTaskRepo: base.gardenTaskRepo,
    hostSessionCapture: options.hostSessionCapture ?? hostSessionCaptureFor(base, () => "2026-05-07T00:10:00.000Z")
  };
}

export function pageWorkspaceSourceRoots(database: StorageDatabase) {
  return new SqliteSourceRootRecallReader(
    new SqliteFieldSourceRecordRepo(database, fieldContractSha256),
    new SqliteEvidenceCapsuleRepo(database)
  ).page({
    workspaceId: "workspace-1",
    limit: 8,
    nativeLimit: 8,
    afterCursor: null
  });
}

export async function recall(
  handler: McpMemoryToolHandler,
  overrides: Partial<{
    readonly query: string;
    readonly recent_turn: string;
    readonly source_observed_at: string;
    readonly context: McpMemoryToolCallContext;
  }> = {}
): Promise<McpMemoryToolCallResult> {
  return await handler.call({
    toolName: "soul.recall",
    arguments: {
      protocol_version: 1,
      supported_result_kinds: ["memory_entry", "source_evidence"],
      supports_source_evidence: true,
      supports_product_updates: true,
      query: overrides.query ?? "recall test query",
      scope_class: null,
      dimension: null,
      domain_tags: null,
      max_results: 5,
      ...(overrides.recent_turn === undefined ? {} : { recent_turn: overrides.recent_turn }),
      ...(overrides.source_observed_at === undefined
        ? {}
        : { source_observed_at: overrides.source_observed_at })
    },
    context: overrides.context ?? defaultContext()
  });
}

/** Recorded host-worker output echoes the claimed request's host message ids only. */
export function recordedSessionResponses(claimedPayload: unknown,
  respond: (message: SourceStatementMessage) => readonly SourceStatement[]) {
  const request = SourceStatementRequestSchema.parse(
    (claimedPayload as { source_statements: { requests: readonly unknown[] } }).source_statements.requests[0]);
  return [{ chunk_index: request.chunk_index, raw_json: JSON.stringify({ messages: request.messages.map(message => ({
    message_id: message.message_id, statements: respond(message) })) }) }];
}

/** Retained body of an admitted source record. */
export function retainedSourceBody(database: StorageDatabase, recordId: string): string | null | undefined {
  return (database.connection.prepare("SELECT source_body FROM source_records WHERE record_id = ?").get(recordId) as
    { source_body: string | null } | undefined)?.source_body;
}

type StatementExtract = NonNullable<GardenComputeProvider["extractSourceStatementRequest"]>;

function createProvider(
  provider_kind: GardenComputeProvider["provider_kind"],
  extract: StatementExtract | undefined
): GardenComputeProvider {
  return { provider_kind, compile: async () => { throw new Error("statement sessions never compile"); },
    ...(extract === undefined ? {} : { extractSourceStatementRequest: extract }) };
}

/** A recorded statement model: each target message yields the statements `respond` returns for it. */
export function recordedStatementExtract(
  respond: (message: SourceStatementMessage) => readonly SourceStatement[] = () => [],
  rawJson?: (request: SourceStatementRequest) => string
) {
  return vi.fn<StatementExtract>(async request => (await extractSourceStatementRequest({ request,
    transport: async () => ({ rawJson: rawJson?.(request) ?? JSON.stringify({ messages: request.messages.map(message => ({
      message_id: message.message_id, statements: respond(message) })) }) }) })).receipt);
}

export function createSignal(
  overrides: Partial<LegacyCandidateMemorySignal> = {}
): LegacyCandidateMemorySignal {
  const { source_observation = null, ...signalOverrides } = overrides;
  return LegacyCandidateMemorySignalSchema.parse({
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
    raw_payload: {
      observation: "post-turn extraction test",
      matched_text: "Post-turn extraction test.",
      full_turn_content: "Post-turn extraction test.",
      source_grounding: {
        version: 1,
        status: "grounded",
        content_basis: "matched_text",
        proposed_matched_text: "Post-turn extraction test.",
        reasons: []
      }
    },
    created_at: "2026-05-07T00:11:00.000Z",
    ...signalOverrides,
    source_observation
  });
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
