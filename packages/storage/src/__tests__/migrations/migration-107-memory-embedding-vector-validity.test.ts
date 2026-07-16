import fs from "node:fs";
import { fileURLToPath } from "node:url";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrateEmbeddingVectorValidity } from "../../sqlite/embedding-vector-validity-migration.js";

const MIGRATION_PATH = fileURLToPath(
  new URL("../../migrations/107-memory-embedding-vector-validity.sql", import.meta.url)
);
const databases = new Set<BetterSqlite3.Database>();

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

describe("migration 107 memory embedding vector validity", () => {
  it("marks only strict finite nonzero vectors valid and remains stable on replay", () => {
    const database = createLegacyDatabase();
    seedVector(database, "valid", new Float32Array([0.5, -0.25]), 2);
    seedVector(database, "zero", new Float32Array([0, 0]), 2);
    seedVector(database, "nan", new Float32Array([Number.NaN, 1]), 2);
    seedVector(database, "truncated", new Float32Array([1]), 2);
    seedVector(database, "mixed-2d", new Float32Array([1, 0]), 2, "mixed-model");
    seedVector(database, "mixed-3d", new Float32Array([1, 0, 0]), 3, "mixed-model");

    database.transaction(() => {
      database.exec(fs.readFileSync(MIGRATION_PATH, "utf8"));
      migrateEmbeddingVectorValidity(database);
    })();
    expect(readValidity(database)).toEqual([
      { object_id: "mixed-2d", vector_valid: 0 },
      { object_id: "mixed-3d", vector_valid: 0 },
      { object_id: "nan", vector_valid: 0 },
      { object_id: "truncated", vector_valid: 0 },
      { object_id: "valid", vector_valid: 1 },
      { object_id: "zero", vector_valid: 0 }
    ]);

    database.transaction(() => migrateEmbeddingVectorValidity(database))();
    expect(readValidity(database)).toEqual([
      { object_id: "mixed-2d", vector_valid: 0 },
      { object_id: "mixed-3d", vector_valid: 0 },
      { object_id: "nan", vector_valid: 0 },
      { object_id: "truncated", vector_valid: 0 },
      { object_id: "valid", vector_valid: 1 },
      { object_id: "zero", vector_valid: 0 }
    ]);
  });
});

function createLegacyDatabase(): BetterSqlite3.Database {
  const database = new BetterSqlite3(":memory:");
  databases.add(database);
  database.exec(`
    CREATE TABLE memory_embeddings (
      object_id TEXT PRIMARY KEY,
      provider_kind TEXT NOT NULL DEFAULT 'openai',
      model_id TEXT NOT NULL DEFAULT 'fixture-model',
      schema_version INTEGER NOT NULL DEFAULT 1,
      dimensions INTEGER NOT NULL,
      embedding_blob BLOB NOT NULL
    )
  `);
  return database;
}

function seedVector(
  database: BetterSqlite3.Database,
  objectId: string,
  vector: Float32Array,
  dimensions: number,
  modelId = "fixture-model"
): void {
  database.prepare(`
    INSERT INTO memory_embeddings (object_id, model_id, dimensions, embedding_blob)
    VALUES (?, ?, ?, ?)
  `).run(objectId, modelId, dimensions, encodeFloat32LittleEndian(vector));
}

function encodeFloat32LittleEndian(vector: Float32Array): Buffer {
  const blob = Buffer.alloc(vector.length * Float32Array.BYTES_PER_ELEMENT);
  vector.forEach((value, index) => {
    blob.writeFloatLE(value, index * Float32Array.BYTES_PER_ELEMENT);
  });
  return blob;
}

function readValidity(database: BetterSqlite3.Database): unknown[] {
  return database.prepare(`
    SELECT object_id, vector_valid FROM memory_embeddings ORDER BY object_id
  `).all();
}
