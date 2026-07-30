import fs from "node:fs";
import { fileURLToPath } from "node:url";
import BetterSqlite3 from "better-sqlite3";
import { describe, expect, it } from "vitest";

const MIGRATION_113 = fileURLToPath(
  new URL("../../migrations/113-evidence-capsule-fts-gist-first.sql", import.meta.url)
);

describe("migration 113 evidence capsule FTS gist-first", () => {
  it("indexes gist when excerpt is a narrow distilled fact", () => {
    const database = new BetterSqlite3(":memory:");
    try {
      seedEvidenceFtsSurface(database);
      database.prepare(`
        INSERT INTO evidence_capsules (
          rowid, object_id, workspace_id, excerpt, gist
        ) VALUES (1, 'evidence-1', 'workspace-1', ?, ?)
      `).run(
        "I bought my bookshelf from IKEA.",
        "User: I bought my bookshelf from IKEA. The patio table is weatherproof cedar."
      );
      database.exec(`
        INSERT INTO evidence_capsule_fts (rowid, object_id, workspace_id, content)
        VALUES (1, 'evidence-1', 'workspace-1', 'I bought my bookshelf from IKEA.');
        INSERT INTO evidence_capsule_fts_trigram (rowid, object_id, workspace_id, content)
        VALUES (1, 'evidence-1', 'workspace-1', 'I bought my bookshelf from IKEA.');
      `);

      expect(matchPorter(database, "weatherproof")).toEqual([]);

      database.exec(fs.readFileSync(MIGRATION_113, "utf8"));

      expect(matchPorter(database, "weatherproof")).toEqual([
        { object_id: "evidence-1" }
      ]);
      expect(matchPorter(database, "bookshelf")).toEqual([
        { object_id: "evidence-1" }
      ]);
    } finally {
      database.close();
    }
  });
});

function seedEvidenceFtsSurface(database: BetterSqlite3.Database): void {
  database.exec(`
    CREATE TABLE evidence_capsules (
      rowid INTEGER PRIMARY KEY,
      object_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      excerpt TEXT,
      gist TEXT
    );
    CREATE VIRTUAL TABLE evidence_capsule_fts USING fts5(
      object_id UNINDEXED,
      workspace_id,
      content,
      tokenize = 'porter unicode61'
    );
    CREATE VIRTUAL TABLE evidence_capsule_fts_trigram USING fts5(
      object_id UNINDEXED,
      workspace_id,
      content,
      tokenize = 'trigram'
    );
  `);
}

function matchPorter(database: BetterSqlite3.Database, term: string) {
  return database.prepare(`
    SELECT object_id FROM evidence_capsule_fts WHERE evidence_capsule_fts MATCH ?
  `).all(term);
}
