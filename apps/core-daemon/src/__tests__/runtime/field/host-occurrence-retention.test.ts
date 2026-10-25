import { mkdtempSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createAuditedSourceAdmission, createAuditedSourceReplacement, fieldContractSha256,
  projectSourceFormationSnapshot } from "@do-soul/alaya-core";
import { canonicalJson, type HostOccurrence, type SourceAdmissionContext, type SourceAdmissionRequest } from "@do-soul/alaya-protocol";
import { initDatabase, closeCachedDatabase, SqliteEventLogRepo, SqliteSourceIndexRepository,
  type StorageDatabase } from "@do-soul/alaya-storage";
import { SourceSemanticReadBudget } from "../../../runtime/field/source-semantic-read-stores.js";
import { issueSemanticLease, readSemanticLease, sourceSemanticRevision } from "../../../runtime/recall-read-worker/source-semantic-leases.js";
import { createDaemonFieldComposition } from "../../../runtime/field/field-composition.js";
import { seedWorkspaces } from "../../../../../../packages/storage/src/__tests__/repos/field/field-contract-fixture.js";
import { buildReady } from "../../../../../../packages/storage/src/__tests__/repos/source-index/source-index-fixture.js";

const directories: string[] = [], databases: StorageDatabase[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) { db.close({ optimize: false }); closeCachedDatabase(db.filename); }
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
const WS = "workspace-1", CLOCK = "2026-09-13T00:00:00Z";
const occurrence: HostOccurrence = { occurrence_id: "message-0", utf8_span: [0, 5], role: "tool", channel: "output",
  author_ref: null, container_ref: { scope: "authored", id: "conversation" }, upstream_message_ref: null,
  upstream_position: 0, completeness: "complete", fidelity: "original_bytes" };
const context: SourceAdmissionContext = { workspaceId: WS, hostCapture: request => ({ namespace: "authored",
  workspace_id: request.workspace_id, producer: "structured-fixture", basis: "pinned_dataset" }) };
const request = (overrides: Partial<SourceAdmissionRequest> = {}): SourceAdmissionRequest => ({ workspace_id: WS,
  source_id: "record", source_version: "1", content_bytes: "café", recorded_at: CLOCK, event_time: null,
  valid_from: null, valid_to: null, evidence_object_id: null, scope_class: "project", spans: [],
  host_occurrences: [occurrence, { ...occurrence, occurrence_id: "empty", utf8_span: [5, 5], upstream_position: 1 }], ...overrides });
function open(filename: string) {
  const database = initDatabase({ filename }); databases.push(database);
  const eventLogRepo = new SqliteEventLogRepo(database);
  const field = createDaemonFieldComposition({ database, eventLogRepo, fieldProjectionAdmissionMode: "explicit_checkpoint" });
  const input = { stores: field.stores, sha256: fieldContractSha256, eventLogRepo, runtimeNotifier: { notifyEntry: () => undefined } };
  return { database, field, input, admission: createAuditedSourceAdmission(input) };
}
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "host-inventory-")); directories.push(directory);
  const filename = join(directory, "source.sqlite"), f = open(filename); seedWorkspaces(f.database);
  return { ...f, filename, directory };
}
function read(f: ReturnType<typeof open>, record: { identity: string; source_version: string; content_digest: string },
  limits = { nativeByteLimit: 131072, workLimit: 262144, memoryLimit: 262144 }) {
  return f.field.fieldRepos.records.readHostInventory({ workspaceId: WS, recordId: record.identity,
    sourceVersion: record.source_version, contentDigest: record.content_digest, authorizedScopes: ["project"], ...limits });
}

