import fs from "node:fs";
import { fileURLToPath } from "node:url";
import BetterSqlite3 from "better-sqlite3";
import { describe, expect, it } from "vitest";

const migration = fileURLToPath(new URL(
  "../../migrations/120-memory-object-keys.sql",
  import.meta.url
));

describe("migration 120 memory object keys", () => {
  it("indexes complementary key surfaces independently of memory content", () => {
    const database = createDatabase();
    try {
      insertMemory(database, "memory-1", "I took my niece to the museum.");
      insertKey(database, {
        ownerId: "memory-1",
        keyId: "gist-golden",
        keyType: "gist_remainder",
        surface: "Golden Retriever",
        sourceRef: "evidence:capsule-1:gist:0:16"
      });

      expect(database.prepare(`
        SELECT owner_id FROM memory_object_key_fts
        WHERE memory_object_key_fts MATCH ?
      `).all('content:"Retriever"')).toEqual([{ owner_id: "memory-1" }]);
      expect(database.prepare(`
        SELECT owner_id FROM memory_object_key_fts_trigram
        WHERE memory_object_key_fts_trigram MATCH ?
      `).all('content:"Retriever"')).toEqual([{ owner_id: "memory-1" }]);
      expect(database.prepare(`
        SELECT object_id FROM memory_content_fts_porter
        WHERE memory_content_fts_porter MATCH ?
      `).all('content:"Retriever"')).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("rejects unknown key types and cascades with the owner memory", () => {
    const database = createDatabase();
    try {
      insertMemory(database, "memory-1", "distilled fact");
      expect(() => insertKey(database, {
        ownerId: "memory-1",
        keyId: "bad",
        keyType: "facet_tag",
        surface: "health",
        sourceRef: "evidence:capsule-1:gist:0:6"
      })).toThrow(/CHECK constraint failed/u);

      insertKey(database, {
        ownerId: "memory-1",
        keyId: "gist-asylum",
        keyType: "gist_remainder",
        surface: "asylum",
        sourceRef: "evidence:capsule-1:gist:20:26"
      });
      database.prepare("DELETE FROM memory_entries WHERE object_id = 'memory-1'").run();
      expect(database.prepare("SELECT COUNT(*) AS count FROM memory_object_keys").get())
        .toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });
});

function createDatabase(): BetterSqlite3.Database {
  const database = new BetterSqlite3(":memory:");
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE memory_entries (
      object_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      content TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE memory_content_fts_porter USING fts5(
      object_id UNINDEXED,
      workspace_id UNINDEXED,
      content,
      tokenize = 'porter unicode61'
    );
    CREATE TRIGGER memory_content_fts_porter_ai AFTER INSERT ON memory_entries BEGIN
      INSERT INTO memory_content_fts_porter (rowid, object_id, workspace_id, content)
      VALUES (new.rowid, new.object_id, new.workspace_id, new.content);
    END;
  `);
  database.exec(fs.readFileSync(migration, "utf8"));
  return database;
}

function insertMemory(
  database: BetterSqlite3.Database,
  objectId: string,
  content: string
): void {
  database.prepare(`
    INSERT INTO memory_entries (object_id, workspace_id, content) VALUES (?, 'workspace-1', ?)
  `).run(objectId, content);
}

function insertKey(
  database: BetterSqlite3.Database,
  input: Readonly<{
    readonly ownerId: string;
    readonly keyId: string;
    readonly keyType: string;
    readonly surface: string;
    readonly sourceRef: string;
  }>
): void {
  database.prepare(`
    INSERT INTO memory_object_keys (
      workspace_id, owner_id, key_id, key_type, surface, normalized_surface,
      language, source_kind, source_ref
    ) VALUES (
      'workspace-1', ?, ?, ?, ?, lower(?), 'en', 'evidence_gist', ?
    )
  `).run(input.ownerId, input.keyId, input.keyType, input.surface, input.surface, input.sourceRef);
}
