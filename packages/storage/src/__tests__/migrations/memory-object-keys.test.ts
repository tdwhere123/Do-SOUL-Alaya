import { afterEach, describe, expect, it } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import { insertMemoryEntryRow, openBaselineDatabase } from "./apply-baseline.js";

const databases = new Set<BetterSqlite3.Database>();

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

describe("memory object keys", () => {
  it("indexes complementary key surfaces independently of memory content", () => {
    const database = createDatabase();
    insertMemoryEntryRow(database, "memory-1", "I took my niece to the museum.");
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
  });

  it("rejects unknown key types and cascades with the owner memory", () => {
    const database = createDatabase();
    insertMemoryEntryRow(database, "memory-1", "distilled fact");
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
  });

  it("indexes CJK key surfaces on the trigram table", () => {
    const database = createDatabase();
    insertMemoryEntryRow(database, "memory-1", "I visited a museum.");
    insertKey(database, {
      ownerId: "memory-1",
      keyId: "gist-museum",
      keyType: "gist_remainder",
      surface: "博物馆",
      sourceRef: "evidence:capsule-1:gist:0:3"
    });

    expect(database.prepare(`
      SELECT owner_id FROM memory_object_key_fts_trigram
      WHERE memory_object_key_fts_trigram MATCH ?
    `).all('content:"博物馆"')).toEqual([{ owner_id: "memory-1" }]);
  });

  it("rebuilds both FTS tables when a key surface is updated", () => {
    const database = createDatabase();
    insertMemoryEntryRow(database, "memory-1", "I visited a museum.");
    insertKey(database, {
      ownerId: "memory-1",
      keyId: "gist-museum",
      keyType: "gist_remainder",
      surface: "Natural History",
      sourceRef: "evidence:capsule-1:gist:0:15"
    });
    database.prepare(`
      UPDATE memory_object_keys SET surface = ?, normalized_surface = lower(?)
      WHERE key_id = 'gist-museum'
    `).run("Golden Retriever", "Golden Retriever");

    expect(database.prepare(`
      SELECT owner_id FROM memory_object_key_fts
      WHERE memory_object_key_fts MATCH ?
    `).all('content:"History"')).toEqual([]);
    expect(database.prepare(`
      SELECT owner_id FROM memory_object_key_fts
      WHERE memory_object_key_fts MATCH ?
    `).all('content:"Retriever"')).toEqual([{ owner_id: "memory-1" }]);
    expect(database.prepare(`
      SELECT owner_id FROM memory_object_key_fts_trigram
      WHERE memory_object_key_fts_trigram MATCH ?
    `).all('content:"Retriever"')).toEqual([{ owner_id: "memory-1" }]);
  });
});

function createDatabase(): BetterSqlite3.Database {
  const database = openBaselineDatabase();
  databases.add(database);
  return database;
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
