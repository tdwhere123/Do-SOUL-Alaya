import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterAll(() => isolation.restore());

import BetterSqlite3 from "better-sqlite3";
import {
  createAuditedSourceAdmission, createAuditedSourceReplacement, fieldContractSha256,
  projectSourceFormationSnapshot, type SourceReplacementOutcome
} from "@do-soul/alaya-core";
import { FieldGenerationEventType, hashContentDigest, hashSourceRecordId,
  type SourceAdmissionRequest, type SourceRecordIdentity } from "@do-soul/alaya-protocol";
import { closeCachedDatabase, initDatabase, SqliteEventLogRepo, StorageDatabase } from "@do-soul/alaya-storage";
import { seedWorkspaces } from "../../../../../../packages/storage/src/__tests__/repos/field/field-contract-fixture.js";
import type { FieldProjectionAdmissionMode } from "../../../runtime/field/admission-mode.js";
import { createDaemonFieldComposition } from "../../../runtime/field/field-composition.js";
import { createSqliteFieldFormationStores } from "../../../runtime/field/sqlite-field-formation-stores.js";
import { createProjectionRebuildingFieldStores } from "../../../runtime/field/projection-rebuilding-field-stores.js";

const CLOCK = "2026-09-13T00:00:00.000Z", LATER = "2026-09-13T00:00:01.000Z";
const WORKSPACE = "workspace-a", context = { workspaceId: WORKSPACE };
const handles: StorageDatabase[] = [], directories: string[] = [];
afterEach(() => {
  for (const database of handles.splice(0).reverse()) {
    database.close({ optimize: false });
    closeCachedDatabase(database.filename);
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  expect(isolation.violations).toEqual([]);
});

function sourceRequest(overrides: Partial<SourceAdmissionRequest> = {}): SourceAdmissionRequest {
  return { workspace_id: WORKSPACE, source_id: "message", source_version: "1", content_bytes: "A café record.",
    evidence_object_id: null, recorded_at: CLOCK, event_time: "2026-01-01T00:00:00Z", valid_from: null, valid_to: null,
    scope_class: "project", speaker: "user", source_representation: { kind: "original_body" },
    spans: [{ start_offset: 0, end_offset: 1, purpose: "native_structure" }], ...overrides };
}
const nextRequest = (overrides: Partial<SourceAdmissionRequest> = {}) => sourceRequest({
  source_version: "2", content_bytes: "A café record. Revised.", recorded_at: LATER, ...overrides
});
function bind(database: StorageDatabase, mode: FieldProjectionAdmissionMode) {
  const eventLogRepo = new SqliteEventLogRepo(database);
  const field = createDaemonFieldComposition({ database, eventLogRepo, fieldProjectionAdmissionMode: mode });
  const input = { stores: field.stores, eventLogRepo, sha256: fieldContractSha256, runtimeNotifier: { notifyEntry: vi.fn() } };
  return { database, eventLogRepo, field, input,
    admission: createAuditedSourceAdmission(input), writer: createAuditedSourceReplacement(input) };
}
function fixture(mode: FieldProjectionAdmissionMode = "immediate") {
  const directory = mkdtempSync(join(tmpdir(), "audited-source-replacement-"));
  directories.push(directory);
  const filename = join(directory, "alaya.db"), database = initDatabase({ filename });
  handles.push(database);
  seedWorkspaces(database, [WORKSPACE]);
  // initDatabase caches handles: open the peer explicitly to prove two connections.
  const connection = new BetterSqlite3(filename, { fileMustExist: true });
  connection.pragma("foreign_keys = ON");
  connection.pragma("busy_timeout = 5");
  const peer = new StorageDatabase(filename, connection);
  handles.push(peer);
  expect(peer.connection).not.toBe(database.connection);
  return { ...bind(database, mode), peer: bind(peer, mode) };
}
function sourceAudits(database: StorageDatabase): number {
  const row = database.connection.prepare("SELECT count(*) AS n FROM event_log WHERE event_type = ?")
    .get(FieldGenerationEventType.SOUL_FIELD_SOURCE_RECORD_ADMITTED) as { n: number };
  return row.n;
}
function expectHistory(database: StorageDatabase, predecessor: SourceRecordIdentity, revision: string) {
  expect(database.connection.prepare("SELECT source_body, source_version, event_time, recorded_at FROM source_records WHERE record_id = ?")
    .get(predecessor.identity)).toEqual({ source_body: "A café record.", source_version: "1", event_time: "2026-01-01T00:00:00Z", recorded_at: CLOCK });
  const rows = database.connection.prepare("SELECT source_version FROM source_records WHERE workspace_id = ? AND source_id = ? ORDER BY source_version")
    .all(WORKSPACE, "message");
  expect(rows).toEqual(revision === "1" ? [{ source_version: "1" }] : [{ source_version: "1" }, { source_version: revision }]);
}

describe("file-backed source replacement transaction and effects", () => {
  it("retains the old frontier until an explicit checkpoint publishes the committed replacement", async () => {
    const f = fixture("explicit_checkpoint"), first = await f.admission.admit(sourceRequest(), context);
    await f.field.fieldProjectionCheckpoint.refresh();
    const active = f.field.fieldRepos.generations.readActive(WORKSPACE);
    expect(active).not.toBeNull();
    const result = await f.writer.replaceCurrent({ expected_current: first.record, replacement: nextRequest() }, context);
    expect(result.status).toBe("committed_projection_deferred");
    if (result.status !== "committed_projection_deferred") throw new Error("committed deferred transition required");
    expect(result.transition.predecessor).toEqual(first.record);
    expect(result.transition.replacement.record.source_version).toBe("2");
    expect(result.audit_entry.entity_id).toBe(result.transition.replacement.record.identity);
    expect(sourceAudits(f.peer.database)).toBe(2);
    expect(f.input.runtimeNotifier.notifyEntry).toHaveBeenCalledTimes(2);
    expect(f.peer.field.fieldRepos.generations.readActive(WORKSPACE)).toEqual(active);
    expect(f.peer.database.connection.prepare("SELECT workspace_id FROM field_projection_rebuild_requests").all())
      .toEqual([{ workspace_id: WORKSPACE }]);
    const committed = projectSourceFormationSnapshot({ workspaceId: WORKSPACE, stores: f.field.stores });
    expect(committed.input_event_frontier).not.toBe(active!.input_event_frontier);

    await f.field.fieldProjectionCheckpoint.refresh();
    const refreshed = f.peer.field.fieldRepos.generations.readActive(WORKSPACE);
    expect(refreshed?.input_event_frontier).toBe(committed.input_event_frontier);
    expect(refreshed?.generation_id).not.toBe(active!.generation_id);
    expect(f.peer.database.connection.prepare("SELECT workspace_id FROM field_projection_rebuild_requests").all()).toEqual([]);
    expect(f.peer.field.stores.getCurrentRecord(WORKSPACE, "message")).toEqual(result.transition.replacement.record);
    expect(f.peer.field.stores.getStoredRecord(WORKSPACE, result.transition.replacement.record.identity)?.content_bytes)
      .toBe("A café record. Revised.");
    expect(result.status).toBe("committed_projection_deferred");
  });

  it("commits at most one of two connections replacing the same exact predecessor", async () => {
    const f = fixture(), first = await f.admission.admit(sourceRequest(), context);
    const attempts = await Promise.all([
      f.writer.replaceCurrent({ expected_current: first.record, replacement: nextRequest() }, context),
      f.peer.writer.replaceCurrent({ expected_current: first.record, replacement: nextRequest({ source_version: "competing" }) }, context)
    ]);
    expect(attempts.map(result => result.status).sort()).toEqual(["ready", "rejected"]);
    const winner = attempts.find(result => result.status === "ready");
    if (winner?.status !== "ready") throw new Error("one committed transition required");
    expect(winner.transition.predecessor).toEqual(first.record);
    expect(winner.transition.replacement.record.source_version).toBe("2");
    expect(f.peer.field.stores.getCurrentRecord(WORKSPACE, "message")?.identity).toBe(winner.transition.replacement.record.identity);
    expectHistory(f.peer.database, first.record, "2");
    expect(f.peer.database.connection.prepare("SELECT count(*) AS n FROM source_spans").get()).toEqual({ n: 2 });
    expect(sourceAudits(f.peer.database)).toBe(2);
    expect(winner.audit_entry.payload_json).not.toHaveProperty("predecessor");
  });

  it("uses the SQLite write lock rather than an in-process lock when attempts overlap", async () => {
    const f = fixture(), first = await f.admission.admit(sourceRequest(), context);
    let contending!: Promise<SourceReplacementOutcome>;
    const hook = vi.fn(() => {
      contending = f.peer.writer.replaceCurrent({ expected_current: first.record, replacement: nextRequest({ source_version: "competing" }) }, context);
    });
    const writer = createAuditedSourceReplacement({ ...f.input, admitHook: hook });
    const winner = await writer.replaceCurrent({ expected_current: first.record, replacement: nextRequest() }, context);
    const loser = await contending;
    expect(winner.status).toBe("ready");
    expect(loser).toMatchObject({ status: "rejected", cause: { code: "SQLITE_BUSY" } });
    expect(hook).toHaveBeenCalledOnce();
    expectHistory(f.peer.database, first.record, "2");
    expect(sourceAudits(f.peer.database)).toBe(2);
  });

  it.each([
    ["UTF-8 span", { spans: [{ start_offset: 0, end_offset: 1, purpose: "native_structure" },
      { start_offset: 0, end_offset: 6, purpose: "native_structure" }] }],
    ["evidence binding", { evidence_object_id: "missing-capsule" }],
    ["attribution", { attribution_context: null }],
    ["representation", { source_representation: { kind: "canonical_projection", source_record_ids: [`sha256:${"f".repeat(64)}`] } }]
  ] satisfies readonly (readonly [string, Partial<SourceAdmissionRequest>])[])("rolls back %s rejection, including record and earlier spans", async (_name, changed) => {
    const f = fixture(), first = await f.admission.admit(sourceRequest(), context);
    const result = await f.writer.replaceCurrent({ expected_current: first.record, replacement: nextRequest(changed) }, context);
    expect(result.status).toBe("rejected");
    expect(result).not.toHaveProperty("transition");
    expectHistory(f.peer.database, first.record, "1");
    expect(f.peer.field.stores.listSpans(WORKSPACE)).toEqual(first.spans);
    expect(sourceAudits(f.peer.database)).toBe(1);
    expect(f.input.runtimeNotifier.notifyEntry).toHaveBeenCalledOnce();
  });

  it("retains the existing scope and erasure checks instead of bypassing admission", async () => {
    const f = fixture(), first = await f.admission.admit(sourceRequest(), context);
    const foreign = await f.admission.admit(sourceRequest({ source_id: "other-scope", scope_class: "global_core" }), context);
    const projection = await f.writer.replaceCurrent({ expected_current: first.record, replacement: nextRequest({
      source_representation: { kind: "canonical_projection", source_record_ids: [foreign.record.identity] }
    }) }, context);
    expect(projection).toMatchObject({ status: "rejected", cause: { message: expect.stringContaining("same workspace and scope") } });
    const replacement = nextRequest();
    const erasedId = hashSourceRecordId({ ...replacement, content_digest: hashContentDigest(replacement.content_bytes, fieldContractSha256) }, fieldContractSha256);
    f.field.fieldRepos.erase.apply({ workspace_id: WORKSPACE, barrier_id: "replacement-erase-barrier", generation_id: null,
      subject_kind: "source_record", subject_id: erasedId, erased_at: LATER });
    expect((await f.writer.replaceCurrent({ expected_current: first.record, replacement }, context)).status).toBe("rejected");
    expectHistory(f.peer.database, first.record, "1");
    expect(sourceAudits(f.peer.database)).toBe(2);
  });

  it("preserves a committed transition when the subsequent projection rebuild fails", async () => {
    const f = fixture(), first = await f.admission.admit(sourceRequest(), context);
    await f.field.fieldProjectionCheckpoint.refresh();
    const active = f.field.fieldRepos.generations.readActive(WORKSPACE);
    const drainPending = vi.fn(() => { throw new Error("projection flush unavailable"); });
    const stores = createProjectionRebuildingFieldStores({
      delegate: createSqliteFieldFormationStores({ database: f.database, repos: f.field.fieldRepos }),
      lifecycle: { ...f.field.projectionLifecycle, drainPending }
    });
    const append = vi.fn(f.eventLogRepo.append.bind(f.eventLogRepo)), notifyEntry = vi.fn();
    const writer = createAuditedSourceReplacement({ ...f.input, stores, eventLogRepo: { append }, runtimeNotifier: { notifyEntry } });
    const result = await writer.replaceCurrent({ expected_current: first.record, replacement: nextRequest() }, context);
    expect(result).toMatchObject({ status: "committed_projection_unready", cause: { message: "projection flush unavailable" } });
    if (result.status !== "committed_projection_unready") throw new Error("postcommit phase evidence required");
    expect(result.transition.predecessor).toEqual(first.record);
    expect(result.transition.replacement.record.source_version).toBe("2");
    expectHistory(f.peer.database, first.record, "2");
    expect(f.peer.field.fieldRepos.generations.readActive(WORKSPACE)).toEqual(active);
    expect(f.peer.database.connection.prepare("SELECT workspace_id FROM field_projection_rebuild_requests").all()).toEqual([{ workspace_id: WORKSPACE }]);
    expect(append).not.toHaveBeenCalled();
    expect(notifyEntry).not.toHaveBeenCalled();
    expect(drainPending).toHaveBeenCalledOnce();
  });

  it.each([
    ["before_append", "immediate"], ["after_append", "immediate"], ["notification", "immediate"],
    ["before_append", "explicit_checkpoint"], ["after_append", "explicit_checkpoint"], ["notification", "explicit_checkpoint"]
  ] as const)("preserves commit and distinguishes %s failure under %s admission", async (phase, mode) => {
    const f = fixture(mode), first = await f.admission.admit(sourceRequest(), context);
    const append = vi.fn<Parameters<typeof createAuditedSourceReplacement>[0]["eventLogRepo"]["append"]>(event => {
      if (phase === "before_append") throw new Error("audit append refused");
      const entry = f.eventLogRepo.append(event);
      if (phase === "after_append") throw new Error("audit response lost");
      return entry;
    });
    const notifyEntry = vi.fn(() => {
      expectHistory(f.peer.database, first.record, "2");
      expect(sourceAudits(f.peer.database)).toBe(2);
      throw new Error("notification failed");
    });
    const writer = createAuditedSourceReplacement({ ...f.input, eventLogRepo: { append }, runtimeNotifier: { notifyEntry } });
    const result = await writer.replaceCurrent({ expected_current: first.record, replacement: nextRequest() }, context);
    expect(result.status).toBe(phase === "notification" ? "committed_notification_failed" : "committed_audit_incomplete");
    if (result.status === "committed_audit_incomplete") expect(result.audit).toBe("unknown");
    if (result.status === "committed_notification_failed") expect(result.audit_entry.entity_id).toBe(result.transition.replacement.record.identity);
    expectHistory(f.peer.database, first.record, "2");
    expect(sourceAudits(f.peer.database)).toBe(phase === "before_append" ? 1 : 2);
    expect(append).toHaveBeenCalledOnce();
    expect(notifyEntry).toHaveBeenCalledTimes(phase === "notification" ? 1 : 0);
  });

  it("preserves the historical transition when a peer supersedes the replacement during audit", async () => {
    const f = fixture(), first = await f.admission.admit(sourceRequest(), context);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const writer = createAuditedSourceReplacement({ ...f.input, eventLogRepo: { async append(event) {
      await gate;
      return f.eventLogRepo.append(event);
    } } });
    const pending = writer.replaceCurrent({ expected_current: first.record, replacement: nextRequest() }, context);
    const third = await f.peer.admission.admit(nextRequest({ source_version: "3", recorded_at: "2026-09-13T00:00:02.000Z" }), context);
    release();
    const result = await pending;
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("historical transition required");
    expect(result.transition.predecessor).toEqual(first.record);
    expect(result.transition.replacement.record.source_version).toBe("2");
    expect(result.audit_entry.entity_id).toBe(result.transition.replacement.record.identity);
    expect(f.field.stores.getCurrentRecord(WORKSPACE, "message")).toEqual(third.record);
    expect(f.peer.database.connection.prepare("SELECT source_version, source_body FROM source_records WHERE record_id = ?")
      .get(first.record.identity)).toEqual({ source_version: "1", source_body: "A café record." });
  });

  it("does not report COMMIT failure as a callback rollback or fabricate transition authorship", async () => {
    const f = fixture(), first = await f.admission.admit(sourceRequest(), context);
    f.database.connection.exec(`CREATE TABLE replacement_parent (id INTEGER PRIMARY KEY);
      CREATE TABLE replacement_commit_guard (parent INTEGER REFERENCES replacement_parent(id) DEFERRABLE INITIALLY DEFERRED);`);
    const writer = createAuditedSourceReplacement({ ...f.input, admitHook() {
      f.database.connection.prepare("INSERT INTO replacement_commit_guard (parent) VALUES (1)").run();
    } });
    const result = await writer.replaceCurrent({ expected_current: first.record, replacement: nextRequest() }, context);
    expect(result).toMatchObject({ status: "unknown", cause: { code: "SQLITE_CONSTRAINT_FOREIGNKEY" } });
    expect(result).not.toHaveProperty("transition");
    expectHistory(f.peer.database, first.record, "1");
    expect(f.peer.database.connection.prepare("SELECT count(*) AS n FROM replacement_commit_guard").get()).toEqual({ n: 0 });
    expect(sourceAudits(f.peer.database)).toBe(1);
  });
});
