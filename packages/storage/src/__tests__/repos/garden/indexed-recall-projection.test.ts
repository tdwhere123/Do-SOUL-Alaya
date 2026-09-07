import { afterEach, describe, expect, it } from "vitest";
import { initDatabase, type StorageDatabase } from "../../../sqlite/db.js";
import {
  SEMANTIC_ARTIFACT_CANDIDATE_SCHEMA_REVISION,
  initializeSemanticArtifactCandidateSchema
} from "../../../repos/garden/semantic-artifact-schema.js";
import { prepareIndexedRecallProjection } from "../../../repos/garden/indexed-recall-projection.js";

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

describe("indexed recall projection schema", () => {
  it("prepares the candidate revision and typed/embedding indexes", () => {
    const database = initDatabase({ filename: ":memory:" });
    databases.add(database);
    prepareIndexedRecallProjection(database);
    expect(database.connection.prepare("SELECT revision FROM garden_semantic_schema").all())
      .toEqual([{ revision: SEMANTIC_ARTIFACT_CANDIDATE_SCHEMA_REVISION }]);
    const indexes = database.connection.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name IN (?, ?)"
    ).all("idx_relation_recall_subject", "idx_memory_embeddings_recall_profile_identity") as { name: string }[];
    expect(indexes.map((row) => row.name).sort()).toEqual([
      "idx_memory_embeddings_recall_profile_identity",
      "idx_relation_recall_subject"
    ].sort());
  });

  it("upgrades additive schema 4 and rejects older incompatible revisions", () => {
    const database = initDatabase({ filename: ":memory:" });
    databases.add(database);
    initializeSemanticArtifactCandidateSchema(database.connection);
    database.connection.exec(`
      INSERT INTO event_log(event_id, event_type, entity_type, entity_id, workspace_id, run_id, caused_by, payload_json, created_at, revision)
      VALUES ('evt-1', 'soul.memory.created', 'memory_entry', 'mem-1', 'workspace-1', 'run-1', 'user_action', '{}', '2026-09-06T00:00:00.000Z', 1);
      INSERT INTO memory_entries(object_id, object_kind, schema_version, workspace_id, run_id, created_by, dimension, source_kind, formation_kind, scope_class, content, domain_tags, evidence_refs, lifecycle_state, created_at, updated_at)
      VALUES ('mem-1', 'memory_entry', 1, 'workspace-1', 'run-1', 'user_action', 'fact', 'user', 'explicit', 'project', 'checklist', '[]', '[]', 'active', '2026-09-06T00:00:00.000Z', '2026-09-06T00:00:00.000Z');
    `);
    database.connection.exec(`
      DROP TRIGGER IF EXISTS garden_index_memory_ai;
      DROP TRIGGER IF EXISTS garden_index_memory_au;
      DROP TRIGGER IF EXISTS garden_index_memory_tombstone;
      DROP TRIGGER IF EXISTS garden_index_memory_ad;
      DROP TRIGGER IF EXISTS garden_index_semantic_ai;
      DROP TRIGGER IF EXISTS garden_index_semantic_au;
      DROP TRIGGER IF EXISTS garden_index_embedding_ai;
      DROP TRIGGER IF EXISTS garden_index_embedding_au;
      DROP TRIGGER IF EXISTS garden_index_embedding_ad;
      DROP TABLE IF EXISTS garden_index_revisions;
      DROP TABLE IF EXISTS garden_projection_cursor;
      UPDATE garden_semantic_schema SET revision=4;
    `);
    initializeSemanticArtifactCandidateSchema(database.connection);
    expect(database.connection.prepare("SELECT revision FROM garden_semantic_schema").all())
      .toEqual([{ revision: 6 }]);
    expect(database.connection.prepare(
      "SELECT object_id, source_event_revision, tombstoned FROM garden_index_revisions"
    ).all()).toEqual([{ object_id: "mem-1", source_event_revision: 1, tombstoned: 0 }]);
    database.connection.prepare("UPDATE garden_semantic_schema SET revision=2").run();
    expect(() => initializeSemanticArtifactCandidateSchema(database.connection))
      .toThrow(/incompatible semantic artifact candidate schema/);
  });
});
