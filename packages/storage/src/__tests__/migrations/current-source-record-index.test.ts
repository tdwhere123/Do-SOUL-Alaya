import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { initDatabase, StorageDatabase } from "../../sqlite/db.js";
import { migrateLegacyPathRelationsToTemporalCandidate } from "../../sqlite/temporal-cutover-gate.js";
import { SqliteFieldSourceRecordRepo } from "../../repos/field/source-repo.js";
import { CLOCK, fieldSha256, hashedRecord, seedWorkspaces } from "../repos/field/field-contract-fixture.js";
import { applyBaselineSql, currentSchemaVersion } from "./apply-baseline.js";

const databases: StorageDatabase[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close({ optimize: false });
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const LEGACY_IDENTITY_SQL = `SELECT record_id, workspace_id, source_id, source_version, content_digest,
  evidence_object_id, recorded_at, event_time, valid_from, valid_to, operator_id, speaker, scope_class, source_body
  FROM source_records WHERE workspace_id = ? ORDER BY record_id`;

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

function insertLegacyRecord(
  database: StorageDatabase,
  row: ReturnType<typeof hashedRecord> & { recorded_at: string }
) {
  // v17 has no attribution_context_json; current repo statements require 019.
  database.connection.prepare(`INSERT INTO source_records(
    record_id, workspace_id, source_id, source_version, content_digest,
    evidence_object_id, recorded_at, event_time, valid_from, valid_to,
    operator_id, speaker, scope_class, source_body)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    row.record_id, row.workspace_id, row.source_id, row.source_version, row.content_digest,
    row.evidence_object_id, row.recorded_at, row.event_time, row.valid_from, row.valid_to,
    row.operator_id, row.speaker, row.scope_class, row.source_body);
  return row;
}

describe("current source record index migration", () => {
  it("indexes retained rows by full UTC precision without rewriting source identities or timestamps", () => {
    const old = legacyDatabase();
    const first = insertLegacyRecord(old, { ...hashedRecord("workspace-1", "minute"), recorded_at: "2026-09-22T00:00Z" });
    const current = insertLegacyRecord(old, { ...hashedRecord("workspace-1", "fraction"), recorded_at: "2026-09-22T00:00:00.00000000002Z" });
    insertLegacyRecord(old, { ...hashedRecord("workspace-1", "earlier fraction"), recorded_at: "2026-09-22T00:00:00.00000000001Z" });
    const before = old.connection.prepare(LEGACY_IDENTITY_SQL).all("workspace-1");
    old.close({ optimize: false });
    const migrated = initDatabase({ filename: old.filename });
    databases.push(migrated);
    const reader = new SqliteFieldSourceRecordRepo(migrated, fieldSha256);
    expect(reader.findCurrent("workspace-1", first.source_id)?.record_id).toBe(current.record_id);
    expect(reader.findCurrent("workspace-1", first.source_id)?.recorded_at).toBe(current.recorded_at);
    expect(reader.findCurrentBounded("workspace-1", first.source_id)?.record?.record_id).toBe(current.record_id);
    expect(migrated.connection.prepare(LEGACY_IDENTITY_SQL).all("workspace-1")).toEqual(before);
    expect(migrated.connection.prepare(
      "SELECT attribution_context_json FROM source_records WHERE workspace_id = ? ORDER BY record_id"
    ).all("workspace-1")).toEqual([
      { attribution_context_json: null }, { attribution_context_json: null }, { attribution_context_json: null }
    ]);
    expect(migrated.connection.prepare("SELECT MAX(version) AS version FROM schema_version").get())
      .toEqual({ version: currentSchemaVersion() });
  });

  it("fails the migration atomically for an invalid retained instant", () => {
    const old = legacyDatabase();
    const invalid = insertLegacyRecord(old, { ...hashedRecord("workspace-1", "invalid time"), recorded_at: "invalid" });
    old.close({ optimize: false });
    expect(() => initDatabase({ filename: old.filename })).toThrow(expect.objectContaining({
      code: "MIGRATION_FAILED", cause: expect.objectContaining({ message: "invalid UTC instant in current-source index" })
    }));
    const retained = new StorageDatabase(old.filename, new BetterSqlite3(old.filename, { readonly: true }));
    databases.push(retained);
    expect(retained.connection.prepare("SELECT MAX(version) AS version FROM schema_version").get()).toEqual({ version: 17 });
    expect(retained.connection.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_source_records_current'").get()).toBeUndefined();
    expect(retained.connection.prepare(
      "SELECT recorded_at FROM source_records WHERE workspace_id = ? AND record_id = ?"
    ).get("workspace-1", invalid.record_id)).toEqual({ recorded_at: "invalid" });
  });
});
