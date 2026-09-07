import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initDatabase, type StorageDatabase } from "../../../sqlite/db.js";
import { prepareIndexedRecallProjection, SqliteIndexedRecallProjection } from "../../../repos/garden/indexed-recall-projection.js";
import { assertSemanticArtifactCandidateSchema } from "../../../repos/garden/semantic-artifact-schema.js";

const directories: string[] = [];
const databases: StorageDatabase[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function open(filename: string): StorageDatabase {
  const database = initDatabase({ filename, temporalMode: "candidate" });
  databases.push(database);
  return database;
}

function fixture(): { directory: string; database: StorageDatabase; filename: string } {
  const directory = mkdtempSync(join(tmpdir(), "alaya-index-migration-"));
  directories.push(directory);
  const filename = join(directory, "retained.db");
  const database = open(filename);
  prepareIndexedRecallProjection(database);
  database.connection.exec(`
    INSERT INTO event_log(event_id,event_type,entity_type,entity_id,workspace_id,run_id,caused_by,payload_json,created_at,revision)
    VALUES ('event','soul.memory.created','memory_entry','memory','workspace','run','user_action','{}','2026-09-06T00:00:00.000Z',1);
    INSERT INTO memory_entries(object_id,object_kind,schema_version,workspace_id,run_id,created_by,dimension,source_kind,formation_kind,scope_class,content,domain_tags,evidence_refs,lifecycle_state,created_at,updated_at)
    VALUES ('memory','memory_entry',1,'workspace','run','user_action','fact','user','explicit','project','retained source','[]','[]','active','2026-09-06T00:00:00.000Z','2026-09-06T00:00:00.000Z');
  `);
  return { directory, database, filename };
}

function truth(database: StorageDatabase): string {
  return JSON.stringify(["event_log", "memory_entries", "relation_assertions", "relation_assertion_evidence",
    "relation_assertion_resolution_current", "relation_assertion_quarantine"].map((table) =>
    database.connection.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
}

function retainLegacyProjection(database: StorageDatabase, revision: number): void {
  const triggers = database.connection.prepare("SELECT name FROM sqlite_master WHERE type='trigger'")
    .all() as { name: string }[];
  for (const { name } of triggers) {
    if (name.startsWith("garden_observable_") || (revision === 4 && name.startsWith("garden_index_"))) {
      database.connection.exec(`DROP TRIGGER "${name.replaceAll('"', '""')}"`);
    }
  }
  if (revision === 4) {
    database.connection.exec("DROP TABLE garden_index_revisions; DROP TABLE garden_projection_cursor");
  } else {
    database.connection.exec(`ALTER TABLE garden_projection_cursor DROP COLUMN observable_epoch;
      ALTER TABLE garden_projection_cursor DROP COLUMN observable_generation`);
  }
  database.connection.prepare("UPDATE garden_semantic_schema SET revision=?").run(revision);
}

describe("indexed Recall isolated migration and rollback", () => {
  it.each([4, 5])("upgrades revision %s, restarts and replays without changing retained truth", (revision) => {
    const { directory, database, filename } = fixture();
    retainLegacyProjection(database, revision);
    const originalTruth = truth(database);
    database.close();
    const digest = createHash("sha256").update(readFileSync(filename)).digest("hex");
    const candidateFilename = join(directory, "candidate.db");
    copyFileSync(filename, candidateFilename);
    const candidate = open(candidateFilename);
    prepareIndexedRecallProjection(candidate);
    const projection = new SqliteIndexedRecallProjection(candidate.connection);
    const pin = projection.observablePin("workspace");
    expect(truth(candidate)).toBe(originalTruth);
    expect(candidate.connection.prepare("SELECT revision FROM garden_semantic_schema").all()).toEqual([{ revision: 6 }]);
    candidate.close();
    const restarted = open(candidateFilename);
    assertSemanticArtifactCandidateSchema(restarted.connection);
    prepareIndexedRecallProjection(restarted);
    expect(new SqliteIndexedRecallProjection(restarted.connection).observablePin("workspace")).toEqual(pin);
    expect(truth(restarted)).toBe(originalTruth);
    expect(createHash("sha256").update(readFileSync(filename)).digest("hex")).toBe(digest);
    // Rollback selects the retained tuple, never rewrites newer history into it.
    const retained = open(filename);
    expect(truth(retained)).toBe(originalTruth);
    expect(retained.connection.prepare("SELECT revision FROM garden_semantic_schema").all()).toEqual([{ revision }]);
    expect(() => assertSemanticArtifactCandidateSchema(retained.connection)).toThrow(/incompatible/);
  });

  it("rolls back the entire preparation when a required native index cannot be created", () => {
    const { database } = fixture();
    database.connection.exec(`
      UPDATE garden_semantic_schema SET revision=5;
      DROP INDEX idx_memory_embeddings_recall_profile_identity;
      CREATE TABLE idx_memory_embeddings_recall_profile_identity (blocked INTEGER);
    `);
    const originalTruth = truth(database);
    expect(() => prepareIndexedRecallProjection(database)).toThrow();
    expect(database.connection.prepare("SELECT revision FROM garden_semantic_schema").all()).toEqual([{ revision: 5 }]);
    expect(truth(database)).toBe(originalTruth);
    database.connection.exec("DROP TABLE idx_memory_embeddings_recall_profile_identity");
    prepareIndexedRecallProjection(database);
    assertSemanticArtifactCandidateSchema(database.connection);
  });

  it("rejects mixed revisions and keeps revoked or unobserved sources out of ready projection state", () => {
    const { database } = fixture();
    database.connection.exec("INSERT INTO garden_semantic_schema VALUES (4)");
    expect(() => prepareIndexedRecallProjection(database)).toThrow();
    expect(database.connection.prepare("SELECT revision FROM garden_semantic_schema ORDER BY revision").all())
      .toEqual([{ revision: 4 }, { revision: 6 }]);
    database.connection.exec("DELETE FROM garden_semantic_schema WHERE revision=4");
    database.connection.exec("UPDATE memory_entries SET lifecycle_state='tombstone' WHERE object_id='memory'");
    prepareIndexedRecallProjection(database);
    const projection = new SqliteIndexedRecallProjection(database.connection);
    expect(projection.freshness("workspace", "memory").lexical).toBe("tombstoned");
    expect(projection.freshness("workspace", "absent")).toMatchObject({ sourceEventRevision: null, lexical: "missing" });
    expect(projection.observablePin("absent")).toEqual({ source_revision: expect.stringMatching(/^uninitialized:[a-f0-9]{64}$/u) });
  });
});
