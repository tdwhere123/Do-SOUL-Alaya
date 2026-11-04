import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hostSessionContainerKey, type HostScopedReference, type HostSessionCaptureRequest, type HostSessionMessage,
  type RuntimeGardenComputeConfig, type SourceStatement, type SourceStatementRequest
} from "@do-soul/alaya-protocol";
import {
  DynamicsService, EventPublisher, EvidenceService, MemoryService, SignalService,
  createSignalEmissionWriter, createSourceAdmissionPort, fieldContractSha256
} from "@do-soul/alaya-core";
import { InMemoryHandoffGapHandler, OfficialApiGardenProvider } from "@do-soul/alaya-soul";
import {
  initDatabase, SqliteEvidenceCapsuleRepo, SqliteEventLogRepo, SqliteGardenTaskRepo, SqliteKarmaEventRepo,
  SqliteMemoryEntryRepo, SqliteRunRepo, SqliteSignalRepo, SqliteSourceGroundingDeferQueueRepo, SqliteWorkspaceRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { createStatementSessionTaskProcessor } from "../../garden/host-worker/statement-session-task-processor.js";
import { createPostTurnSignalReceiver } from "../../garden/post-turn-extract/signal-receiver.js";
import { createHostSessionCapture, createHostSessionSourceAudit, MCP_HOST_SESSION_ISSUER } from "../../garden/host-session/host-session-capture.js";
import { createHostSessionCaptureHandler } from "../../mcp-memory/tool/host-session-handler.js";
import { createDaemonFieldComposition } from "../../runtime/field/field-composition.js";
import { createMaterializationRouter } from "../../runtime/recall-materialization/recall-materialization-router.js";
import { createSourceGroundingDeferTransitions } from "../../runtime/source-grounding-defer/transitions.js";

export const WORKSPACE = "workspace-1";
export const RUN = "run-1";
export const START = "2026-09-14T12:00:00.000Z";
export const OFFICIAL_CONFIG: RuntimeGardenComputeConfig = {
  provider_kind: "official_api", model_id: "test-model", provider_url: null, secret_ref: "env:TEST", enabled: true
};
export const CONTAINER: HostScopedReference = { scope: "test-host", id: "conversation-1" };
export const CONTAINER_KEY = hostSessionContainerKey(CONTAINER, fieldContractSha256);
type Turn = readonly Readonly<{ role: "user" | "assistant"; content: string }>[];

/** Complete original host messages of consecutive turns, positioned from `first`. */
export function hostMessages(turns: readonly Turn[], first = 0, hostReportedAt?: string): readonly HostSessionMessage[] {
  return turns.flat().map((message, index) => ({ message_id: `message-${first + index}`, position: first + index,
    role: message.role, content: message.content, completeness: "complete" as const, fidelity: "original_bytes" as const,
    ...(hostReportedAt === undefined ? {} : { host_reported_at: hostReportedAt }) }));
}

/** Production host-session capture through the MCP entry, statement publication and SQLite reopen, with an injected model only. */
export async function createStatementSessionEnvironment() {
  const directory = await mkdtemp(join(tmpdir(), "alaya-statement-session-"));
  const filename = join(directory, "memory.sqlite");
  const clock = { now: START };
  const now = () => clock.now;
  let database: StorageDatabase = initDatabase({ filename });
  await new SqliteWorkspaceRepo(database).create({ workspace_id: WORKSPACE, name: "workspace", root_path: directory,
    workspace_kind: "local_repo", default_engine_binding: null, workspace_state: "active" });
  await new SqliteRunRepo(database).create({ run_id: RUN, workspace_id: WORKSPACE, title: "run", goal: null,
    run_mode: "chat", engine_binding_id: null, engine_class: null, run_state: "idle", current_surface_id: null });
  const eventLogRepo = new SqliteEventLogRepo(database);
  const field = createDaemonFieldComposition({ database, eventLogRepo });
  const notifier = { notifyEntry: async () => undefined, notify: async () => undefined };
  const evidenceRepo = new SqliteEvidenceCapsuleRepo(database);
  const memoryRepo = new SqliteMemoryEntryRepo(database);
  const evidenceService = new EvidenceService({ evidenceCapsuleRepo: evidenceRepo, eventLogRepo, runtimeNotifier: notifier,
    fieldStores: field.stores, now });
  const memoryService = new MemoryService({ memoryEntryRepo: memoryRepo, eventLogRepo, evidenceService,
    runtimeNotifier: notifier, now, dynamicsService: new DynamicsService({ memoryRepo,
      karmaEventRepo: new SqliteKarmaEventRepo(database), eventLogRepo, runtimeNotifier: notifier }) });
  const sourceAdmission = createSourceAdmissionPort({ stores: field.stores, sha256: fieldContractSha256,
    audit: createHostSessionSourceAudit(eventLogRepo, notifier) });
  const router = createMaterializationRouter({
    wiring: { evidenceService, memoryService, fieldComposition: field, eventLogRepo, runtimeNotifier: notifier,
      synthesisService: { create: async () => { throw new Error("unexpected synthesis route"); } },
      claimService: { create: async () => { throw new Error("unexpected claim route"); } },
      enqueueEnrichPending: () => undefined },
    pathRelationProposalPort: {
      assertPathRelationProposalAvailable: async () => { throw new Error("unexpected path proposal"); },
      createPathRelationProposal: async () => { throw new Error("unexpected path proposal"); }
    },
    temporalRelationAssertionPort: { admit: async () => { throw new Error("unexpected temporal assertion"); } },
    conflictDetectionService: null, reconciliationService: null, handoffGapHandler: new InMemoryHandoffGapHandler()
  });
  const signalRepo = new SqliteSignalRepo(database);
  const queueRepo = new SqliteSourceGroundingDeferQueueRepo(database);
  const eventPublisher = new EventPublisher({ eventLogRepo, runtimeNotifier: notifier,
    runHotStateService: { apply: async () => undefined } });
  const signalService = new SignalService({ eventLogRepo, signalRepo, runtimeNotifier: notifier,
    emissionWriter: createSignalEmissionWriter({ eventPublisher, signalRepo }), sourceGroundingDeferQueue: queueRepo,
    sourceGroundingDeferTransitions: createSourceGroundingDeferTransitions({ eventLogRepo, signalRepo, queueRepo }),
    postTriageMaterializer: { materialize: async (signal, context) => await router.materializeSignal(signal, context) } });
  const gardenTaskRepo = new SqliteGardenTaskRepo(database.connection, eventPublisher);
  const signalReceiver = createPostTurnSignalReceiver(signalService);
  const requests: SourceStatementRequest[] = [];
  const warnings: { message: string; meta: Record<string, unknown> }[] = [];
  const warn = (message: string, meta: Record<string, unknown>) => { warnings.push({ message, meta }); };
  const hostSessionCapture = createHostSessionCapture({ admission: sourceAdmission, ledger: gardenTaskRepo.hostSessions,
    statementSessions: gardenTaskRepo, now, warn });
  const captureHandler = createHostSessionCaptureHandler({ hostSessionCapture });
  return {
    directory, filename, clock, now, field, eventLogRepo, eventPublisher, signalService, memoryService, gardenTaskRepo,
    sourceAdmission, signalReceiver, requests, warnings, hostSessionCapture,
    get database() { return database; },
    advance(ms: number) { clock.now = new Date(Date.parse(clock.now) + ms).toISOString(); },
    /** The MCP host entry, as an attached host calls it. */
    capture: async (request: HostSessionCaptureRequest, runId = RUN) => await captureHandler(request,
      { workspaceId: WORKSPACE, runId, agentTarget: "codex", sessionId: "session-1" }),
    sweep: async () => await hostSessionCapture.sweepIdle(MCP_HOST_SESSION_ISSUER),
    /** Round roots of a container in round order. */
    roots: (containerKey = CONTAINER_KEY) => (database.connection.prepare(`SELECT root_id FROM host_session_rounds
      WHERE workspace_id = ? AND container_key = ? AND state IN ('done', 'erased') ORDER BY round_index`)
      .all(WORKSPACE, containerKey) as { root_id: string }[]).map(round => round.root_id),
    /** A recorded model: each target message yields the statements `respond` returns for its text. */
    provider: (respond: (text: string) => readonly SourceStatement[]) => new OfficialApiGardenProvider({
      apiKey: "sk-test", now, extractor: { extract: async ({ userPrompt }) => {
        const request = JSON.parse(userPrompt) as SourceStatementRequest;
        requests.push(request);
        return { rawJson: JSON.stringify({ messages: request.messages.map(message => ({
          message_id: message.message_id, statements: respond(message.text) })) }) };
      } } }),
    processSession: (provider: OfficialApiGardenProvider, config: RuntimeGardenComputeConfig = OFFICIAL_CONFIG) =>
      createStatementSessionTaskProcessor({ now, gardenTaskRepo, eventPublisher, signalReceiver, hostSessionCapture,
        configService: { getRuntimeGardenComputeConfig: async () => config },
        officialApiGardenProvider: provider, warn })(),
    sessionTasks: () => database.connection.prepare(`SELECT id, status, payload_json, last_error_text FROM garden_tasks
      WHERE kind = 'source_statement_session' ORDER BY json_extract(payload_json, '$.chunk_index')`)
      .all() as { id: string; status: string; payload_json: string; last_error_text: string | null }[],
    reopen() { database.close(); database = initDatabase({ filename }); return database; },
    async close() { database.close(); await rm(directory, { recursive: true, force: true }); }
  };
}
