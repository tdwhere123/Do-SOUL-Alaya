import { afterEach, describe, expect, it, vi } from "vitest";
import { SOURCE_STATEMENTS_CONTRACT, SourceStatementSignalSchema, type SourceStatementSignal } from "@do-soul/alaya-protocol";
import { SqliteEventLogRepo, SqliteKarmaEventRepo, type StorageDatabase } from "@do-soul/alaya-storage";
import { DynamicsService } from "../../../dynamics/dynamics-service.js";
import { EvidenceService } from "../../../memory/evidence-service.js";
import { MemoryService } from "../../../memory/memory-service.js";
import { createAuditedSourceAdmission } from "../../../memory/evidence-create/audited-source-admission.js";
import { createInMemoryFieldStores } from "../../../memory/evidence-create/field-stores.js";
import { resolveCurrentSource } from "../../../memory/evidence-create/source-observation-currentness.js";
import { createSourceObservationPublication } from "../../../memory/evidence-create/source-observation-publication.js";
import { deriveAddressableSpanViews } from "../../../memory/evidence-create/source-span-views.js";
import { fieldContractSha256 } from "../../../shared/field-hash.js";
import { REAL_SQLITE_TEST_RUN_ID as RUN, REAL_SQLITE_TEST_WORKSPACE_ID as WORKSPACE,
  createRecallRealStorage } from "../../shared/real-sqlite.test-support.js";

const CLOCK = "2026-09-14T00:00:00.000Z", SOURCE = "User: Alice uses tools.";
const databases = new Set<StorageDatabase>();
afterEach(() => { for (const database of databases) database.close(); databases.clear(); });

async function fixture(source = SOURCE) {
  const { database, memoryEntryRepo, evidenceCapsuleRepo } = await createRecallRealStorage(db => databases.add(db));
  const eventLogRepo = new SqliteEventLogRepo(database), stores = createInMemoryFieldStores();
  const notify = { notifyEntry: vi.fn(async () => undefined) };
  const sourceAdmission = createAuditedSourceAdmission({ stores, eventLogRepo, sha256: fieldContractSha256,
    runtimeNotifier: notify, hostCaptureBinding: request => ({ namespace: "recorded-session", producer: "recorded-host",
      workspace_id: request.workspace_id, basis: "pinned_dataset" }) });
  const evidenceService = new EvidenceService({ evidenceCapsuleRepo, eventLogRepo, runtimeNotifier: notify, fieldStores: stores });
  const memoryService = new MemoryService({ memoryEntryRepo, eventLogRepo, evidenceService, runtimeNotifier: notify,
    dynamicsService: new DynamicsService({ memoryRepo: memoryEntryRepo, karmaEventRepo: new SqliteKarmaEventRepo(database),
      eventLogRepo, runtimeNotifier: notify }) });
  const sourceRequest = { workspace_id: WORKSPACE, source_id: "artifact-1", source_version: "1", content_bytes: source,
    evidence_object_id: null, recorded_at: CLOCK, event_time: null, valid_from: null, valid_to: null,
    speaker: "user" as const, scope_class: "project" as const, spans: deriveAddressableSpanViews(source),
    host_occurrences: [{ occurrence_id: "message-1", utf8_span: [0, Buffer.byteLength(source)] as const,
      role: "user" as const, channel: null, author_ref: null, container_ref: null, upstream_message_ref: null,
      upstream_position: null, completeness: "complete" as const, fidelity: "original_bytes" as const }] };
  const admitted = await sourceAdmission.admit(sourceRequest, { workspaceId: WORKSPACE });
  const signal = SourceStatementSignalSchema.parse({ signal_id: "signal-1", workspace_id: WORKSPACE, run_id: RUN,
    surface_id: null, source: "garden_compile", signal_kind: "potential_semantic_observation",
    interpretation_contract: SOURCE_STATEMENTS_CONTRACT, object_kind: null, confidence: null, scope_hint: "project",
    domain_tags: [], evidence_refs: [], source_memory_refs: [], supersedes_refs: [], exception_to_refs: [],
    contradicts_refs: [], incompatible_with_refs: [], created_at: CLOCK,
    source_observation: { observed_at: CLOCK, authority: "trusted_host_event", source_event_id: "event-1" },
    raw_payload: { source_statement: { contract: SOURCE_STATEMENTS_CONTRACT, session_id: "session-1", artifact_key: "artifact-1",
      source_root_id: admitted.record.identity, source_corpus_digest: fieldContractSha256(source),
      source_span: [0, Buffer.byteLength(source)], message: { message_id: "message-1", role: "user", text: source, recorded_at: null },
      statement: { text: "Alice uses tools.", relation: "tool usage" } } } });
  const deriveTemporalProjection = vi.fn(() => ({}));
  const publication = createSourceObservationPublication({ deriveTemporalProjection, stores, evidenceService,
    memoryService, sha256: fieldContractSha256 });
  return { database, stores, sourceAdmission, sourceRequest, admitted, signal, memoryService, evidenceService,
    eventLogRepo, notify, publication, deriveTemporalProjection };
}

function unpublished(database: StorageDatabase) {
  expect(database.connection.prepare("SELECT COUNT(*) AS n FROM memory_entries").get()).toEqual({ n: 0 });
  expect(database.connection.prepare("SELECT COUNT(*) AS n FROM evidence_capsules").get()).toEqual({ n: 0 });
}

