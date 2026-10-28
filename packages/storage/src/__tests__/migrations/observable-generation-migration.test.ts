import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { initDatabase, StorageDatabase, type SqliteConnection } from "../../sqlite/db.js";
import { migrateLegacyPathRelationsToTemporalCandidate } from "../../sqlite/temporal-cutover-gate.js";
import { initializeSemanticArtifactCandidateSchema } from "../../repos/garden/semantic-artifact-schema.js";
import { applyBaselineSql, currentSchemaVersion } from "./apply-baseline.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function retainedProjection(): string {
  const directory = mkdtempSync(join(tmpdir(), "observable-generation-migration-"));
  directories.push(directory);
  const filename = join(directory, "retained.sqlite");
  const owner = new StorageDatabase(filename, new BetterSqlite3(filename)), template = initDatabase();
  const legacy = owner.connection;
  try {
    applyBaselineSql(legacy, 27);
    migrateLegacyPathRelationsToTemporalCandidate(legacy, { selectionRequired: false });
    legacy.exec("CREATE TABLE schema_version(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    const mark = legacy.prepare("INSERT INTO schema_version VALUES(?, '2026-09-06T00:00:00.000Z')");
    for (let version = 1; version <= 27; version++) mark.run(version);
    initializeSemanticArtifactCandidateSchema(template.connection);
    // Retain the optional projection and its existing observers. Quarantine did
    // not exist in this schema; migration 030 will also replace a watched table.
    const schema = template.connection.prepare(`SELECT sql FROM sqlite_master WHERE
      name IN ('garden_projection_cursor', 'garden_semantic_projections') OR
      (type='trigger' AND name GLOB 'garden_observable_*' AND tbl_name!='privacy_dependency_quarantine')
      ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name`).all() as { sql: string }[];
    for (const { sql } of schema) legacy.exec(sql);
    legacy.exec(`INSERT INTO garden_projection_cursor
      (workspace_id,applied_event_revision,applied_at,observable_generation,observable_epoch)
      VALUES ('workspace',7,'2026-09-06T00:00:00.000Z',41,'retained-epoch');
      INSERT INTO source_index_lexical_selections VALUES ('workspace',1,'raw-unicode61.v1',NULL)`);
  } finally { owner.close({ optimize: false }); template.close({ optimize: false }); }
  return filename;
}

function generation(connection: SqliteConnection): number {
  return (connection.prepare("SELECT observable_generation FROM garden_projection_cursor WHERE workspace_id='workspace'")
    .get() as { observable_generation: number }).observable_generation;
}

function assertQuarantineMutations(connection: SqliteConnection): void {
  const before = generation(connection);
  connection.exec(`INSERT INTO privacy_dependency_quarantine(workspace_id,object_kind,object_id)
    VALUES ('workspace','memory_entry','unavailable')`);
  expect(generation(connection)).toBe(before + 1);
  connection.exec("UPDATE privacy_dependency_quarantine SET reason='still_unavailable' WHERE object_id='unavailable'");
  expect(generation(connection)).toBe(before + 2);
  connection.exec("DELETE FROM privacy_dependency_quarantine WHERE object_id='unavailable'");
  expect(generation(connection)).toBe(before + 3);
}

it("upgrades retained observers after all dependent tables exist and restores observers on rebuilt tables", () => {
  const filename = retainedProjection();
  let database = initDatabase({ filename });
  try {
    expect(database.connection.prepare("SELECT max(version) AS version FROM schema_version").get())
      .toEqual({ version: currentSchemaVersion() });
    expect(database.connection.prepare("SELECT observable_epoch FROM garden_projection_cursor WHERE workspace_id='workspace'").get())
      .toEqual({ observable_epoch: "retained-epoch" });
    assertQuarantineMutations(database.connection);
    const before = generation(database.connection);
    database.connection.exec("UPDATE source_index_lexical_selections SET selection_revision=2 WHERE workspace_id='workspace'");
    expect(generation(database.connection)).toBe(before + 1);
    database.close({ optimize: false }); database = initDatabase({ filename });
    expect(generation(database.connection)).toBe(before + 1);
    assertQuarantineMutations(database.connection);
  } finally { database.close({ optimize: false }); }
});

it("rolls back the migration batch and retained observers if the completed projection schema is incomplete", () => {
  const filename = retainedProjection(), legacy = new BetterSqlite3(filename);
  const projection = (legacy.prepare("SELECT sql FROM sqlite_master WHERE name='garden_semantic_projections'").get() as { sql: string }).sql;
  legacy.exec("DROP TABLE garden_semantic_projections");
  const schema = legacy.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY name").all();
  const before = generation(legacy);
  legacy.close();
  expect(() => initDatabase({ filename })).toThrow();
  const retained = new BetterSqlite3(filename);
  try {
    expect(retained.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY name").all()).toEqual(schema);
    expect(retained.prepare("SELECT max(version) AS version FROM schema_version").get()).toEqual({ version: 27 });
    expect(generation(retained)).toBe(before);
    retained.exec(projection);
  } finally { retained.close(); }
  const repaired = initDatabase({ filename });
  try { assertQuarantineMutations(repaired.connection); }
  finally { repaired.close({ optimize: false }); }
});

it("refreshes observers on an already migrated reopen and rejects a missing required projection table", () => {
  const filename = retainedProjection();
  let database = initDatabase({ filename });
  try {
    const before = generation(database.connection);
    database.connection.exec("DROP TRIGGER garden_observable_privacy_dependency_quarantine_ai");
    database.close({ optimize: false }); database = initDatabase({ filename });
    expect(generation(database.connection)).toBe(before);
    assertQuarantineMutations(database.connection);
    database.connection.exec("DROP TABLE garden_semantic_projections");
    database.close({ optimize: false });
    expect(() => initDatabase({ filename })).toThrow();
  } finally { database.close({ optimize: false }); }
});
