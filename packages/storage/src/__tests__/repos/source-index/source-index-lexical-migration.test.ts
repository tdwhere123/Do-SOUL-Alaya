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
import { createLexicalDomain } from "../../../repos/source-index/lexical-domain.js";
import { applyBaselineSql, currentSchemaVersion } from "../../migrations/apply-baseline.js";
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
    // Current capture reads migration 027's role; build with its historical default, then restore the v24 shape.
    database.connection.exec("ALTER TABLE evidence_capsules ADD COLUMN source_provenance INTEGER NOT NULL DEFAULT 0");
    const built = buildReady(environment);
    database.connection.exec("ALTER TABLE evidence_capsules DROP COLUMN source_provenance");
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

it("retains a v1 selection during upgrade and permits an explicit v2 selection", async () => {
  expect(await warmCjkSegmentation()).toBe(true);
  const directory = mkdtempSync(join(tmpdir(), "lexical-progress-upgrade-")), filename = join(directory, "source.sqlite");
  let database = new StorageDatabase(filename, new BetterSqlite3(filename));
  try {
    applyBaselineSql(database.connection, 29);
    migrateLegacyPathRelationsToTemporalCandidate(database.connection, { selectionRequired: false });
    database.connection.exec("CREATE TABLE schema_version(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    for (let version = 1; version <= 29; version++) database.connection.prepare("INSERT INTO schema_version VALUES(?,?)").run(version, CLOCK);
    seedWorkspaces(database);
    const active = `sha256:${"e".repeat(64)}`;
    database.connection.prepare(`INSERT INTO source_index_lexical_selections
      (workspace_id,selection_revision,representation,active_generation_id) VALUES(?,1,'segmented-unicode61.v1',?)`).run(WORKSPACE, active);
    database.connection.prepare(`INSERT INTO source_index_lexical_generations
      (workspace_id,generation_id,selection_revision,representation,source_epoch,status,enumeration_complete,records_complete)
      VALUES(?,?,1,'segmented-unicode61.v1',0,'valid_empty',1,1)`).run(WORKSPACE, active);
    createLexicalDomain(database.connection, WORKSPACE, active);
    database.close({ optimize: false }); database = initDatabase({ filename });
    const index = new SqliteSourceIndexRepository(database, fieldSha256);
    expect(database.connection.prepare("SELECT max(version) AS version FROM schema_version").get())
      .toEqual({ version: currentSchemaVersion() });
    expect(index.lexical.lexicalState(WORKSPACE)).toMatchObject({
      selection: { selection_revision: 1, representation: "segmented-unicode61.v1" }, active_generation_id: active });
    const selected = index.lexical.selectLexical(WORKSPACE, "segmented-unicode61.v2");
    expect(selected).toMatchObject({ selection_revision: 2, representation: "segmented-unicode61.v2" });
    const generation = index.lexical.beginLexical(selected);
    expect(index.lexical.captureLexicalPage(WORKSPACE, generation.generation_id, 8,
      { work: 1000, native_bytes: 1_000_000 }).generation.enumeration_complete).toBe(true);
    expect(index.lexical.activateLexical(WORKSPACE, generation.generation_id)).toEqual({ status: "accepted" });
    expect(index.lexical.lexicalState(WORKSPACE)?.active_generation_id).toBe(generation.generation_id);
  } finally { database.close({ optimize: false }); rmSync(directory, { recursive: true, force: true }); }
});
