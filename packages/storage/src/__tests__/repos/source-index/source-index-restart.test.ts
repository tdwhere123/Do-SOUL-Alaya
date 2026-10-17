import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initDatabase, type StorageDatabase } from "../../../sqlite/db.js";
import { openReadOnlyDatabase } from "../../../sqlite/open-readonly.js";
import { SqliteFieldEraseBarrierRepo } from "../../../repos/field/erase-repo.js";
import { SqliteFieldSourceRecordRepo } from "../../../repos/field/source-repo.js";
import { SqliteSourceIndexRepository } from "../../../repos/source-index/source-index-repo.js";
import {
  BUDGET, WORKSPACE, buildReady, captureDocuments, configuration, fieldPointer, fieldSha256, fixture,
  ftsMatches, lexicalRows, publishSource, vectorFor, writeVectors, type Fixture
} from "./source-index-fixture.js";

const databases: StorageDatabase[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function fileFixture() {
  const directory = mkdtempSync(join(tmpdir(), "source-index-restart-"));
  directories.push(directory);
  const environment = fixture(join(directory, "source.sqlite"));
  databases.push(environment.database);
  return environment;
}
function reopen(environment: Fixture): Fixture {
  environment.database.close({ optimize: false });
  const database = initDatabase({ filename: environment.database.filename });
  databases.push(database);
  return { database, index: new SqliteSourceIndexRepository(database, fieldSha256),
    records: new SqliteFieldSourceRecordRepo(database, fieldSha256),
    erase: new SqliteFieldEraseBarrierRepo(database, fieldSha256) };
}
function readOnly(environment: Fixture) {
  environment.database.close({ optimize: false });
  const database = openReadOnlyDatabase(environment.database.filename);
  databases.push(database);
  return { database, index: new SqliteSourceIndexRepository(database, fieldSha256) };
}

const payloadTables = ["source_index_text", "source_index_windows", "source_index_vectors"] as const;
const payloadLosses = payloadTables.flatMap(table => (["before activation", "after ready"] as const).map(phase => ({ table, phase })));

describe("persisted Source index payload loss and explicit recovery", () => {
  it.each(payloadLosses)("revokes coverage for $table $phase and restores the same generation only by explicit activation", ({ table, phase }) => {
    let environment = fileFixture();
    publishSource(environment, "recoverable body");
    publishSource(environment, "independent body", "source-a", { workspace_id: "workspace-2" });
    const other = buildReady(environment, configuration(), "workspace-2");
    const field = fieldPointer(environment.database);
    const generation = environment.index.begin(environment.index.select(WORKSPACE, configuration()));
    const [document] = captureDocuments(environment, generation);
    if (document === undefined) throw new Error("expected recoverable native source");
    writeVectors(environment, generation, [document]);
    expect(document.windows.map(window => window.text)).toEqual(["recovera", "ble body"]);
    if (phase === "after ready") expect(environment.index.activate(WORKSPACE, generation.generation_id)).toEqual({ status: "accepted" });
    const pointer = phase === "after ready" ? generation.generation_id : null;
    const epoch = environment.database.connection.prepare("SELECT epoch FROM source_index_epochs WHERE workspace_id=?").get(WORKSPACE);
    const otherPayload = payloadTables.map(name => environment.database.connection.prepare(
      `SELECT * FROM ${name} WHERE workspace_id=? ORDER BY root_key`).all("workspace-2"));
    const membership = () => environment.database.connection.prepare(`SELECT root_key,expected_windows,complete
      FROM source_index_targets WHERE workspace_id=? AND generation_id=? ORDER BY root_key`).all(WORKSPACE, generation.generation_id);
    const expectIndependent = () => {
      expect(environment.database.connection.prepare("SELECT epoch FROM source_index_epochs WHERE workspace_id=?").get(WORKSPACE)).toEqual(epoch);
      expect(environment.database.connection.prepare("SELECT * FROM projection_generation_pointer WHERE workspace_id=?").get(WORKSPACE)).toEqual(field.pointer);
      expect(environment.index.generation("workspace-2", other.generation.generation_id)).toEqual(other.generation);
      expect(environment.index.state("workspace-2")).toEqual({ status: "ready", selection: other.generation.selection,
        active_generation_id: other.generation.generation_id });
      expect(payloadTables.map(name => environment.database.connection.prepare(
        `SELECT * FROM ${name} WHERE workspace_id=? ORDER BY root_key`).all("workspace-2"))).toEqual(otherPayload);
    };
    expect(membership()).toEqual([{ root_key: document.source.root_key, expected_windows: 2, complete: 1 }]);
    expect(environment.index.generation(WORKSPACE, generation.generation_id)).toMatchObject({ target_count: 1, completed_count: 1 });
    // Negative loss injection only; initial publication and every recovery write use the repository owners.
    expect(environment.database.connection.prepare(`DELETE FROM ${table} WHERE workspace_id=? AND root_key=?`)
      .run(WORKSPACE, document.source.root_key).changes).toBe(table === "source_index_text" ? 1 : 2);
    expect(membership()).toEqual([{ root_key: document.source.root_key, expected_windows: 2, complete: 0 }]);
    const damaged = environment.index.generation(WORKSPACE, generation.generation_id);
    expect(damaged).toMatchObject({ source_epoch: generation.source_epoch, enumeration_complete: true,
      target_count: 1, completed_count: 0, status: phase === "after ready" ? "partial" : "building",
      reason: phase === "after ready" ? "payload_incomplete" : null });
    expect(environment.index.state(WORKSPACE)).toEqual({ status: phase === "after ready" ? "partial" : "building",
      selection: generation.selection, active_generation_id: pointer });
    expect(environment.index.activate(WORKSPACE, generation.generation_id)).toEqual({ status: "rejected", reason: "incomplete" });
    expectIndependent();
    environment = reopen(environment);
    expect(environment.index.generation(WORKSPACE, generation.generation_id)).toEqual(damaged);
    expect(environment.index.begin(generation.selection)).toEqual(damaged);
    expect(membership()).toEqual([{ root_key: document.source.root_key, expected_windows: 2, complete: 0 }]);
    expect(environment.database.connection.prepare(`SELECT root_key FROM ${table} WHERE workspace_id=?`).all(WORKSPACE)).toEqual([]);
    expect(environment.index.activate(WORKSPACE, generation.generation_id)).toEqual({ status: "rejected", reason: "incomplete" });
    expect(environment.index.state(WORKSPACE)).toMatchObject({ active_generation_id: pointer,
      status: phase === "after ready" ? "partial" : "building" });
    expectIndependent();
    if (table === "source_index_text") {
      const lexical = environment.index.writeLexical(document.source, document.body, BUDGET);
      expect(lexical).toEqual({ status: "accepted", resources: { work: 6, native_bytes: expect.any(Number) } });
      expect(lexical.resources.native_bytes).toBeGreaterThan(0);
      expect(lexical.resources.native_bytes).toBeLessThanOrEqual(BUDGET.native_bytes);
      expect(ftsMatches(environment.database, "recoverable")).toHaveLength(1);
    }
    const write = environment.index.writeDocument(WORKSPACE, generation.generation_id, document, BUDGET);
    expect(write).toEqual({ status: "accepted", resources: { work: 6, native_bytes: expect.any(Number) } });
    expect(write.resources.native_bytes).toBeGreaterThan(0);
    expect(write.resources.native_bytes).toBeLessThanOrEqual(BUDGET.native_bytes);
    writeVectors(environment, generation, [document]);
    expect(environment.index.begin(generation.selection)).toMatchObject({ generation_id: generation.generation_id, source_epoch: generation.source_epoch });
    expect(membership()).toEqual([{ root_key: document.source.root_key, expected_windows: 2, complete: 1 }]);
    expect(environment.index.listTargets(WORKSPACE, generation.generation_id, null, 8)).toEqual([document.source]);
    expect(payloadTables.map(name => environment.database.connection.prepare(
      `SELECT COUNT(*) AS count FROM ${name} WHERE workspace_id=?`).get(WORKSPACE))).toEqual([{ count: 1 }, { count: 2 }, { count: 2 }]);
    expect(lexicalRows(environment.database)).toEqual([{ root_key: document.source.root_key, body: "recoverable body", body_bytes: 16 }]);
    expect(environment.database.connection.prepare(`SELECT ordinal,start_byte,end_byte,body FROM source_index_windows
      WHERE workspace_id=? AND generation_id=? ORDER BY ordinal`).all(WORKSPACE, generation.generation_id)).toEqual([
      { ordinal: 0, start_byte: 0, end_byte: 8, body: "recovera" },
      { ordinal: 1, start_byte: 8, end_byte: 16, body: "ble body" }
    ]);
    // Restored coverage does not silently republish a partial pointer.
    expect(environment.index.generation(WORKSPACE, generation.generation_id)).toMatchObject({ target_count: 1, completed_count: 1,
      status: phase === "after ready" ? "partial" : "building" });
    expect(environment.index.state(WORKSPACE)).toMatchObject({ active_generation_id: pointer,
      status: phase === "after ready" ? "partial" : "building" });
    expectIndependent();
    expect(environment.index.activate(WORKSPACE, generation.generation_id)).toEqual({ status: "accepted" });
    environment = reopen(environment);
    expect(environment.index.state(WORKSPACE)).toEqual({ status: "ready", selection: generation.selection, active_generation_id: generation.generation_id });
    expect(environment.index.generation(WORKSPACE, generation.generation_id)).toMatchObject({ status: "ready", reason: null,
      source_epoch: generation.source_epoch, target_count: 1, completed_count: 1 });
    expect(membership()).toEqual([{ root_key: document.source.root_key, expected_windows: 2, complete: 1 }]);
    expectIndependent();
  });

  it.each(payloadTables)("rolls back %s loss together with coverage and ready state across reopen", table => {
    let environment = fileFixture();
    publishSource(environment, "recoverable body");
    const ready = buildReady(environment);
    const before = payloadTables.map(name => environment.database.connection.prepare(`SELECT * FROM ${name}`).all());
    const epoch = environment.database.connection.prepare("SELECT * FROM source_index_epochs").all();
    const abort = new Error("abort payload loss transaction");
    expect(() => environment.database.connection.transaction(() => {
      expect(environment.database.connection.prepare(`DELETE FROM ${table} WHERE workspace_id=?`).run(WORKSPACE).changes)
        .toBe(table === "source_index_text" ? 1 : 2);
      expect(environment.index.generation(WORKSPACE, ready.generation.generation_id)).toMatchObject({ status: "partial",
        reason: "payload_incomplete", completed_count: 0 });
      expect(environment.index.state(WORKSPACE)).toMatchObject({ status: "partial", active_generation_id: ready.generation.generation_id });
      throw abort;
    })()).toThrow(abort);
    environment = reopen(environment);
    expect(payloadTables.map(name => environment.database.connection.prepare(`SELECT * FROM ${name}`).all())).toEqual(before);
    expect(environment.database.connection.prepare("SELECT * FROM source_index_epochs").all()).toEqual(epoch);
    expect(environment.database.connection.prepare("SELECT expected_windows,complete FROM source_index_targets").all())
      .toEqual([{ expected_windows: 2, complete: 1 }]);
    expect(environment.index.generation(WORKSPACE, ready.generation.generation_id)).toEqual(ready.generation);
    expect(environment.index.state(WORKSPACE)).toEqual({ status: "ready", selection: ready.generation.selection,
      active_generation_id: ready.generation.generation_id });
    expect(ftsMatches(environment.database, "recoverable")).toHaveLength(1);
  });
});

describe("persisted Source index build and restart states", () => {
  it("resumes a bounded native cursor across fresh connections without duplicate membership", () => {
    let environment = fileFixture();
    const sources = ["a", "b", "c"].map(id => publishSource(environment, `body ${id}`, id));
    const selection = environment.index.select(WORKSPACE, configuration());
    const initial = environment.index.begin(selection);
    const first = environment.index.capturePage(WORKSPACE, initial.generation_id, 1, BUDGET);
    expect(first).toMatchObject({ added: 1, generation: { status: "partial", after_source_id: "a",
      enumeration_complete: false, target_count: 1, completed_count: 0, reason: "enumeration_page" } });
    expect(environment.index.state(WORKSPACE)).toMatchObject({ status: "partial", active_generation_id: null });
    environment = reopen(environment);
    expect(environment.index.begin(selection)).toEqual(first.generation);
    expect(environment.index.generation(WORKSPACE, initial.generation_id)).toEqual(first.generation);
    const second = environment.index.capturePage(WORKSPACE, initial.generation_id, 1, BUDGET);
    expect(second).toMatchObject({ added: 1, generation: { after_source_id: "b", enumeration_complete: false, target_count: 2 } });
    environment = reopen(environment);
    const last = environment.index.capturePage(WORKSPACE, initial.generation_id, 8, BUDGET);
    expect(last).toMatchObject({ added: 1, generation: { after_source_id: "c", enumeration_complete: true,
      target_count: 3, completed_count: 0, status: "building", reason: null } });
    const targets = environment.index.listTargets(WORKSPACE, initial.generation_id, null, 8);
    expect(targets.map(source => source.target.root_id).sort()).toEqual(sources.map(source => source.record_id).sort());
    expect(new Set(targets.map(source => source.root_key)).size).toBe(3);
    const [pageOne] = environment.index.listTargets(WORKSPACE, initial.generation_id, null, 1);
    expect(environment.index.listTargets(WORKSPACE, initial.generation_id, pageOne!.root_key, 8)).toEqual(targets.slice(1));
    expect(environment.index.capturePage(WORKSPACE, initial.generation_id, 8, BUDGET))
      .toEqual({ generation: last.generation, added: 0, resources: { work: 0, native_bytes: 0 } });
    const documents = captureDocuments(environment, initial);
    writeVectors(environment, initial, documents);
    expect(environment.index.activate(WORKSPACE, initial.generation_id)).toEqual({ status: "accepted" });
    const ready = environment.index.generation(WORKSPACE, initial.generation_id);
    expect(ready).toMatchObject({ status: "ready", target_count: 3, completed_count: 3, after_source_id: "c" });
    const readonly = readOnly(environment);
    expect(readonly.index.generation(WORKSPACE, initial.generation_id)).toEqual(ready);
    expect(readonly.index.state(WORKSPACE)).toEqual({ status: "ready", selection, active_generation_id: initial.generation_id });
    expect(readonly.index.listTargets(WORKSPACE, initial.generation_id, null, 8)).toEqual(targets);
  });

  it.each([
    ["zero work", { work: 0, native_bytes: BUDGET.native_bytes }],
    ["insufficient work", { work: 319, native_bytes: BUDGET.native_bytes }],
    ["zero native bytes", { work: BUDGET.work, native_bytes: 0 }],
    ["insufficient native bytes", { work: BUDGET.work, native_bytes: 262143 }]
  ] as const)("keeps %s enumeration partial after restart, never ready or valid-empty", (_name, budget) => {
    let environment = fileFixture();
    const source = publishSource(environment, "not an empty source population");
    const selection = environment.index.select(WORKSPACE, configuration());
    const generation = environment.index.begin(selection);
    const limited = environment.index.capturePage(WORKSPACE, generation.generation_id, 8, budget);
    expect(limited).toMatchObject({ added: 0, resources: { work: 0, native_bytes: 0 }, generation: {
      status: "partial", reason: "enumeration_budget", enumeration_complete: false,
      after_source_id: null, target_count: 0, completed_count: 0
    } });
    environment = reopen(environment);
    expect(environment.index.generation(WORKSPACE, generation.generation_id)).toEqual(limited.generation);
    expect(environment.index.listTargets(WORKSPACE, generation.generation_id, null, 8)).toEqual([]);
    expect(environment.index.activate(WORKSPACE, generation.generation_id)).toEqual({ status: "rejected", reason: "incomplete" });
    expect(environment.index.state(WORKSPACE)).toMatchObject({ status: "partial", active_generation_id: null });
    const documents = captureDocuments(environment, generation);
    expect(documents.map(document => document.source.target.root_id)).toEqual([source.record_id]);
    writeVectors(environment, generation, documents);
    expect(environment.index.activate(WORKSPACE, generation.generation_id)).toEqual({ status: "accepted" });
    expect(environment.index.state(WORKSPACE)).toMatchObject({ status: "ready", active_generation_id: generation.generation_id });
  });

  it("requires complete enumeration even for a genuinely empty native population", () => {
    let environment = fileFixture();
    expect(environment.index.state(WORKSPACE)).toEqual({ status: "unknown" });
    const selection = environment.index.select(WORKSPACE, configuration());
    expect(environment.index.state(WORKSPACE)).toEqual({ status: "unbound", selection, active_generation_id: null });
    const generation = environment.index.begin(selection);
    environment.index.capturePage(WORKSPACE, generation.generation_id, 8, { work: 0, native_bytes: 0 });
    environment = reopen(environment);
    expect(environment.index.activate(WORKSPACE, generation.generation_id)).toEqual({ status: "rejected", reason: "incomplete" });
    expect(environment.index.state(WORKSPACE)).toMatchObject({ status: "partial", active_generation_id: null });
    const completed = environment.index.capturePage(WORKSPACE, generation.generation_id, 8, BUDGET);
    expect(completed).toMatchObject({ added: 0, generation: { enumeration_complete: true, target_count: 0, completed_count: 0 } });
    expect(environment.index.activate(WORKSPACE, generation.generation_id)).toEqual({ status: "accepted" });
    const readonly = readOnly(environment);
    expect(readonly.index.generation(WORKSPACE, generation.generation_id)).toMatchObject({ status: "valid_empty", enumeration_complete: true });
    expect(readonly.index.state(WORKSPACE)).toEqual({ status: "valid_empty", selection, active_generation_id: generation.generation_id });
  });

  it("unbinds an old model immediately while lexical text survives restart and late results remain superseded", () => {
    let environment = fileFixture();
    publishSource(environment, "lexicalsurvives model switch");
    const old = buildReady(environment);
    const text = lexicalRows(environment.database);
    const next = environment.index.select(WORKSPACE, configuration({ model_id: "different-fixed-vector-model" }));
    expect(next.selection_revision).toBe(old.generation.selection.selection_revision + 1);
    expect(next.profile_id).not.toBe(old.generation.selection.profile_id);
    expect(environment.index.state(WORKSPACE)).toEqual({ status: "unbound", selection: next, active_generation_id: null });
    expect(environment.index.generation(WORKSPACE, old.generation.generation_id)).toMatchObject({ status: "retired", reason: "selection_changed" });
    environment = reopen(environment);
    expect(lexicalRows(environment.database)).toEqual(text);
    expect(ftsMatches(environment.database, "lexicalsurvives")).toHaveLength(1);
    expect(environment.index.writeDocument(WORKSPACE, old.generation.generation_id, old.documents[0]!, BUDGET))
      .toEqual({ status: "rejected", reason: "superseded", resources: { work: 0, native_bytes: 0 } });
    expect(environment.index.writeVector(WORKSPACE, old.generation.generation_id, vectorFor(old.documents[0]!.windows[0]!)))
      .toEqual({ status: "rejected", reason: "superseded" });
    expect(environment.index.activate(WORKSPACE, old.generation.generation_id)).toEqual({ status: "rejected", reason: "superseded" });
    expect(() => environment.index.begin(old.generation.selection)).toThrowError(expect.objectContaining({ code: "CONFLICT" }));
    environment.index.fail(WORKSPACE, old.generation.generation_id, "late_failure");
    expect(environment.index.generation(WORKSPACE, old.generation.generation_id)?.status).toBe("retired");
    const fresh = buildReady(environment, next.configuration);
    expect(fresh.generation.generation_id).not.toBe(old.generation.generation_id);
    expect(fresh.generation.selection).toEqual(next);
    expect(environment.index.state(WORKSPACE)).toEqual({ status: "ready", selection: next, active_generation_id: fresh.generation.generation_id });
    expect(lexicalRows(environment.database)).toEqual(text);
  });

  it("preserves failed progress distinctly and retries the same build without duplicate membership", () => {
    let environment = fileFixture();
    publishSource(environment, "retry retained vector input");
    const generation = environment.index.begin(environment.index.select(WORKSPACE, configuration()));
    const documents = captureDocuments(environment, generation);
    expect(environment.index.writeVector(WORKSPACE, generation.generation_id, vectorFor(documents[0]!.windows[0]!)))
      .toEqual({ status: "accepted" });
    environment.index.fail(WORKSPACE, generation.generation_id, "interrupted_worker");
    const failed = environment.index.generation(WORKSPACE, generation.generation_id);
    expect(failed).toMatchObject({ status: "failed", reason: "interrupted_worker", enumeration_complete: true,
      after_source_id: "source-a", target_count: 1, completed_count: 0 });
    environment = reopen(environment);
    expect(environment.index.generation(WORKSPACE, generation.generation_id)).toEqual(failed);
    expect(environment.index.state(WORKSPACE)).toMatchObject({ status: "failed", active_generation_id: null });
    expect(environment.index.writeVector(WORKSPACE, generation.generation_id, vectorFor(documents[0]!.windows[1]!)))
      .toEqual({ status: "rejected", reason: "incomplete" });
    expect(environment.index.activate(WORKSPACE, generation.generation_id)).toEqual({ status: "rejected", reason: "incomplete" });
    const retry = environment.index.begin(generation.selection);
    expect(retry).toEqual({ ...failed, status: "building", reason: null });
    expect(environment.index.capturePage(WORKSPACE, retry.generation_id, 8, BUDGET)).toMatchObject({ added: 0, generation: retry });
    expect(environment.index.listTargets(WORKSPACE, retry.generation_id, null, 8)).toHaveLength(1);
    writeVectors(environment, retry, documents);
    expect(environment.index.activate(WORKSPACE, retry.generation_id)).toEqual({ status: "accepted" });
    expect(environment.index.generation(WORKSPACE, retry.generation_id)).toMatchObject({ status: "ready", target_count: 1, completed_count: 1 });
  });

  it("separates a changed native epoch from a configuration switch and retires the old pointer only when replacement is ready", () => {
    let environment = fileFixture();
    publishSource(environment, "old native body");
    const old = buildReady(environment);
    environment = reopen(environment);
    const replacement = publishSource(environment, "current native body", "source-a", {
      source_version: "v2", recorded_at: "2026-09-22T00:00:00Z"
    });
    expect(environment.index.state(WORKSPACE)).toEqual({ status: "partial", selection: old.generation.selection,
      active_generation_id: old.generation.generation_id });
    expect(environment.index.generation(WORKSPACE, old.generation.generation_id)).toMatchObject({ status: "partial", reason: "source_changed" });
    expect(environment.index.writeVector(WORKSPACE, old.generation.generation_id, vectorFor(old.documents[0]!.windows[0]!)))
      .toEqual({ status: "rejected", reason: "stale" });
    expect(environment.index.activate(WORKSPACE, old.generation.generation_id)).toEqual({ status: "rejected", reason: "stale" });
    const fresh = environment.index.begin(old.generation.selection);
    expect(fresh.source_epoch).toBeGreaterThan(old.generation.source_epoch);
    expect(fresh.generation_id).not.toBe(old.generation.generation_id);
    expect(fresh).toMatchObject({ selection: old.generation.selection, status: "building", enumeration_complete: false, target_count: 0 });
    environment = reopen(environment);
    expect(environment.index.begin(old.generation.selection)).toEqual(fresh);
    const documents = captureDocuments(environment, fresh);
    expect(documents.map(document => ({ id: document.source.target.root_id, body: document.body })))
      .toEqual([{ id: replacement.record_id, body: "current native body" }]);
    writeVectors(environment, fresh, documents);
    expect(environment.index.activate(WORKSPACE, fresh.generation_id)).toEqual({ status: "accepted" });
    expect(environment.index.generation(WORKSPACE, old.generation.generation_id)).toMatchObject({ status: "retired", reason: "replaced" });
    expect(environment.index.state(WORKSPACE)).toMatchObject({ status: "ready", active_generation_id: fresh.generation_id });
  });

  it("preserves unknown, unbound, retired and failed meanings on read-only reopen and cannot silently retry writes", () => {
    const environment = fileFixture();
    publishSource(environment, "read only lexicalsurvives");
    const old = buildReady(environment);
    const unbound = environment.index.select(WORKSPACE, configuration({ model_revision: "v2" }));
    const failed = environment.index.begin(environment.index.select("workspace-2", configuration()));
    environment.index.fail("workspace-2", failed.generation_id, "interrupted_before_capture");
    const persistedFailed = environment.index.generation("workspace-2", failed.generation_id);
    const text = lexicalRows(environment.database);
    const readonly = readOnly(environment);
    expect(readonly.database.connection.readonly).toBe(true);
    expect(readonly.index.state("unknown-workspace")).toEqual({ status: "unknown" });
    expect(readonly.index.state(WORKSPACE)).toEqual({ status: "unbound", selection: unbound, active_generation_id: null });
    expect(readonly.index.generation(WORKSPACE, old.generation.generation_id)).toMatchObject({ status: "retired", reason: "selection_changed" });
    expect(readonly.index.state("workspace-2")).toMatchObject({ status: "failed", active_generation_id: null });
    expect(readonly.index.generation("workspace-2", failed.generation_id)).toEqual(persistedFailed);
    expect(readonly.index.generation(WORKSPACE, "missing-generation")).toBeNull();
    expect(() => readonly.index.listTargets(WORKSPACE, "missing-generation", null, 8)).toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));
    expect(lexicalRows(readonly.database)).toEqual(text);
    expect(ftsMatches(readonly.database, "lexicalsurvives")).toHaveLength(1);
    expect(() => readonly.index.begin(failed.selection)).toThrow(/readonly/u);
    expect(() => readonly.index.select(WORKSPACE, configuration({ model_revision: "v3" }))).toThrow(/readonly/u);
    expect(readonly.index.generation("workspace-2", failed.generation_id)).toEqual(persistedFailed);
    expect(readonly.index.state(WORKSPACE)).toEqual({ status: "unbound", selection: unbound, active_generation_id: null });
  });
});
