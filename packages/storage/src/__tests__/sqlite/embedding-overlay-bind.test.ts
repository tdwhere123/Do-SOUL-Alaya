import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeCachedDatabase,
  initDatabase,
  writeEmbeddingOverlayBind
} from "../../sqlite/index.js";

const OBJECT_ID = "11111111-1111-4111-8111-111111111111";

describe("sqlite embedding overlay bind", () => {
  const roots: string[] = [];

  afterEach(async () => {
    for (const root of roots.splice(0)) {
      closeCachedDatabase(join(root, "alaya.db"));
      await rm(root, { recursive: true, force: true });
    }
  });

  it("projects overlay memory vectors without writing durable embedding rows", async () => {
    const root = await mkdtemp(join(tmpdir(), "alaya-overlay-bind-"));
    roots.push(root);
    const databasePath = join(root, "alaya.db");
    const overlayPath = join(root, "overlay.sqlite");
    initDatabase({ filename: databasePath }).close();

    const overlay = new BetterSqlite3(overlayPath);
    overlay.exec(`
      CREATE TABLE memory_embeddings (
        object_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
        content_hash TEXT NOT NULL, provider_kind TEXT NOT NULL,
        model_id TEXT NOT NULL, schema_version INTEGER NOT NULL,
        dimensions INTEGER NOT NULL, embedding_blob BLOB NOT NULL,
        vector_valid INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE evidence_recall_embeddings (
        workspace_id TEXT NOT NULL, owner_object_id TEXT NOT NULL,
        document_identity TEXT NOT NULL, content_hash TEXT NOT NULL,
        document_role TEXT NOT NULL, provider_kind TEXT NOT NULL,
        model_id TEXT NOT NULL, schema_version INTEGER NOT NULL,
        dimensions INTEGER NOT NULL, embedding_blob BLOB NOT NULL,
        vector_valid INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, owner_object_id, document_identity, document_role)
      );
    `);
    overlay.prepare(`
      INSERT INTO memory_embeddings (
        object_id, workspace_id, content_hash, provider_kind, model_id,
        schema_version, dimensions, embedding_blob, vector_valid, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      OBJECT_ID, "workspace-1", "sha256:memory", "local_onnx", "fixture-model",
      1, 2, encodeVector(new Float32Array([1, 2])),
      "2026-08-10T00:00:00.000Z", "2026-08-10T00:00:00.000Z"
    );
    overlay.close();

    writeEmbeddingOverlayBind({
      databaseFilename: databasePath,
      overlayFilename: "overlay.sqlite",
      overlaySha256: sha256File(overlayPath)
    });
    const database = initDatabase({ filename: databasePath });
    expect(count(database.connection, "SELECT COUNT(*) FROM main.memory_embeddings")).toBe(0);
    expect(count(database.connection, "SELECT COUNT(*) FROM memory_embeddings")).toBe(1);
    database.close();
  });

  it("rejects a cached connection whose bind document points at another overlay", async () => {
    const root = await mkdtemp(join(tmpdir(), "alaya-overlay-bind-mismatch-"));
    roots.push(root);
    const databasePath = join(root, "alaya.db");
    const firstOverlay = join(root, "first.sqlite");
    const secondOverlay = join(root, "second.sqlite");
    createOverlayTables(firstOverlay);
    createOverlayTables(secondOverlay);

    writeEmbeddingOverlayBind({
      databaseFilename: databasePath,
      overlayFilename: "first.sqlite",
      overlaySha256: sha256File(firstOverlay)
    });
    const database = initDatabase({ filename: databasePath });
    writeEmbeddingOverlayBind({
      databaseFilename: databasePath,
      overlayFilename: "second.sqlite",
      overlaySha256: sha256File(secondOverlay)
    });

    expect(() => initDatabase({ filename: databasePath })).toThrow(
      /does not match the attached sidecar/u
    );
    database.close();
  });
});

function createOverlayTables(filename: string): void {
  const overlay = new BetterSqlite3(filename);
  overlay.exec(`
    CREATE TABLE memory_embeddings (
      object_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
      content_hash TEXT NOT NULL, provider_kind TEXT NOT NULL,
      model_id TEXT NOT NULL, schema_version INTEGER NOT NULL,
      dimensions INTEGER NOT NULL, embedding_blob BLOB NOT NULL,
      vector_valid INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE evidence_recall_embeddings (
      workspace_id TEXT NOT NULL, owner_object_id TEXT NOT NULL,
      document_identity TEXT NOT NULL, content_hash TEXT NOT NULL,
      document_role TEXT NOT NULL, provider_kind TEXT NOT NULL,
      model_id TEXT NOT NULL, schema_version INTEGER NOT NULL,
      dimensions INTEGER NOT NULL, embedding_blob BLOB NOT NULL,
      vector_valid INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, owner_object_id, document_identity, document_role)
    );
  `);
  overlay.close();
}

function encodeVector(vector: Float32Array): Buffer {
  const bytes = Buffer.alloc(vector.length * Float32Array.BYTES_PER_ELEMENT);
  vector.forEach((value, index) => bytes.writeFloatLE(
    value, index * Float32Array.BYTES_PER_ELEMENT
  ));
  return bytes;
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function count(connection: { prepare: (sql: string) => { pluck: () => { get: () => unknown } } }, sql: string): number {
  return connection.prepare(sql).pluck().get() as number;
}