it("commits source/inventory/message spans atomically, replays after audit failure, replaces and invalidates the affected index", async () => {
  const f = fixture();
  const failing = createAuditedSourceAdmission({ ...f.input, eventLogRepo: { append: () => { throw new Error("audit unavailable"); } } });
  await expect(failing.admit(request(), context)).rejects.toThrow("audit unavailable");
  const retained = f.field.stores.getCurrentRecord(WS, "record")!;
  expect(read(f, retained).inventory?.occurrences).toEqual(request().host_occurrences);
  expect(f.field.stores.listSpans(WS).map(row => [row.purpose, row.start_offset, row.end_offset])).toEqual([["message", 0, 5]]);
  expect((await f.admission.admit(request(), context)).record).toEqual(retained);
  const before = projectSourceFormationSnapshot({ workspaceId: WS, stores: f.field.stores });
  const index = new SqliteSourceIndexRepository(f.database, fieldContractSha256);
  const ready = buildReady({ database: f.database, records: f.field.fieldRepos.records, erase: f.field.fieldRepos.erase, index });
  const runtime = { database: f.database }, caller = { workspace_id: WS, as_of: CLOCK };
  const lease = issueSemanticLease(runtime, { ...caller, principal: "", kind: "query", authorized: ["project"],
    revision: sourceSemanticRevision(runtime), expires_at: "2026-09-13T00:10:00Z" },
  new SourceSemanticReadBudget({ work_units: 10000, memory_bytes: 100000 }));
  expect(readSemanticLease(runtime, caller, lease, ["project"], "query")).toBeDefined();
  const replacement = request({ source_version: "2", recorded_at: "2026-09-13T00:00:01Z",
    host_occurrences: [{ ...occurrence, role: "assistant" }] });
  const writer = createAuditedSourceReplacement(f.input);
  const changed = await writer.replaceCurrent({ expected_current: retained, replacement }, context);
  expect(changed.status).toBe("committed_projection_deferred");
  expect(index.generation(WS, ready.generation.generation_id)?.status).toBe("partial");
  expect(f.database.connection.prepare("SELECT * FROM source_index_text").all()).toEqual([]);
  expect(f.database.connection.prepare("SELECT * FROM source_index_vectors").all()).toEqual([]);
  expect(() => readSemanticLease(runtime, caller, lease, ["project"], "query")).toThrow(/no longer current/);
  expect(projectSourceFormationSnapshot({ workspaceId: WS, stores: f.field.stores })).not.toEqual(before);
  expect(read(f, retained).status).toBe("unavailable");
  expect((await writer.replaceCurrent({ expected_current: retained, replacement }, context)).status).toBe("rejected");
  const count = f.field.stores.listRecords(WS).length;
  await expect(f.admission.admit(request({ source_id: "bad", spans: [
    { start_offset: 0, end_offset: 4, purpose: "line" }] }), context)).rejects.toThrow(/UTF-8/);
  expect(f.field.stores.listRecords(WS)).toHaveLength(count);
  expect(f.database.connection.prepare("SELECT count(*) AS n FROM source_host_inventories").get()).toEqual({ n: 2 });
});

it("requires a new revision for legacy-source enrichment and withdraws the old prepared index eligibility", async () => {
  const f = fixture();
  const legacy = await f.admission.admit(request({ host_occurrences: undefined }), { workspaceId: WS });
  expect(read(f, legacy.record).status).toBe("unknown");
  const index = new SqliteSourceIndexRepository(f.database, fieldContractSha256);
  const ready = buildReady({ database: f.database, records: f.field.fieldRepos.records, erase: f.field.fieldRepos.erase, index });
  await expect(f.admission.admit(request(), context)).rejects.toThrow();
  expect(read(f, legacy.record).status).toBe("unknown");
  expect(index.generation(WS, ready.generation.generation_id)?.status).toBe("ready");
  const runtime = { database: f.database }, caller = { workspace_id: WS, as_of: CLOCK };
  const lease = issueSemanticLease(runtime, { ...caller, principal: "", kind: "query", authorized: ["project"],
    revision: sourceSemanticRevision(runtime), expires_at: "2026-09-13T00:10:00Z" },
  new SourceSemanticReadBudget({ work_units: 10000, memory_bytes: 100000 }));
  const changed = await createAuditedSourceReplacement(f.input).replaceCurrent({ expected_current: legacy.record,
    replacement: request({ source_version: "2", recorded_at: "2026-09-13T00:00:01Z" }) }, context);
  expect(changed.status).toBe("committed_projection_deferred");
  const current = f.field.stores.getCurrentRecord(WS, "record")!;
  expect(current.identity).not.toBe(legacy.record.identity);
  expect(current.content_digest).toBe(legacy.record.content_digest);
  expect(read(f, current).inventory?.occurrences).toEqual(request().host_occurrences);
  expect(index.generation(WS, ready.generation.generation_id)).toMatchObject({ status: "partial", completed_count: 0 });
  expect(f.database.connection.prepare("SELECT * FROM source_index_text").all()).toEqual([]);
  expect(f.database.connection.prepare("SELECT * FROM source_index_vectors").all()).toEqual([]);
  expect(() => readSemanticLease(runtime, caller, lease, ["project"], "query")).toThrow(/no longer current/);
});

