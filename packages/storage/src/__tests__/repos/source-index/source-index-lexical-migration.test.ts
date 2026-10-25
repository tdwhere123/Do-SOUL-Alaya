import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { expect, it } from "vitest";
import { StorageDatabase, initDatabase } from "../../../sqlite/db.js";
import { migrateLegacyPathRelationsToTemporalCandidate } from "../../../sqlite/temporal-cutover-gate.js";
import { SqliteFieldSourceRecordRepo } from "../../../repos/field/source-repo.js";
import { SqliteFieldEraseBarrierRepo } from "../../../repos/field/erase-repo.js";
import { SqliteSourceIndexRepository } from "../../../repos/source-index/source-index-repo.js";
import { applyBaselineSql } from "../../migrations/apply-baseline.js";
import { seedWorkspaces } from "../field/field-contract-fixture.js";
import { WORKSPACE, CLOCK, fieldSha256, publishSource, buildReady } from "./source-index-fixture.js";

it("adds lexical tables without selecting, rewriting raw text, or retiring an eligible vector generation", () => {
  const directory = mkdtempSync(join(tmpdir(), "lexical-migration-")), filename = join(directory, "source.sqlite");
  let database = new StorageDatabase(filename, new BetterSqlite3(filename));
  try {
    applyBaselineSql(database.connection, 24);
    migrateLegacyPathRelationsToTemporalCandidate(database.connection, { selectionRequired: false });
    database.connection.exec("CREATE TABLE schema_version(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    for (let version = 1; version <= 24; version++) database.connection.prepare("INSERT INTO schema_version VALUES(?,?)").run(version, CLOCK);
    seedWorkspaces(database);
    const environment = { database, index: new SqliteSourceIndexRepository(database, fieldSha256),
      records: new SqliteFieldSourceRecordRepo(database, fieldSha256), erase: new SqliteFieldEraseBarrierRepo(database, fieldSha256) };
    publishSource(environment, "Alpha-BETA 自动部署流水线");
    const built = buildReady(environment);
    const before = database.connection.prepare("SELECT * FROM source_index_vectors ORDER BY window_id").all();
    const text = database.connection.prepare("SELECT * FROM source_index_text").all();
    database.close({ optimize: false }); database = initDatabase({ filename });
    const index = new SqliteSourceIndexRepository(database, fieldSha256);
    expect(index.lexical.lexicalState(WORKSPACE)).toBeNull();
    expect(database.connection.prepare("SELECT count(*) AS n FROM source_index_lexical_generations").get()).toEqual({ n: 0 });
    expect(database.connection.prepare("SELECT * FROM source_index_vectors ORDER BY window_id").all()).toEqual(before);
    expect(database.connection.prepare("SELECT * FROM source_index_text").all()).toEqual(text);
    expect(index.state(WORKSPACE)).toMatchObject({ status: "ready", active_generation_id: built.generation.generation_id });
    const budget = { work_units: 100_000, memory_bytes: 16 * 1024 * 1024 };
    expect(index.readLexicalCandidates(WORKSPACE, "alpha", 8, budget).candidates).toHaveLength(1);
    expect(index.readLexicalCandidates(WORKSPACE, "部署", 8, budget).candidates).toHaveLength(0);
    expect(index.readVectorCandidates(WORKSPACE, null, 128, budget).state.status).toBe("ready");
  } finally { database.close({ optimize: false }); rmSync(directory, { recursive: true, force: true }); }
});
