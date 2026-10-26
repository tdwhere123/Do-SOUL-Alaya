import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { canonicalJson, hashSourceRecordId, sourceIndexConfigurationId, sourceIndexProfileId } from "@do-soul/alaya-protocol";
import { StorageDatabase, initDatabase } from "../../../sqlite/db.js";
import { migrateLegacyPathRelationsToTemporalCandidate } from "../../../sqlite/temporal-cutover-gate.js";
import { SqliteEvidenceCapsuleRepo } from "../../../repos/capsules/evidence-capsule-repo.js";
import { SqliteFieldSourceRecordRepo } from "../../../repos/field/source-repo.js";
import { SqliteSourceIndexRepository } from "../../../repos/source-index/source-index-repo.js";
import { applyBaselineSql } from "../../migrations/apply-baseline.js";
import { hashedOriginalRecord, seedWorkspaces } from "../field/field-contract-fixture.js";
import { BUDGET, CLOCK, WORKSPACE, configuration, fieldSha256 } from "./source-index-fixture.js";
const opened: StorageDatabase[] = [], directories: string[] = [];
afterEach(() => { for (const db of opened.splice(0)) db.close(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it("forward migration retires record-only valid-empty generations and recaptures the capsule universe after restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "capsule-source-index-migration-")); directories.push(directory);
  const filename = join(directory, "old.sqlite"), old = new StorageDatabase(filename, new BetterSqlite3(filename)); opened.push(old);
  applyBaselineSql(old.connection, 22);
  migrateLegacyPathRelationsToTemporalCandidate(old.connection, { selectionRequired: false });
  old.connection.exec("CREATE TABLE schema_version(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  for (let version = 1; version <= 22; version++) old.connection.prepare("INSERT INTO schema_version VALUES(?,?)").run(version, CLOCK);
  seedWorkspaces(old);
  const root = await new SqliteEvidenceCapsuleRepo(old).create({ object_id: "cccccccc-cccc-4ccc-8ccc-000000000201",
    object_kind: "evidence_capsule", schema_version: 1, lifecycle_state: "active", created_at: CLOCK, updated_at: CLOCK,
    created_by: "user_action", evidence_kind: "conversation_excerpt", semantic_anchor: { topic: "source", keywords: ["source"], summary: "source" },
    event_anchor: null, physical_anchor: null, evidence_health_state: "verified", gist: "gist", excerpt: "needle retained",
    source_hash: null, run_id: "run-1", workspace_id: WORKSPACE, surface_id: null });
  const config = configuration(), configId = sourceIndexConfigurationId(config, fieldSha256), profileId = sourceIndexProfileId(config.profile, fieldSha256);
  const oldId = `sha256:${fieldSha256(canonicalJson(["source-index-generation.v1", WORKSPACE, 1, configId, 0]))}`;
  old.connection.prepare("INSERT INTO source_index_selections VALUES(?,?,?,?,?,?)").run(WORKSPACE, 1, configId, profileId, canonicalJson(config), oldId);
  old.connection.prepare(`INSERT INTO source_index_generations(workspace_id,generation_id,selection_revision,config_id,profile_id,
    configuration_json,source_epoch,status,enumeration_complete) VALUES(?,?,?,?,?,?,0,'valid_empty',1)`)
    .run(WORKSPACE, oldId, 1, configId, profileId, canonicalJson(config));
  old.close({ optimize: false });
  const migrated = initDatabase({ filename }); opened.push(migrated);
  const index = new SqliteSourceIndexRepository(migrated, fieldSha256);
  expect(index.generation(WORKSPACE, oldId)).toMatchObject({ status: "retired", preparation_revision: 1, enumeration_complete: true });
  expect(index.state(WORKSPACE)).toMatchObject({ status: "unbound", active_generation_id: null, selection: { selection_revision: 2 } });
  expect(index.activate(WORKSPACE, oldId)).toEqual({ status: "rejected", reason: "superseded" });
  const generation = index.begin(index.select(WORKSPACE, config));
  expect(generation.generation_id).not.toBe(oldId);
  expect(index.capturePage(WORKSPACE, generation.generation_id, 8, BUDGET).generation).toMatchObject({ target_count: 1, enumeration_complete: true });
  expect(index.listTargets(WORKSPACE, generation.generation_id, null, 8)[0]).toMatchObject({ source_id: null,
    target: { root_kind: "evidence_capsule", root_id: root.object_id } });
});

it("does not infer historical provenance membership from a matching source digest", async () => {
  const directory = mkdtempSync(join(tmpdir(), "capsule-source-provenance-migration-")); directories.push(directory);
  const filename = join(directory, "old.sqlite"), old = new StorageDatabase(filename, new BetterSqlite3(filename)); opened.push(old);
  applyBaselineSql(old.connection, 22);
  migrateLegacyPathRelationsToTemporalCandidate(old.connection, { selectionRequired: false });
  old.connection.exec("CREATE TABLE schema_version(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  for (let version = 1; version <= 22; version++) old.connection.prepare("INSERT INTO schema_version VALUES(?,?)").run(version, CLOCK);
  seedWorkspaces(old);
  const root = await new SqliteEvidenceCapsuleRepo(old).create({ object_id: "cccccccc-cccc-4ccc-8ccc-000000000202",
    object_kind: "evidence_capsule", schema_version: 1, lifecycle_state: "active", created_at: CLOCK, updated_at: CLOCK,
    created_by: "user_action", evidence_kind: "conversation_excerpt", semantic_anchor: { topic: "source", keywords: ["source"], summary: "source" },
    event_anchor: null, physical_anchor: null, evidence_health_state: "verified", gist: "gist", excerpt: "Harbor opening was put off.",
    source_hash: "sha256:not-identity", run_id: "run-1", workspace_id: WORKSPACE, surface_id: null });
  old.close({ optimize: false });
  const migrated = initDatabase({ filename }); opened.push(migrated);
  expect(migrated.connection.prepare("SELECT source_provenance FROM evidence_capsules WHERE object_id=?").get(root.object_id))
    .toEqual({ source_provenance: 0 });
  const records = new SqliteFieldSourceRecordRepo(migrated, fieldSha256);
  const row = hashedOriginalRecord(WORKSPACE, "Harbor opening was put off.", "source-a");
  const record = records.insert({ ...row, record_id: hashSourceRecordId(row, fieldSha256) });
  migrated.connection.prepare("UPDATE evidence_capsules SET source_hash=? WHERE object_id=?").run(record.content_digest, root.object_id);
  const index = new SqliteSourceIndexRepository(migrated, fieldSha256);
  const generation = index.begin(index.select(WORKSPACE, configuration()));
  expect(index.capturePage(WORKSPACE, generation.generation_id, 8, BUDGET).generation)
    .toMatchObject({ target_count: 2, enumeration_complete: true });
  const kinds = index.listTargets(WORKSPACE, generation.generation_id, null, 8).map(target => target.target.root_kind).sort();
  expect(kinds).toEqual(["evidence_capsule", "source_record"]);
});
