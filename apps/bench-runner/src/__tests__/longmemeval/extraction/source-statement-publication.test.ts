import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
const boundary = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { Worker } from "node:worker_threads";
import { once } from "node:events";
import {
  BoundSourceStatementSchema, renderOfficialApiSourceCorpus,
  sourceIndexProfileId, sourceIndexNavigationLocation, hashLabeledIdentity, type ConversationMessage,
  type SourceStatementSignal
} from "@do-soul/alaya-protocol";
import {
  DynamicsService, EvidenceService, MemoryService, SignalService, EventPublisher, createSignalEmissionWriter,
  createAuditedSourceAdmission, createSourceAdmissionPort, appendSourceRecordAdmitted, createSourceObservationPublication,
  deriveAddressableSpanViews, fieldContractSha256, SourceIndexAcquisition
} from "@do-soul/alaya-core";
import { OfficialApiGardenProvider, OfficialApiGardenCompileIncompleteError, InMemoryHandoffGapHandler } from "@do-soul/alaya-soul";
import {
  initDatabase, SqliteWorkspaceRepo, SqliteRunRepo, SqliteEventLogRepo, SqliteMemoryEntryRepo,
  SqliteEvidenceCapsuleRepo, SqliteSignalRepo, SqliteKarmaEventRepo,
  SqliteFieldEraseBarrierRepo, SqliteGardenTaskRepo, type StorageDatabase
} from "@do-soul/alaya-storage";
import { createDaemonFieldComposition } from "../../../../../core-daemon/src/runtime/field/field-composition.js";
import { createMaterializationRouter } from "../../../../../core-daemon/src/runtime/recall-materialization/recall-materialization-router.js";

import { enqueueConversationGardenCompileTask } from "../../../../../core-daemon/src/mcp-memory/garden-task/post-turn-extract-queue.js";
import { parsePostTurnExtractTaskPayload } from "../../../../../core-daemon/src/garden/post-turn-extract/task-payload.js";
import { sourceStatementTaskRequests, receiveSourceStatementTask } from "../../../../../core-daemon/src/garden/post-turn-extract/source-statement-task.js";

const CLOCK = "2026-09-14T12:00:00.000Z", WORKSPACE = "workspace-statement", RUN = "run-statement";
const messages: readonly ConversationMessage[] = [
  { message_id: "a1", role: "assistant", content: "目的地 is the Berlin museum.", created_at: CLOCK },
  { message_id: "u1", role: "user", content: "I visited it yesterday.", created_at: CLOCK }
];
const rendered = renderOfficialApiSourceCorpus("", messages);
const statement = { text: "The user visited the Berlin museum on 2026-09-13.", relation: "museum attendance" };
const rawResponse = (partial = false) => JSON.stringify({ messages: [
  { message_id: "a1", statements: [] },
  { message_id: "u1", statements: [statement, ...(partial ? [{ text: "rejected", relation: "" }] : [])] }
] });
const BUDGET = { work: 100000, native_bytes: 16 * 1024 * 1024 };
const QUERY_BUDGET = { work_units: 1000000, memory_bytes: 16 * 1024 * 1024 };
import { prepareRecordedStatementIndex, RECORDED_STATEMENT_CONFIGURATION as configuration } from "../../support/recorded-statement-index.js";
const databases = new Set<StorageDatabase>(), directories = new Set<string>();
afterEach(() => { vi.restoreAllMocks(); for (const db of databases) db.close(); databases.clear();
  for (const directory of directories) rmSync(directory, { recursive: true, force: true }); directories.clear(); });
afterAll(() => { boundary.restore(); expect(boundary.violations).toEqual([]); });

