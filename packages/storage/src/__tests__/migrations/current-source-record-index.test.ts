import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { initDatabase, StorageDatabase } from "../../sqlite/db.js";
import { migrateLegacyPathRelationsToTemporalCandidate } from "../../sqlite/temporal-cutover-gate.js";
import { SqliteFieldSourceRecordRepo } from "../../repos/field/source-repo.js";
import { CLOCK, fieldSha256, hashedRecord, seedWorkspaces } from "../repos/field/field-contract-fixture.js";
import { applyBaselineSql } from "./apply-baseline.js";

const databases: StorageDatabase[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close({ optimize: false });
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function legacyDatabase() {
  const directory = mkdtempSync(join(tmpdir(), "alaya-current-source-upgrade-"));
  directories.push(directory);
  const filename = join(directory, "source.sqlite");
  const database = new StorageDatabase(filename, new BetterSqlite3(filename));
  databases.push(database);
  applyBaselineSql(database.connection, 17);
  migrateLegacyPathRelationsToTemporalCandidate(database.connection, { selectionRequired: false });
  database.connection.exec("CREATE TABLE schema_version(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const mark = database.connection.prepare("INSERT INTO schema_version VALUES (?, ?)");
  for (let version = 1; version <= 17; version++) mark.run(version, CLOCK);
  seedWorkspaces(database);
  return database;
}

describe("current source record index migration", () => {
  it("indexes retained rows by full UTC precision without rewriting source identities or timestamps", () => {
    const old = legacyDatabase();
    const records = new SqliteFieldSourceRecordRepo(old, fieldSha256);
    const first = records.insert({ ...hashedRecord("workspace-1", "minute"), recorded_at: "2026-09-22T00:00Z" });
    const current = records.insert({ ...hashedRecord("workspace-1", "fraction"), recorded_at: "2026-09-22T00:00:00.00000000002Z" });
    records.insert({ ...hashedRecord("workspace-1", "earlier fraction"), recorded_at: "2026-09-22T00:00:00.00000000001Z" });
    const before = records.listByWorkspace("workspace-1");
    old.close({ optimize: false });
    const migrated = initDatabase({ filename: old.filename });
    databases.push(migrated);
    const reader = new SqliteFieldSourceRecordRepo(migrated, fieldSha256);
    expect(reader.findCurrent("workspace-1", first.source_id)).toEqual(current);
    expect(reader.findCurrentBounded("workspace-1", first.source_id)?.record?.record_id).toBe(current.record_id);
    expect(reader.listByWorkspace("workspace-1")).toEqual(before);
    expect(migrated.connection.prepare("SELECT MAX(version) AS version FROM schema_version").get()).toEqual({ version: 18 });
  });

  it("fails the migration atomically for an invalid retained instant", () => {
    const old = legacyDatabase();
    const records = new SqliteFieldSourceRecordRepo(old, fieldSha256);
    const invalid = records.insert({ ...hashedRecord("workspace-1", "invalid time"), recorded_at: "invalid" });
    old.close({ optimize: false });
    expect(() => initDatabase({ filename: old.filename })).toThrow(expect.objectContaining({
      code: "MIGRATION_FAILED", cause: expect.objectContaining({ message: "invalid UTC instant in current-source index" })
    }));
    const retained = new StorageDatabase(old.filename, new BetterSqlite3(old.filename, { readonly: true }));
    databases.push(retained);
    expect(retained.connection.prepare("SELECT MAX(version) AS version FROM schema_version").get()).toEqual({ version: 17 });
    expect(retained.connection.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_source_records_current'").get()).toBeUndefined();
    expect(new SqliteFieldSourceRecordRepo(retained, fieldSha256).findById("workspace-1", invalid.record_id)?.recorded_at).toBe("invalid");
  });
});
