import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { StorageDatabase, initDatabase } from "../../../sqlite/db.js";
import { SqliteSourceIndexRepository } from "../../../repos/source-index/source-index-repo.js";
import { BUDGET, WORKSPACE, buildReady, configuration, eraseSource, fieldSha256, fixture, publishSource, vectorFor } from "./source-index-fixture.js";

const directories: string[] = [], databases: StorageDatabase[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) if (!database.isClosed()) database.close({ optimize: false });
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function setup() {
  const directory = mkdtempSync(join(tmpdir(), "vector-reclamation-")); directories.push(directory);
  const environment = fixture(join(directory, "source.sqlite")); databases.push(environment.database);
  return environment;
}
function counts(database: StorageDatabase, generation: string) {
  return ["source_index_vectors", "source_index_windows", "source_index_targets"].map(table =>
    (database.connection.prepare(`SELECT count(*) AS n FROM ${table} WHERE workspace_id=? AND generation_id=?`)
      .get(WORKSPACE, generation) as { n: number }).n);
}
function drain(index: SqliteSourceIndexRepository, limit = 2) {
  const pages = [];
  for (let attempt = 0; attempt < 100; attempt++) {
    const page = index.reclaimVectorPage(WORKSPACE, limit, BUDGET);
    expect(page.vectors + page.windows + page.targets).toBeLessThanOrEqual(limit);
    expect(page.resources.work).toBeLessThanOrEqual(BUDGET.work);
    expect(page.resources.native_bytes).toBeLessThanOrEqual(BUDGET.native_bytes);
    pages.push(page);
    if (page.complete) return pages;
  }
  throw new Error("retired vector queue did not drain");
}

it("deletes bounded pages in payload order, preserves active/building generations and an older WAL snapshot", () => {
  const environment = setup(), { database, index } = environment;
  publishSource(environment, "abcdefghijklmno", "one");
  const old = buildReady(environment), oldId = old.generation.generation_id;
  const pinned = new StorageDatabase(database.filename, new BetterSqlite3(database.filename, { readonly: true })); databases.push(pinned);
  const oldReader = new SqliteSourceIndexRepository(pinned, fieldSha256);
  pinned.connection.exec("BEGIN DEFERRED");
  const budget = { work_units: 1_000_000, memory_bytes: 10_000_000 };
  const oldRead = oldReader.readVectorCandidates(WORKSPACE, null, 8, budget);
  expect(oldRead.candidates.map(row => row.window.start_byte).sort((a, b) => a - b)).toEqual([0, 8]);
  const active = buildReady(environment, configuration({ model_revision: "v2" }));
  publishSource(environment, "new pending source", "two");
  const building = index.begin(active.generation.selection);
  index.capturePage(WORKSPACE, building.generation_id, 8, BUDGET);
  expect(index.generation(WORKSPACE, building.generation_id)?.status).not.toBe("retired");
  const activeCounts = counts(database, active.generation.generation_id), pendingCounts = counts(database, building.generation_id);
  expect(counts(database, oldId)).toEqual([2, 2, 1]);
  const first = index.reclaimVectorPage(WORKSPACE, 1, BUDGET);
  expect(first).toMatchObject({ vectors: 1, windows: 0, targets: 0, generations: 0, complete: false });
  expect(counts(database, oldId)).toEqual([1, 2, 1]);
  expect(index.generation(WORKSPACE, oldId)?.status).toBe("retired");
  database.close({ optimize: false });
  const reopened = initDatabase({ filename: database.filename }); databases.push(reopened);
  const resumed = new SqliteSourceIndexRepository(reopened, fieldSha256);
  const pages = drain(resumed);
  expect(pages.reduce((sum, row) => sum + row.vectors, 0)).toBe(1);
  expect(pages.reduce((sum, row) => sum + row.windows, 0)).toBe(2);
  expect(pages.reduce((sum, row) => sum + row.targets, 0)).toBe(1);
  expect(pages.reduce((sum, row) => sum + row.generations, 0)).toBe(1);
  expect(resumed.generation(WORKSPACE, oldId)).toBeNull();
  expect(counts(reopened, oldId)).toEqual([0, 0, 0]);
  expect(counts(reopened, active.generation.generation_id)).toEqual(activeCounts);
  expect(counts(reopened, building.generation_id)).toEqual(pendingCounts);
  expect(oldReader.readVectorCandidates(WORKSPACE, null, 8, budget)).toEqual(oldRead);
  pinned.connection.exec("COMMIT");
  expect(oldReader.readVectorCandidates(WORKSPACE, null, 8, budget).state).toMatchObject({ binding: { generation_id: active.generation.generation_id } });
});

