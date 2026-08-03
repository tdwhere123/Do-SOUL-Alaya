import fs from "node:fs";
import { fileURLToPath } from "node:url";
import BetterSqlite3 from "better-sqlite3";
import { describe, expect, it } from "vitest";

const migrations = [109, 110, 115].map((version) => fileURLToPath(new URL(
  `../../migrations/${version}-${version === 109
    ? "evidence-search-projections"
    : version === 110
      ? "evidence-search-projection-kinds"
      : "associative-fact-key-search-projections"}.sql`,
  import.meta.url
)));

describe("migration 115 associative fact-key projections", () => {
  it("preserves existing rows and indexes fact keys in both lexical lanes", () => {
    const database = new BetterSqlite3(":memory:");
    try {
      database.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE evidence_capsules (object_id TEXT PRIMARY KEY);
        INSERT INTO evidence_capsules (object_id) VALUES ('evidence-1');
      `);
      migrations.forEach((migration) => database.exec(fs.readFileSync(migration, "utf8")));
      database.prepare(`
        INSERT INTO evidence_search_projections (
          evidence_object_id, projection_id, projection_kind,
          workspace_id, source_hash, content
        ) VALUES ('evidence-1', 1, 'fact_key', 'workspace-1', 'hash-1', ?)
      `).run("I use Atlas");

      expect(database.prepare(`
        SELECT projection_kind FROM evidence_search_projection_fts
        WHERE evidence_search_projection_fts MATCH ?
      `).all('content:"Atlas"')).toEqual([{ projection_kind: "fact_key" }]);
      expect(database.prepare(`
        SELECT projection_kind FROM evidence_search_projection_fts_trigram
        WHERE evidence_search_projection_fts_trigram MATCH ?
      `).all('content:"Atlas"')).toEqual([{ projection_kind: "fact_key" }]);
    } finally {
      database.close();
    }
  });
});