describe("source statement publication ownership", () => {
  it("hashes each current source body once and rechecks integrity on later reads", async () => {
    const f = await fixture(), located = f.signal.raw_payload.source_statement;
    const stored = f.stores.getStoredRecord(WORKSPACE, f.admitted.record.identity)!;
    const sha256 = vi.fn(fieldContractSha256);
    for (let read = 1; read <= 2; read++) {
      expect(resolveCurrentSource(f.stores, WORKSPACE, located, sha256)).toEqual(stored);
      expect(sha256).toHaveBeenCalledTimes(read); expect(sha256).toHaveBeenLastCalledWith(SOURCE);
    }
    sha256.mockClear();
    expect(() => resolveCurrentSource(f.stores, WORKSPACE, { ...located, source_corpus_digest: "0".repeat(64) }, sha256))
      .toThrowError(expect.objectContaining({ code: "VALIDATION", message: "source digest is not current" }));
    expect(sha256).not.toHaveBeenCalled();
    const corrupted = { ...f.stores, getStoredRecord: () => ({ ...stored, content_bytes: `${SOURCE} ` }) };
    expect(() => resolveCurrentSource(corrupted, WORKSPACE, located, sha256)).toThrowError(expect.objectContaining({
      code: "OBLIGATION_VIOLATION", message: "stored source body does not match its digest" }));
    expect(sha256).toHaveBeenCalledExactlyOnceWith(`${SOURCE} `);
  });

  it("keeps a derived capsule as provenance rather than admitting a second source", async () => {
    const f = await fixture(), records = f.stores.listStoredRecords(WORKSPACE);
    const published = await f.publication.publish({ signal: f.signal, sourceEventAnchor: null });
    expect(f.stores.listStoredRecords(WORKSPACE)).toEqual(records);
    expect(f.stores.getCurrentRecord(WORKSPACE, f.admitted.record.content_digest)).toBeNull();
    expect(published.bound.source_target.root_id).toBe(f.admitted.record.identity);
    expect(published.memory).toMatchObject({ content: "Alice uses tools.", dimension: "observation", confidence: null });
    expect(f.deriveTemporalProjection).toHaveBeenCalledWith(SOURCE, null);
  });

  it("preserves exact UTF-8 host spans and rejects UTF-16 offsets before publication", async () => {
    const source = "User: A café sent 中文🙂 mail.", f = await fixture(source);
    const wrong = { ...f.signal, raw_payload: { source_statement: { ...f.signal.raw_payload.source_statement,
      source_span: [0, source.length] as const } } };
    await expect(f.publication.publish({ signal: wrong, sourceEventAnchor: null })).rejects.toThrow(/span/);
    unpublished(f.database);
    const published = await f.publication.publish({ signal: f.signal, sourceEventAnchor: null });
    expect(published.bound.source_span).toEqual([0, Buffer.byteLength(source)]);
    expect(published.bound.source_target.span?.content_end).toBe(Buffer.byteLength(source));
  });

  it.each(["role", "message_id", "source_root_id", "scope"])("rejects forged %s binding before durable effects", async field => {
    const f = await fixture(), altered = structuredClone(f.signal) as unknown as {
      scope_hint: string; raw_payload: { source_statement: { source_root_id: string; message: { role: string; message_id: string } } } };
    if (field === "scope") altered.scope_hint = "personal";
    else if (field === "source_root_id") altered.raw_payload.source_statement.source_root_id = "replaced-root";
    else if (field === "role") altered.raw_payload.source_statement.message.role = "assistant";
    else altered.raw_payload.source_statement.message.message_id = "different-host";
    await expect(f.publication.publish({ signal: altered as unknown as SourceStatementSignal, sourceEventAnchor: null })).rejects.toThrow();
    unpublished(f.database);
  });

  it("replays the same statement without additional evidence, memory, or source-admission audit", async () => {
    const f = await fixture();
    const first = await f.publication.publish({ signal: f.signal, sourceEventAnchor: null });
    const count = f.database.connection.prepare("SELECT COUNT(*) AS n FROM event_log").get();
    const replay = await f.publication.publish({ signal: f.signal, sourceEventAnchor: null });
    expect(replay).toMatchObject(first);
    expect(f.database.connection.prepare("SELECT COUNT(*) AS n FROM event_log").get()).toEqual(count);
  });

  it("rejects a same-body replacement even though its content digest is unchanged", async () => {
    const f = await fixture();
    await f.sourceAdmission.admit({ ...f.sourceRequest, source_version: "2", recorded_at: "2026-09-15T00:00:00.000Z" }, { workspaceId: WORKSPACE });
    await expect(f.publication.publish({ signal: f.signal, sourceEventAnchor: null })).rejects.toThrow(/revision/);
    unpublished(f.database);
  });

  it("rejects observation confidence mutation at the memory update owner", async () => {
    const f = await fixture(), published = await f.publication.publish({ signal: f.signal, sourceEventAnchor: null });
    await expect(f.memoryService.update(published.memory.object_id, { confidence: 0.9 }, "model score"))
      .rejects.toThrow(/observation confidence cannot be mutated/);
    expect((await f.memoryService.findById(published.memory.object_id))?.confidence).toBeNull();
  });
});
