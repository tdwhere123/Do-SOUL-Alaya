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
    database.connection.prepare("UPDATE garden_semantic_schema SET revision=4").run();
    initializeSemanticArtifactCandidateSchema(database.connection);
    expect(database.connection.prepare("SELECT revision FROM garden_semantic_schema").all())
      .toEqual([{ revision: 5 }]);
    database.connection.prepare("UPDATE garden_semantic_schema SET revision=2").run();
    expect(() => initializeSemanticArtifactCandidateSchema(database.connection))
      .toThrow(/incompatible semantic artifact candidate schema/);
  });
});