async function fixture(existingFilename?: string) {
  const directory = existingFilename === undefined ? mkdtempSync(join(tmpdir(), "alaya-statements-")) : dirname(existingFilename);
  if (existingFilename === undefined) directories.add(directory);
  const filename = existingFilename ?? join(directory, "memory.sqlite"), database = initDatabase({ filename }); databases.add(database);
  if (existingFilename === undefined) {
  await new SqliteWorkspaceRepo(database).create({ workspace_id: WORKSPACE, name: "statements", root_path: directory,
    workspace_kind: "local_repo", default_engine_binding: null, workspace_state: "active" });
  await new SqliteRunRepo(database).create({ run_id: RUN, workspace_id: WORKSPACE, title: "session", goal: null,
    run_mode: "chat", engine_binding_id: null, engine_class: null, run_state: "idle", current_surface_id: null });
  }
  const eventLogRepo = new SqliteEventLogRepo(database), field = createDaemonFieldComposition({ database, eventLogRepo });
  const notifier = { notifyEntry: vi.fn(async () => undefined), notify: async () => undefined };
  const evidenceService = new EvidenceService({ evidenceCapsuleRepo: new SqliteEvidenceCapsuleRepo(database),
    eventLogRepo, runtimeNotifier: notifier, fieldStores: field.stores, now: () => CLOCK });
  const memoryRepo = new SqliteMemoryEntryRepo(database);
  const memoryService = new MemoryService({ memoryEntryRepo: memoryRepo, eventLogRepo, evidenceService,
    runtimeNotifier: notifier, now: () => CLOCK, dynamicsService: new DynamicsService({ memoryRepo,
      karmaEventRepo: new SqliteKarmaEventRepo(database), eventLogRepo, runtimeNotifier: notifier }) });
  const sourceAdmission = createAuditedSourceAdmission({ stores: field.stores, eventLogRepo,
    sha256: fieldContractSha256, runtimeNotifier: notifier,
    hostCaptureBinding: request => ({ namespace: "recorded-session", workspace_id: request.workspace_id,
      producer: "recorded-transport", basis: "pinned_dataset" }) });
  const sourceRequest = { workspace_id: WORKSPACE, source_id: "artifact-session", source_version: "1",
    content_bytes: rendered.content, evidence_object_id: null, recorded_at: CLOCK, event_time: CLOCK,
    valid_from: null, valid_to: null, speaker: null, scope_class: "project" as const,
    spans: deriveAddressableSpanViews(rendered.content), host_occurrences: rendered.occurrences.map(occurrence => ({
      occurrence_id: messages[occurrence.message_index]!.message_id, utf8_span: occurrence.utf8_span,
      role: messages[occurrence.message_index]!.role, channel: null, author_ref: null, container_ref: null,
      upstream_message_ref: null, upstream_position: null, completeness: "complete" as const, fidelity: occurrence.fidelity
    })) };
  const admitted = await sourceAdmission.admit(sourceRequest, { workspaceId: WORKSPACE });
  const unexpected = async () => { throw new Error("unexpected legacy materialization"); };
  const router = createMaterializationRouter({ wiring: { evidenceService, memoryService,
    synthesisService: { create: unexpected }, claimService: { create: unexpected }, fieldComposition: field,
    eventLogRepo, runtimeNotifier: notifier, enqueueEnrichPending: () => undefined },
    pathRelationProposalPort: { assertPathRelationProposalAvailable: unexpected, createPathRelationProposal: unexpected },
    temporalRelationAssertionPort: { admit: unexpected }, conflictDetectionService: null, reconciliationService: null,
    handoffGapHandler: new InMemoryHandoffGapHandler() });
  const signalRepo = new SqliteSignalRepo(database);
  const eventPublisher = new EventPublisher({ eventLogRepo, runtimeNotifier: notifier,
    runHotStateService: { apply: async () => undefined } });
  const signalService = new SignalService({ eventLogRepo, signalRepo, runtimeNotifier: notifier,
    emissionWriter: createSignalEmissionWriter({ eventPublisher, signalRepo }),
    postTriageMaterializer: { materialize: (signal, context) => router.materializeSignal(signal, context) } });
  const provider = (response = rawResponse()) => new OfficialApiGardenProvider({ injectedExtractorCapability: "cache_only",
    extractor: { extract: async () => ({ rawJson: response, usage: { inputTokens: 40, outputTokens: 20 } }) },
    now: () => CLOCK, generateSignalId: () => "recorded-statement" });
  const compileContext = { workspace_id: WORKSPACE, run_id: RUN, surface_id: null, turn_messages: messages,
    artifact_key: "artifact-session", source_root_id: admitted.record.identity, source_observation: {
      observed_at: CLOCK, authority: "trusted_host_event" as const, source_event_id: "recorded-source-event"
    } };
  const compile = async (response = rawResponse()) => (await provider(response).compile(rendered.content, compileContext))[0] as SourceStatementSignal;
  return { database, filename, field, router, signalService, memoryService, memoryRepo, evidenceService, eventPublisher, eventLogRepo, notifier,
    sourceAdmission, sourceRequest, admitted, provider, compileContext, compile };
}

