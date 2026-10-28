import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { expect, it } from "vitest";
import { warmCjkSegmentation } from "@do-soul/alaya-cjk-segmentation";
import { StorageDatabase, initDatabase } from "../../../sqlite/db.js";
import { migrateLegacyPathRelationsToTemporalCandidate } from "../../../sqlite/temporal-cutover-gate.js";
import { SqliteFieldSourceRecordRepo } from "../../../repos/field/source-repo.js";
import { SqliteFieldEraseBarrierRepo } from "../../../repos/field/erase-repo.js";
import { SqliteSourceIndexRepository } from "../../../repos/source-index/source-index-repo.js";
import { lexicalDomainTables } from "../../../repos/source-index/lexical-domain.js";
import { applyBaselineSql } from "../../migrations/apply-baseline.js";
import { seedWorkspaces } from "../field/field-contract-fixture.js";
import { WORKSPACE, CLOCK, fieldSha256, publishSource, buildReady } from "./source-index-fixture.js";

it("migrates the selected segmented corpus without changing coverage, source or vector state", async () => {
  expect(await warmCjkSegmentation()).toBe(true);
  const directory = mkdtempSync(join(tmpdir(), "lexical-domain-migration-")), filename = join(directory, "source.sqlite");
  let database = new StorageDatabase(filename, new BetterSqlite3(filename));
  try {
    applyBaselineSql(database.connection, 27);
    migrateLegacyPathRelationsToTemporalCandidate(database.connection, { selectionRequired: false });
    database.connection.exec("CREATE TABLE schema_version(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    for (let version = 1; version <= 27; version++) database.connection.prepare("INSERT INTO schema_version VALUES(?,?)").run(version, CLOCK);
    seedWorkspaces(database);
    const environment = { database, index: new SqliteSourceIndexRepository(database, fieldSha256),
      records: new SqliteFieldSourceRecordRepo(database, fieldSha256), erase: new SqliteFieldEraseBarrierRepo(database, fieldSha256) };
    const alpha = publishSource(environment, "alpha", "a");
    publishSource(environment, "beta", "b"); publishSource(environment, "beta", "c");
    buildReady(environment);
    const active = `sha256:${"f".repeat(64)}`;
    database.connection.prepare("INSERT INTO source_index_lexical_selections VALUES(?,5,'segmented-unicode61.v1',?)").run(WORKSPACE, active);
    for (const digit of ["1", "2", "3", "4", "f"]) {
      const generation = `sha256:${digit.repeat(64)}`, current = generation === active;
      database.connection.prepare(`INSERT INTO source_index_lexical_generations
        (workspace_id,generation_id,selection_revision,representation,source_epoch,status,enumeration_complete,records_complete)
        SELECT ?,?,?, 'segmented-unicode61.v1',epoch,?,1,1 FROM source_index_epochs WHERE workspace_id=?`)
        .run(WORKSPACE, generation, current ? 5 : Number(digit), current ? "ready" : "retired", WORKSPACE);
      database.connection.prepare(`INSERT INTO source_index_lexical_targets(workspace_id,generation_id,root_key)
        SELECT workspace_id,?,root_key FROM source_index_text WHERE workspace_id=? AND (? OR body='alpha')`)
        .run(generation, WORKSPACE, Number(current));
      database.connection.prepare(`INSERT INTO source_index_lexical_projections(workspace_id,generation_id,root_key,content_digest,body_bytes,projection)
        SELECT workspace_id,?,root_key,content_digest,body_bytes,body FROM source_index_text
        WHERE workspace_id=? AND (? OR body='alpha')`).run(generation, WORKSPACE, Number(current));
      database.connection.prepare("UPDATE source_index_lexical_targets SET complete=1 WHERE generation_id=?").run(generation);
    }
    const oldOrder = database.connection.prepare(`SELECT p.projection FROM source_index_lexical_fts f
      JOIN source_index_lexical_projections p ON p.id=f.rowid WHERE source_index_lexical_fts MATCH 'alpha OR beta'
      AND p.generation_id=? ORDER BY bm25(source_index_lexical_fts),p.root_key`).all(active);
    expect(oldOrder).toEqual([{ projection: "beta" }, { projection: "beta" }, { projection: "alpha" }]);
    const tables = ["source_index_text", "source_index_vectors", "source_index_lexical_selections", "source_index_lexical_generations",
      "source_index_lexical_targets", "source_index_lexical_projections"];
    const before = tables.map(table => database.connection.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    database.close({ optimize: false }); database = initDatabase({ filename });
    expect(tables.map(table => database.connection.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())).toEqual(before);
    expect(database.connection.prepare("SELECT name FROM sqlite_master WHERE name='source_index_lexical_fts'").get()).toBeUndefined();
    const index = new SqliteSourceIndexRepository(database, fieldSha256);
    const read = () => index.readLexicalCandidates(WORKSPACE, "alpha beta", 8, { work_units: 100_000, memory_bytes: 16 * 1024 * 1024 });
    const after = read();
    expect(after.tokenization?.lexical_binding).toMatchObject({ generation_id: active, representation: "segmented-unicode61.v1" });
    expect(after.limitations).toContain("generation_scoped_bm25_statistics");
    expect(after.candidates).toHaveLength(3);
    expect(after.candidates[0]!.source.target.root_id).toBe(alpha.record_id);
    expect(after.candidates[0]!.lexical.bm25).toBeLessThan(after.candidates[1]!.lexical.bm25!);
    for (const table of Object.values(lexicalDomainTables(active))) {
      expect(database.connection.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 3 });
      database.connection.exec(`INSERT INTO ${table}(${table}) VALUES('integrity-check')`);
    }
    for (let page = 0; page < 20; page++) {
      if (index.lexical.reclaimLexicalPage(WORKSPACE, 8, { work: 1000, native_bytes: 10000 }).complete) break;
    }
    expect(read()).toEqual(after);
    database.close({ optimize: false }); database = initDatabase({ filename });
    expect(database.connection.prepare("SELECT count(*) AS n FROM source_index_lexical_generations").get()).toEqual({ n: 1 });
  } finally { database.close({ optimize: false }); rmSync(directory, { recursive: true, force: true }); }
});

it("rolls back shared-FTS removal and partial domain creation when migration encounters an invalid persisted identity", () => {
  const directory = mkdtempSync(join(tmpdir(), "lexical-domain-rollback-")), filename = join(directory, "source.sqlite");
  const owner = new StorageDatabase(filename, new BetterSqlite3(filename)), legacy = owner.connection;
  try {
    applyBaselineSql(legacy, 27);
    migrateLegacyPathRelationsToTemporalCandidate(legacy, { selectionRequired: false });
    legacy.exec("CREATE TABLE schema_version(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    for (let version = 1; version <= 27; version++) legacy.prepare("INSERT INTO schema_version VALUES(?,?)").run(version, CLOCK);
    const valid = `sha256:${"1".repeat(64)}`;
    const insert = legacy.prepare(`INSERT INTO source_index_lexical_generations
      (workspace_id,generation_id,selection_revision,representation,source_epoch,status) VALUES(?,?,1,'raw-unicode61.v1',0,'building')`);
    insert.run(WORKSPACE, valid); insert.run(WORKSPACE, "invalid-persisted-generation");
    const schema = legacy.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY name").all();
    legacy.close();
    expect(() => initDatabase({ filename })).toThrow(/028-source-index-lexical-domains/u);
    const retained = new BetterSqlite3(filename);
    try {
      expect(retained.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY name").all()).toEqual(schema);
      expect(retained.prepare("SELECT max(version) AS version FROM schema_version").get()).toEqual({ version: 27 });
      expect(retained.prepare("SELECT count(*) AS n FROM source_index_lexical_generations").get()).toEqual({ n: 2 });
      expect(retained.prepare("SELECT name FROM sqlite_master WHERE name=?").get(lexicalDomainTables(valid).unicode61)).toBeUndefined();
      // Repair only the authored corrupt fixture, then the same migration can finish on reopen.
      retained.prepare("DELETE FROM source_index_lexical_generations WHERE generation_id=?").run("invalid-persisted-generation");
    } finally { retained.close(); }
    const migrated = initDatabase({ filename });
    try {
      expect(migrated.connection.prepare("SELECT max(version) AS version FROM schema_version").get()).toEqual({ version: 28 });
      expect(migrated.connection.prepare("SELECT name FROM sqlite_master WHERE name=?").get(lexicalDomainTables(valid).unicode61)).toBeDefined();
    } finally { migrated.close({ optimize: false }); }
  } finally { if (legacy.open) legacy.close(); rmSync(directory, { recursive: true, force: true }); }
});
