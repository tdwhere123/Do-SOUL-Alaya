import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashLabeledIdentity } from "@do-soul/alaya-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initDatabase, type StorageDatabase } from "../../../sqlite/db.js";
import { openReadOnlyDatabase } from "../../../sqlite/open-readonly.js";
import { SqliteFieldSourceRecordRepo } from "../../../repos/field/source-repo.js";
import { SqliteFieldEraseBarrierRepo } from "../../../repos/field/erase-repo.js";
import { CLOCK, fieldSha256, hashedRecord, openFieldDatabase, seedWorkspaces } from "./field-contract-fixture.js";

const databases: StorageDatabase[] = [];
const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) database.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const database = openFieldDatabase();
  databases.push(database);
  return { database, records: new SqliteFieldSourceRecordRepo(database, fieldSha256) };
}

describe("indexed current source records", () => {
  it("preserves fractional ordering and chooses the greatest record id for equivalent UTC spellings", () => {
    const { records } = fixture();
    const older = records.insert({ ...hashedRecord("workspace-1", "older", "fractional"), recorded_at: "2026-09-22T00:00:00.00000000001Z" });
    const newer = records.insert({ ...hashedRecord("workspace-1", "newer", "fractional"), recorded_at: "2026-09-22T00:00:00.00000000002Z" });
    const tied = ["2026-09-22T00:00Z", "2026-09-22T00:00:00Z", "2026-09-22T00:00:00.0000Z"]
      .map((recorded_at, index) => records.insert({ ...hashedRecord("workspace-1", `tied-${index}`, "equivalent"), recorded_at }));
    const expectedTie = tied.reduce((left, right) => left.record_id > right.record_id ? left : right);
    expect(records.findCurrent("workspace-1", "fractional")).toEqual(newer);
    expect(records.findCurrentBounded("workspace-1", "fractional", 4)?.record)
      .toMatchObject({ record_id: newer.record_id, source_body: "newe" });
    expect(records.findCurrent("workspace-1", "equivalent")).toEqual(expectedTie);
    expect(records.findNextCurrentBounded("workspace-1", null)?.record?.record_id).toBe(expectedTie.record_id);
    expect(records.findNextCurrentBounded("workspace-1", "equivalent")?.record?.record_id).toBe(newer.record_id);
    expect(records.findNextCurrentBounded("workspace-1", "fractional")).toBeNull();
    expect(records.findCurrent("workspace-2", "fractional")).toBeNull();
    expect(records.findCurrentBounded("workspace-2", "fractional")).toBeNull();
    expect(records.findById("workspace-1", older.record_id)).toEqual(older);
  });

  it("reuses the source seek statement while observing new revisions and erased bodies", () => {
    const { database, records } = fixture();
    const original = records.insert(hashedRecord("workspace-1", "original", "a-source"));
    const second = records.insert(hashedRecord("workspace-1", "second", "b-source"));
    const prepare = vi.spyOn(database.connection, "prepare");
    expect(records.findNextCurrentBounded("workspace-1", null, 8)?.record)
      .toMatchObject({ record_id: original.record_id, source_body: "original" });
    expect(records.findNextCurrentBounded("workspace-1", "a-source")?.record?.record_id).toBe(second.record_id);
    expect(records.findNextCurrentBounded("workspace-1", "b-source")).toBeNull();
    expect(records.findNextCurrentBounded("workspace-2", null)).toBeNull();
    const current = records.insert({ ...hashedRecord("workspace-1", "replacement", "a-source"), recorded_at: "2026-09-22T00:00Z" });
    expect(records.findNextCurrentBounded("workspace-1", null, 11)?.record)
      .toMatchObject({ record_id: current.record_id, source_body: "replacement" });
    new SqliteFieldEraseBarrierRepo(database, fieldSha256).apply({
      identity: hashLabeledIdentity("erase_barrier", ["workspace-1", "source_record", current.record_id, ""], fieldSha256),
      barrier_id: "erase-seek-current", workspace_id: "workspace-1", generation_id: null,
      subject_kind: "source_record", subject_id: current.record_id, erased_at: "2026-09-22T01:00Z"
    });
    expect(records.findNextCurrentBounded("workspace-1", null, 11))
      .toMatchObject({ record: { record_id: current.record_id, source_body: null }, bodyBytes: 0 });
    expect(prepare.mock.calls.filter(([sql]) => sql.includes("source_records.source_id > ?"))).toHaveLength(1);
  });

  it("seeks past more than 512 obsolete versions using the actual current-source query index", () => {
    const { database, records } = fixture();
    database.connection.transaction(() => {
      for (let index = 0; index < 600; index++) {
        records.insert({ ...hashedRecord("workspace-1", `history-${index}`, "a-source"), recorded_at: `2026-09-21T00:00:00.${index.toString().padStart(4, "0")}Z` });
      }
    })();
    const first = records.insert({ ...hashedRecord("workspace-1", "current", "a-source"), recorded_at: "2026-09-22T00:00Z" });
    const second = records.insert(hashedRecord("workspace-1", "second", "b-source"));
    const prepare = vi.spyOn(database.connection, "prepare");
    expect(records.findCurrent("workspace-1", "a-source")?.record_id).toBe(first.record_id);
    expect(records.findCurrentBounded("workspace-1", "a-source")?.record?.record_id).toBe(first.record_id);
    expect(records.findNextCurrentBounded("workspace-1", "a-source")?.record?.record_id).toBe(second.record_id);
    const queries = prepare.mock.calls.map(([sql]) => sql).filter((sql) => sql.includes("INDEXED BY idx_source_records_current"));
    prepare.mockRestore();
    expect(queries).toHaveLength(3);
    for (const query of queries) {
      const plan = database.connection.prepare(`EXPLAIN QUERY PLAN ${query}`).all("workspace-1", "a-source") as { detail: string }[];
      expect(plan.some(({ detail }) => /SEARCH source_records USING INDEX idx_source_records_current/u.test(detail))).toBe(true);
      expect(plan.some(({ detail }) => /SCAN source_records|TEMP B-TREE/u.test(detail))).toBe(false);
    }
  });

  it("keeps newest scope and erased tombstones ahead of an older retained version", () => {
    const { database, records } = fixture();
    const older = records.insert({ ...hashedRecord("workspace-1", "old project", "source"), scope_class: "project" });
    const current = records.insert({ ...hashedRecord("workspace-1", "new global", "source"), scope_class: "global_core", recorded_at: "2026-09-22T00:00Z" });
    expect(records.findCurrentBounded("workspace-1", "source")?.record?.scope_class).toBe("global_core");
    new SqliteFieldEraseBarrierRepo(database, fieldSha256).apply({
      identity: hashLabeledIdentity("erase_barrier", ["workspace-1", "source_record", current.record_id, ""], fieldSha256),
      barrier_id: "erase-current", workspace_id: "workspace-1", generation_id: null,
      subject_kind: "source_record", subject_id: current.record_id, erased_at: "2026-09-22T01:00Z"
    });
    expect(records.findCurrent("workspace-1", "source")).toMatchObject({ record_id: current.record_id, source_body: null });
    expect(records.findCurrentBounded("workspace-1", "source"))
      .toMatchObject({ record: { record_id: current.record_id, source_body: null }, bodyBytes: 0 });
    expect(records.findNextCurrentBounded("workspace-1", null)?.record?.record_id).toBe(current.record_id);
    expect(records.findById("workspace-1", older.record_id)?.source_body).toBe("old project");
    expect(records.insert(current).source_body).toBeNull();
  });

  it("re-registers the exact key after close and on read-only open without altering stored timestamps", () => {
    const directory = mkdtempSync(join(tmpdir(), "alaya-current-source-"));
    directories.push(directory);
    const filename = join(directory, "source.sqlite");
    const database = initDatabase({ filename });
    databases.push(database);
    seedWorkspaces(database);
    const initialPrepare = vi.spyOn(database.connection, "prepare");
    const records = new SqliteFieldSourceRecordRepo(database, fieldSha256);
    records.insert({ ...hashedRecord("workspace-1", "older"), recorded_at: "2026-09-22T00:00Z" });
    const current = records.insert({ ...hashedRecord("workspace-1", "current"), recorded_at: "2026-09-22T00:00:00.00000000001Z" });
    expect(initialPrepare.mock.calls.filter(([sql]) => sql.includes("source_records.source_id > ?"))).toHaveLength(0);
    expect(records.findNextCurrentBounded("workspace-1", null)?.record?.record_id).toBe(current.record_id);
    expect(records.findNextCurrentBounded("workspace-1", null)?.record?.record_id).toBe(current.record_id);
    expect(initialPrepare.mock.calls.filter(([sql]) => sql.includes("source_records.source_id > ?"))).toHaveLength(1);
    database.close({ optimize: false });
    const reopen = vi.spyOn(database, "reopenIfClosed");
    expect(() => records.findNextCurrentBounded("workspace-1", null, 0)).toThrow();
    expect(reopen).not.toHaveBeenCalled();
    expect(records.findNextCurrentBounded("workspace-1", null)?.record?.record_id).toBe(current.record_id);
    const reopenedPrepare = vi.spyOn(database.connection, "prepare");
    expect(records.findNextCurrentBounded("workspace-1", null)?.record?.record_id).toBe(current.record_id);
    expect(reopenedPrepare.mock.calls.filter(([sql]) => sql.includes("source_records.source_id > ?"))).toHaveLength(0);
    database.close({ optimize: false });
    expect(records.findCurrentBounded("workspace-1", "src-1")?.record).toMatchObject({ record_id: current.record_id, recorded_at: current.recorded_at });
    const externallyReopenedPrepare = vi.spyOn(database.connection, "prepare");
    expect(records.findNextCurrentBounded("workspace-1", null)?.record?.record_id).toBe(current.record_id);
    expect(records.findNextCurrentBounded("workspace-1", null)?.record?.record_id).toBe(current.record_id);
    expect(externallyReopenedPrepare.mock.calls.filter(([sql]) => sql.includes("source_records.source_id > ?"))).toHaveLength(1);
    database.close({ optimize: false });
    const readonly = openReadOnlyDatabase(filename);
    databases.push(readonly);
    const reader = new SqliteFieldSourceRecordRepo(readonly, fieldSha256);
    expect(reader.findCurrent("workspace-1", "src-1")).toEqual(current);
    const readonlyPrepare = vi.spyOn(readonly.connection, "prepare");
    expect(reader.findNextCurrentBounded("workspace-1", null)?.record?.record_id).toBe(current.record_id);
    expect(reader.findNextCurrentBounded("workspace-1", null)?.record?.record_id).toBe(current.record_id);
    expect(readonlyPrepare.mock.calls.filter(([sql]) => sql.includes("source_records.source_id > ?"))).toHaveLength(1);
    expect(() => readonly.connection.prepare("UPDATE source_records SET recorded_at = ?").run(CLOCK)).toThrow(/readonly/u);
  });

  it("rejects invalid stored timestamps instead of ordering them as missing", () => {
    const { database, records } = fixture();
    const record = records.insert(hashedRecord("workspace-1", "valid"));
    expect(() => database.connection.prepare("UPDATE source_records SET recorded_at = ? WHERE record_id = ?")
      .run("invalid", record.record_id)).toThrow(/invalid UTC instant/u);
    expect(records.findCurrent("workspace-1", "src-1")).toEqual(record);
  });
});