describe("audited source statements and auxiliary retrieval keys", () => {
  it("commits the derived-memory dependency with the audited memory row", async () => {
    const environment = await fixture(), signal = await environment.compile();
    const publication = createSourceObservationPublication({ stores: environment.field.stores,
      evidenceService: environment.evidenceService, memoryService: environment.memoryService,
      sha256: fieldContractSha256, deriveTemporalProjection: () => ({}) });
    const result = await publication.publish({ signal, sourceEventAnchor: null });
    expect(environment.database.connection.prepare("SELECT memory_id,artifact_id FROM source_statement_memory_bindings").all())
      .toEqual([{ memory_id: result.memory.object_id, artifact_id: result.evidence.object_id }]);
  });
  it("rolls back memory and its audit if the dependency write fails, retaining recoverable evidence", async () => {
    const environment = await fixture(), signal = await environment.compile();
    const publication = createSourceObservationPublication({ stores: environment.field.stores,
      evidenceService: environment.evidenceService, memoryService: environment.memoryService,
      sha256: fieldContractSha256, deriveTemporalProjection: () => ({}) });
    environment.database.connection.exec("CREATE TRIGGER reject_statement_binding BEFORE INSERT ON source_statement_memory_bindings BEGIN SELECT RAISE(ABORT,'binding refused'); END");
    await expect(publication.publish({ signal, sourceEventAnchor: null })).rejects.toThrow("interrupted after evidence");
    expect(environment.database.connection.prepare("SELECT COUNT(*) AS n FROM memory_entries").get()).toEqual({ n: 0 });
    expect(environment.database.connection.prepare("SELECT COUNT(*) AS n FROM event_log WHERE event_type='soul.memory.created'").get()).toEqual({ n: 0 });
    expect(environment.database.connection.prepare("SELECT COUNT(*) AS n FROM evidence_capsules").get()).toEqual({ n: 1 });
    environment.database.connection.exec("DROP TRIGGER reject_statement_binding");
    await publication.publish({ signal, sourceEventAnchor: null });
    expect(environment.database.connection.prepare("SELECT COUNT(*) AS n FROM source_statement_memory_bindings").get()).toEqual({ n: 1 });
  });

  it("publishes one generic memory and retrieves its raw host root through lexical and same-space vector keys", async () => {
    const environment = await fixture(), signal = await environment.compile();
    const received = await environment.signalService.receiveSignal(signal);
    expect(received.triage_result).toBe("accepted"); expect(received.materialization?.success).toBe(true);
    const rows = environment.database.connection.prepare("SELECT dimension,confidence,content FROM memory_entries").all();
    expect(rows).toEqual([{ dimension: "observation", confidence: null, content: statement.text }]);
    const evidence = environment.database.connection.prepare("SELECT object_id,gist,excerpt FROM evidence_capsules").get() as {
      object_id: string; gist: string; excerpt: string };
    const bound = BoundSourceStatementSchema.parse(JSON.parse(evidence.gist));
    expect(bound.statement).toEqual(statement); expect(bound.message).toMatchObject({ message_id: "u1", role: "user", recorded_at: CLOCK });
    expect(bound.source_span).toEqual(rendered.occurrences[1]!.utf8_span);
    expect(Buffer.from(rendered.content).subarray(...bound.source_span).toString("utf8")).toBe(messages[1]!.content);
    expect(evidence.excerpt).toBe(messages[1]!.content);
    expect(environment.database.connection.prepare("SELECT source_provenance FROM evidence_capsules").get()).toEqual({ source_provenance: 1 });
    expect(environment.database.connection.prepare("SELECT COUNT(*) AS n FROM source_records").get()).toEqual({ n: 1 });
    const { index, targets } = prepareRecordedStatementIndex(environment.database, WORKSPACE);
    expect(targets.filter(row => row.auxiliary !== undefined)).toHaveLength(1);
    const auxiliary = targets.find(row => row.auxiliary !== undefined)!;
    expect(auxiliary.target.root_id).toBe(environment.admitted.record.identity);
    expect(auxiliary.root_key).not.toBe(targets.find(row => row.auxiliary === undefined)!.root_key);
    const lexical = index.readLexicalCandidates(WORKSPACE, "museum attendance", 10, QUERY_BUDGET);
    expect(lexical.candidates.some(row => row.source.auxiliary?.artifact_id === evidence.object_id)).toBe(true);
    const result = new SourceIndexAcquisition(index, fieldContractSha256).nominate({ workspace_id: WORKSPACE,
      navigation_text: "attendance", vector: { status: "available", profile: configuration.profile,
        profile_id: sourceIndexProfileId(configuration.profile, fieldContractSha256),
        input_digest: `sha256:${fieldContractSha256("attendance")}`, embedding: new Float32Array([1, 0, 0]) },
      allowance: { max_roots: 10, max_attempts: 20, max_vector_windows: 64 }, budget: QUERY_BUDGET
    }, () => "admitted");
    expect(result.nominations).toHaveLength(1);
    expect(result.nominations[0]!.source.target.root_id).toBe(environment.admitted.record.identity);
    expect(result.nominations[0]!.vector?.cosine).toBe(1);
    expect(sourceIndexNavigationLocation(auxiliary, { start_byte: 0, end_byte: auxiliary.body_bytes }))
      .toEqual({ start_byte: bound.source_span[0], end_byte: bound.source_span[1] });
    const worker = new Worker(new URL("../../support/source-statement-reader-worker.mjs", import.meta.url), {
      workerData: { filename: environment.filename, workspace: WORKSPACE, query: "attendance", rootId: environment.admitted.record.identity }
    });
    const exited = once(worker, "exit"), reply = await once(worker, "message");
    expect(await exited).toEqual([0]);
    expect(reply[0]).toMatchObject({ targets: [{ target: { root_id: environment.admitted.record.identity } }],
      raw: { source_body: rendered.content } });
    environment.database.close();
    const reopened = initDatabase({ filename: environment.filename }); databases.add(reopened);
    expect(reopened.connection.prepare("SELECT COUNT(*) AS n FROM source_statement_artifacts").get()).toEqual({ n: 1 });
    expect(reopened.connection.prepare("SELECT source_body FROM source_records WHERE record_id=?").get(environment.admitted.record.identity))
      .toEqual({ source_body: rendered.content });
  });

  it("keeps valid siblings from a partial receipt and recovers evidence-first failure without duplicate memory or key", async () => {
    const environment = await fixture();
    let partial: OfficialApiGardenCompileIncompleteError | undefined;
    try { await environment.provider(rawResponse(true)).compile(rendered.content, environment.compileContext); }
    catch (error) { if (!(error instanceof OfficialApiGardenCompileIncompleteError)) throw error; partial = error; }
    expect(partial?.receipt.status).toBe("partial"); expect(partial?.signals).toHaveLength(1);
    expect(partial?.receipt.chunks[0]!.usage).toEqual({ input_tokens: 40, output_tokens: 20 });
    const signal = partial!.signals[0]!;
    vi.spyOn(environment.memoryService, "create").mockRejectedValueOnce(new Error("recorded memory interruption"));
    const failed = await environment.signalService.receiveSignal(signal);
    expect(failed.materialization?.success).toBe(false);
    expect(environment.database.connection.prepare("SELECT COUNT(*) AS n FROM evidence_capsules").get()).toEqual({ n: 1 });
    expect(environment.database.connection.prepare("SELECT COUNT(*) AS n FROM source_statement_artifacts").get()).toEqual({ n: 1 });
    expect(environment.database.connection.prepare("SELECT COUNT(*) AS n FROM memory_entries").get()).toEqual({ n: 0 });
    expect((await environment.router.materializeSignal(signal)).success).toBe(true);
    expect((await environment.router.materializeSignal(signal)).success).toBe(true);
    expect(environment.database.connection.prepare("SELECT COUNT(*) AS n FROM memory_entries").get()).toEqual({ n: 1 });
    expect(environment.database.connection.prepare("SELECT COUNT(*) AS n FROM source_statement_artifacts").get()).toEqual({ n: 1 });
  });

  it("invalidates prepared keys on source replacement and scrubs statement dependencies on erasure", async () => {
    const environment = await fixture();
    const signal = await environment.compile(); await environment.signalService.receiveSignal(signal);
    const { index, targets } = prepareRecordedStatementIndex(environment.database, WORKSPACE), auxiliary = targets.find(row => row.auxiliary !== undefined)!;
    await environment.sourceAdmission.admit({ ...environment.sourceRequest, source_version: "2",
      recorded_at: "2026-09-15T12:00:00.000Z" }, { workspaceId: WORKSPACE });
    expect(index.admitQueryCandidate(auxiliary, null, QUERY_BUDGET).status).toBe("stale");
    expect((await environment.router.materializeSignal(signal)).success).toBe(false);
    new SqliteFieldEraseBarrierRepo(environment.database, fieldContractSha256).apply({
      identity: hashLabeledIdentity("erase_barrier", [WORKSPACE, "source_record", environment.admitted.record.identity, ""], fieldContractSha256),
      barrier_id: "erase-recorded-source", workspace_id: WORKSPACE, generation_id: null,
      subject_kind: "source_record", subject_id: environment.admitted.record.identity, erased_at: CLOCK
    });
    expect(environment.database.connection.prepare("SELECT COUNT(*) AS n FROM source_statement_artifacts").get()).toEqual({ n: 0 });
    expect(environment.database.connection.prepare("SELECT COUNT(*) AS n FROM source_index_text WHERE body LIKE '%attendance%'").get()).toEqual({ n: 0 });
    expect(environment.database.connection.prepare("SELECT COUNT(*) AS n FROM evidence_capsules WHERE gist LIKE '%Berlin%'").get()).toEqual({ n: 0 });
  });

  it("publishes host-worker responses against the queue's captured occurrence IDs and recorded times", async () => {
    const environment = await fixture(), tasks = new SqliteGardenTaskRepo(environment.database.connection, environment.eventPublisher);
    const sourceAdmission = createSourceAdmissionPort({ stores: environment.field.stores, sha256: fieldContractSha256,
      hostCaptureBinding: request => ({ namespace: "alaya", workspace_id: request.workspace_id, producer: "post-turn", basis: "reported_excerpt" }),
      audit: async record => { await appendSourceRecordAdmitted(environment.eventLogRepo, record, environment.notifier); }
    });
    await enqueueConversationGardenCompileTask({ gardenTaskRepo: tasks, sourceAdmission, now: () => CLOCK }, {
      workspaceId: WORKSPACE, runId: RUN, userMessage: messages[1]!, assistantMessage: messages[0]!
    });
    const task = tasks.peekPending("librarian")[0]!;
    expect(task).toBeDefined();
    const payload = parsePostTurnExtractTaskPayload(task.payload);
    const planned = sourceStatementTaskRequests(payload, task.id);
    expect(planned.requests[0]!.messages.map(row => row.recorded_at)).toEqual([CLOCK, CLOCK]);
    const messageId = planned.requests[0]!.messages[0]!.message_id;
    const completed = await receiveSourceStatementTask({ taskId: task.id, payload, now: () => CLOCK,
      responses: [{ chunk_index: 0, raw_json: JSON.stringify({ messages: planned.requests[0]!.messages.map(message => ({
        message_id: message.message_id, statements: message.message_id === messageId ? [statement] : []
      })) }) }] });
    expect(completed.incomplete).toBe(false);
    expect(completed.signals).toHaveLength(1);
    expect((await environment.signalService.receiveSignal(completed.signals[0]!)).materialization?.success).toBe(true);
    const gist = environment.database.connection.prepare("SELECT gist FROM evidence_capsules").get() as { gist: string };
    expect(BoundSourceStatementSchema.parse(JSON.parse(gist.gist))).toMatchObject({
      message: { message_id: messageId, role: "user", recorded_at: CLOCK }, source_root_id: payload.admitted_source_root_id
    });
  });

  it.each(["lookup", "memory_write"] as const)("rejects a source replacement at the %s boundary without compensating evidence", async boundary => {
    const environment = await fixture(), signal = await environment.compile();
    const replace = () => environment.sourceAdmission.admit({ ...environment.sourceRequest, source_version: "2",
      recorded_at: "2026-09-15T12:00:00.000Z" }, { workspaceId: WORKSPACE });
    if (boundary === "lookup") {
      vi.spyOn(environment.memoryService, "findByIdScoped").mockImplementationOnce(async () => { await replace(); return null; });
    } else {
      const create = environment.memoryService.create.bind(environment.memoryService);
      vi.spyOn(environment.memoryService, "create").mockImplementationOnce(async input => { await replace(); return create(input); });
    }
    expect((await environment.router.materializeSignal(signal)).success).toBe(false);
    expect(environment.database.connection.prepare("SELECT COUNT(*) AS n FROM memory_entries").get()).toEqual({ n: 0 });
    expect(environment.database.connection.prepare("SELECT COUNT(*) AS n FROM evidence_capsules").get()).toEqual({ n: boundary === "lookup" ? 0 : 1 });
  });

  it("converges duplicate publications through independent SQLite connections", async () => {
    const first = await fixture(), second = await fixture(first.filename), signal = await first.compile();
    const results = await Promise.all([first.router.materializeSignal(signal), second.router.materializeSignal(signal)]);
    expect(results.map(result => result.success)).toEqual([true, true]);
    for (const table of ["evidence_capsules", "memory_entries", "source_statement_artifacts"]) {
      expect(first.database.connection.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 1 });
    }
  });

  it("changes the generation when an artifact arrives and refuses archived artifact replay", async () => {
    const environment = await fixture(), before = prepareRecordedStatementIndex(environment.database, WORKSPACE);
    expect(before.targets).toHaveLength(1);
    const signal = await environment.compile();
    expect((await environment.router.materializeSignal(signal)).success).toBe(true);
    const after = prepareRecordedStatementIndex(environment.database, WORKSPACE);
    expect(after.generation.generation_id).not.toBe(before.generation.generation_id);
    expect(after.targets).toHaveLength(2);
    const artifact = after.targets.find(row => row.auxiliary !== undefined)!;
    environment.database.connection.prepare("UPDATE evidence_capsules SET lifecycle_state='archived'").run();
    expect(after.index.admitQueryCandidate(artifact, null, QUERY_BUDGET).status).toBe("stale");
    expect((await environment.router.materializeSignal(signal)).success).toBe(false);
    expect(environment.database.connection.prepare("SELECT COUNT(*) AS n FROM source_statement_artifacts").get()).toEqual({ n: 0 });
  });

  it("rejects forged host role, extent, and scope before publication and leaves raw source available", async () => {
    const environment = await fixture(), signal = await environment.compile(), located = signal.raw_payload.source_statement;
    for (const change of [
      { ...located, message: { ...located.message, role: "assistant" } },
      { ...located, message: { ...located.message, message_id: "forged" } },
      { ...located, source_span: [0, 4] },
      { ...located, source_corpus_digest: "b".repeat(64) }
    ]) {
      const result = await environment.router.materializeSignal({ ...signal, raw_payload: { source_statement: change } } as SourceStatementSignal);
      expect(result.success).toBe(false);
    }
    expect((await environment.router.materializeSignal({ ...signal, scope_hint: "global_core" })).success).toBe(false);
    expect(environment.database.connection.prepare("SELECT COUNT(*) AS n FROM memory_entries").get()).toEqual({ n: 0 });
    expect(environment.field.stores.getStoredRecord(WORKSPACE, environment.admitted.record.identity)?.content_bytes).toBe(rendered.content);
  });
});