it("rolls back a failed page and leaves erase closure and surviving current vectors intact", () => {
  const environment = setup(), { database, index } = environment;
  const erased = publishSource(environment, "erase this body", "one");
  publishSource(environment, "keep this body", "two");
  const old = buildReady(environment), active = buildReady(environment, configuration({ model_revision: "v2" }));
  const oldId = old.generation.generation_id;
  const before = counts(database, oldId);
  database.connection.exec(`CREATE TEMP TRIGGER refuse_vector_reclamation BEFORE DELETE ON source_index_windows
    BEGIN SELECT RAISE(ABORT, 'reclamation interrupted'); END`);
  expect(() => index.reclaimVectorPage(WORKSPACE, 128, BUDGET)).toThrow("reclamation interrupted");
  expect(counts(database, oldId)).toEqual(before);
  database.connection.exec("DROP TRIGGER refuse_vector_reclamation");
  expect(index.reclaimVectorPage(WORKSPACE, 1, BUDGET)).toMatchObject({ vectors: 1, generations: 0 });
  eraseSource(environment, erased.record_id);
  expect(database.connection.prepare("SELECT count(*) AS n FROM projection_erase_barriers WHERE workspace_id=? AND subject_id=?")
    .get(WORKSPACE, erased.record_id)).toEqual({ n: 1 });
  const erasedKey = old.documents.find(row => row.source.target.root_id === erased.record_id)!.source.root_key;
  for (const table of ["source_index_vectors", "source_index_windows"]) {
    expect(database.connection.prepare(`SELECT count(*) AS n FROM ${table} WHERE workspace_id=? AND root_key=?`)
      .get(WORKSPACE, erasedKey)).toEqual({ n: 0 });
  }
  expect(counts(database, active.generation.generation_id)[0]).toBe(2);
  const obsolete = old.documents[0]!.windows[0]!;
  expect(index.writeVector(WORKSPACE, oldId, vectorFor(obsolete))).toEqual({ status: "rejected", reason: "superseded" });
  drain(index);
  expect(index.writeVector(WORKSPACE, oldId, vectorFor(obsolete))).toEqual({ status: "rejected", reason: "missing_generation" });
  expect(database.connection.prepare("SELECT count(*) AS n FROM projection_erase_barriers WHERE workspace_id=? AND subject_id=?")
    .get(WORKSPACE, erased.record_id)).toEqual({ n: 1 });
  expect(counts(database, active.generation.generation_id)[0]).toBe(2);
});

it("retires superseded unpointed builds without deleting the active or latest build", () => {
  const environment = setup(), { database, index } = environment;
  publishSource(environment, "active source", "one");
  const active = buildReady(environment);
  publishSource(environment, "second source", "two");
  const stale = index.begin(active.generation.selection);
  index.capturePage(WORKSPACE, stale.generation_id, 8, BUDGET);
  publishSource(environment, "third source", "three");
  const current = index.begin(active.generation.selection);
  index.capturePage(WORKSPACE, current.generation_id, 8, BUDGET);
  expect(index.generation(WORKSPACE, stale.generation_id)?.status).toBe("partial");
  const activeRows = counts(database, active.generation.generation_id);
  const currentRows = counts(database, current.generation_id);
  expect(drain(index).reduce((sum, page) => sum + page.generations, 0)).toBe(1);
  expect(index.generation(WORKSPACE, stale.generation_id)).toBeNull();
  expect(counts(database, active.generation.generation_id)).toEqual(activeRows);
  expect(counts(database, current.generation_id)).toEqual(currentRows);
  expect(index.state(WORKSPACE)).toMatchObject({ active_generation_id: active.generation.generation_id });
});

it("refuses caller-owned snapshots and does no work below its page budget", () => {
  const environment = setup(), { database, index } = environment;
  publishSource(environment, "body");
  expect(index.reclaimVectorPage(WORKSPACE, 1, { work: 4, native_bytes: 1000 }))
    .toMatchObject({ complete: false, resources: { work: 0, native_bytes: 0 } });
  database.connection.exec("BEGIN");
  try { expect(() => index.reclaimVectorPage(WORKSPACE, 1, BUDGET)).toThrow("transaction-free caller"); }
  finally { database.connection.exec("ROLLBACK"); }
});
