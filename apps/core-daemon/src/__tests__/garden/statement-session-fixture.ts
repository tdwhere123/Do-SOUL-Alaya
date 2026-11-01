import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeGardenComputeConfig, SourceStatement, SourceStatementRequest } from "@do-soul/alaya-protocol";
import {
  DynamicsService, EventPublisher, EvidenceService, MemoryService, SignalService, appendSourceRecordAdmitted,
  createSignalEmissionWriter, createSourceAdmissionPort, fieldContractSha256
} from "@do-soul/alaya-core";
import { InMemoryHandoffGapHandler, OfficialApiGardenProvider } from "@do-soul/alaya-soul";
import {
  initDatabase, SqliteEvidenceCapsuleRepo, SqliteEventLogRepo, SqliteGardenTaskRepo, SqliteKarmaEventRepo,
  SqliteMemoryEntryRepo, SqliteRunRepo, SqliteSignalRepo, SqliteSourceGroundingDeferQueueRepo, SqliteWorkspaceRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { createPostTurnExtractTaskProcessor } from "../../garden/host-worker/host-worker-task-processors.js";
import { createStatementSessionTaskProcessor } from "../../garden/host-worker/statement-session-task-processor.js";
import { createPostTurnSignalReceiver } from "../../garden/post-turn-extract/signal-receiver.js";
import { enqueuePostTurnExtractTask } from "../../mcp-memory/garden-task/post-turn-extract-queue.js";
import { createDaemonFieldComposition } from "../../runtime/field/field-composition.js";
import { createMaterializationRouter } from "../../runtime/recall-materialization/recall-materialization-router.js";
import { createSourceGroundingDeferTransitions } from "../../runtime/source-grounding-defer/transitions.js";
import { createDeliveryRecord } from "../mcp-memory/garden/post-turn-extract-task-record-fixture.js";

export const WORKSPACE = "workspace-1";
export const RUN = "run-1";
export const START = "2026-09-14T12:00:00.000Z";
export const OFFICIAL_CONFIG: RuntimeGardenComputeConfig = {
  provider_kind: "official_api", model_id: "test-model", provider_url: null, secret_ref: "env:TEST", enabled: true
};
type Message = Readonly<{ role: string; content_excerpt: string }>;

/** Production post-turn admission, statement publication and SQLite reopen, with an injected model only. */
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
    hostCaptureBinding: request => ({ namespace: "alaya", workspace_id: request.workspace_id,
      producer: "post-turn", basis: "reported_excerpt" }),
    audit: record => appendSourceRecordAdmitted(eventLogRepo, record, notifier) });
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
  const signalReceiver = createPostTurnSignalReceiver(signalService, eventLogRepo, evidenceRepo);
  const requests: SourceStatementRequest[] = [];
  return {
    directory, filename, clock, now, field, eventLogRepo, eventPublisher, signalService, memoryService, gardenTaskRepo,
    sourceAdmission, signalReceiver, requests,
    get database() { return database; },
    advance(ms: number) { clock.now = new Date(Date.parse(clock.now) + ms).toISOString(); },
    report: async (turnIndex: number, messages: readonly Message[]) => await enqueuePostTurnExtractTask(
      { deps: { gardenTaskRepo, sourceAdmission }, now },
      { delivery_id: "delivery-1", usage_state: "used", turn_index: turnIndex, turn_digest: { last_messages: [...messages] } },
      { workspaceId: WORKSPACE, runId: RUN, agentTarget: "codex", sessionId: "session-1" },
      createDeliveryRecord({ delivered_at: START })),
    /** A recorded model: each target message yields the statements `respond` returns for its text. */
    provider: (respond: (text: string) => readonly SourceStatement[]) => new OfficialApiGardenProvider({
      apiKey: "sk-test", now, extractor: { extract: async ({ userPrompt }) => {
        const request = JSON.parse(userPrompt) as SourceStatementRequest;
        requests.push(request);
        return { rawJson: JSON.stringify({ messages: request.messages.map(message => ({
          message_id: message.message_id, statements: respond(message.text) })) }) };
      } } }),
    processPostTurn: createPostTurnExtractTaskProcessor({ now, gardenTaskRepo, eventPublisher, signalReceiver, warn: () => undefined }),
    processSession: (provider: OfficialApiGardenProvider, config: RuntimeGardenComputeConfig = OFFICIAL_CONFIG) =>
      createStatementSessionTaskProcessor({ now, gardenTaskRepo, eventPublisher, signalReceiver,
        configService: { getRuntimeGardenComputeConfig: async () => config },
        officialApiGardenProvider: provider, warn: () => undefined })(),
    sessionTasks: () => database.connection.prepare(`SELECT id, status, payload_json, last_error_text FROM garden_tasks
      WHERE kind = 'source_statement_session' ORDER BY json_extract(payload_json, '$.chunk_index')`)
      .all() as { id: string; status: string; payload_json: string; last_error_text: string | null }[],
    reopen() { database.close(); database = initDatabase({ filename }); return database; },
    async close() { database.close(); await rm(directory, { recursive: true, force: true }); }
  };
}