it("preserves exact inventory through close/reopen and SQLite copy, then scrubs payload without resurrection", async () => {
  const f = fixture(), first = await f.admission.admit(request(), context);
  f.database.close({ optimize: false }); closeCachedDatabase(f.filename);
  const copy = join(f.directory, "copy.sqlite"); copyFileSync(f.filename, copy);
  const reopened = open(f.filename), copied = open(copy);
  expect(read(reopened, first.record)).toEqual(read(copied, first.record));
  const { host_occurrences: _capture, ...fields } = request();
  const replay = { ...fields, host_structure: first.record.host_structure! };
  expect((await copied.admission.admit(replay, { workspaceId: WS })).record).toEqual(first.record);
  const inventory = read(copied, first.record);
  expect(inventory.status).toBe("captured"); expect(inventory.inventory?.occurrences).toHaveLength(2);
  expect(read(copied, first.record, { nativeByteLimit: 7863, workLimit: 262144, memoryLimit: 262144 }))
    .toEqual({ status: "resource_limited", nativeBytes: 0, work: 0, memory: 0 });
  expect(copied.field.fieldRepos.records.readHostInventory({ workspaceId: WS, recordId: first.record.identity,
    sourceVersion: "wrong", contentDigest: first.record.content_digest, authorizedScopes: null,
    nativeByteLimit: 131072, workLimit: 262144, memoryLimit: 262144 }).status).toBe("unavailable");
  copied.field.fieldRepos.erase.apply({ barrier_id: "erase-host", workspace_id: WS, generation_id: null,
    subject_kind: "source_record", subject_id: first.record.identity, erased_at: CLOCK });
  expect(copied.field.fieldRepos.records.findById(WS, first.record.identity)?.host_structure).toEqual(first.record.host_structure);
  expect(copied.field.stores.getHostInventory(WS, first.record.identity)).toBeNull();
  expect(read(copied, first.record).status).toBe("unavailable");
  await expect(copied.admission.admit(replay, { workspaceId: WS })).rejects.toThrow();
  await expect(copied.admission.admit(request(), context)).rejects.toThrow();
  expect(copied.field.stores.getHostInventory(WS, first.record.identity)).toBeNull();
  expect(read(reopened, first.record).status).toBe("captured");
});

it("reports known empty, unknown, over-budget and corrupt payload distinctly without body hydration", async () => {
  const f = fixture();
  const empty = await f.admission.admit(request({ source_id: "empty", host_occurrences: [] }), context);
  const unknown = await f.admission.admit(request({ source_id: "unknown", host_occurrences: undefined }), { workspaceId: WS });
  expect(read(f, empty.record).inventory?.occurrences).toEqual([]);
  expect(read(f, unknown.record).status).toBe("unknown");
  const occurrences: HostOccurrence[] = Array.from({ length: 40 }, (_, i) => ({ ...occurrence,
    occurrence_id: `empty-${i}`, utf8_span: [0, 0], role: "r".repeat(1024), channel: null }));
  const size = () => Buffer.byteLength(canonicalJson({ contract: "host-occurrence-v1",
    issuer: context.hostCapture!(request()), occurrences }));
  for (let i = 0; size() < 65536 && i < occurrences.length; i++) {
    occurrences[i] = { ...occurrences[i]!, channel: "x".repeat(Math.min(1024, 65536 - size() + 2)) };
  }
  expect(size()).toBe(65536);
  const large = await f.admission.admit(request({ source_id: "large", host_occurrences: occurrences }), context);
  expect(large.record.host_structure?.encoded_bytes).toBe(65536);
  const limited = read(f, large.record, { nativeByteLimit: 65536, workLimit: 262144, memoryLimit: 262144 });
  expect(limited.status).toBe("resource_limited"); expect(limited.nativeBytes).toBeLessThan(7864);
  expect(read(f, large.record).status).toBe("captured");
  f.database.connection.prepare("UPDATE source_host_inventories SET canonical_inventory = replace(canonical_inventory, 'structured-fixture', 'unverified-fixture') WHERE record_id = ?")
    .run(empty.record.identity);
  expect(read(f, empty.record).status).toBe("invalid");
  f.database.connection.prepare("DELETE FROM source_host_inventories WHERE record_id = ?").run(empty.record.identity);
  expect(read(f, empty.record).status).toBe("unavailable");
  f.database.connection.prepare("UPDATE source_host_inventories SET canonical_inventory = '{}' WHERE record_id = ?").run(large.record.identity);
  expect(read(f, large.record).status).toBe("invalid");
});
