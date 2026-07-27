import fs from "node:fs";
import { fileURLToPath } from "node:url";
import BetterSqlite3 from "better-sqlite3";
import { describe, expect, it } from "vitest";

const MIGRATION_109 = fileURLToPath(
  new URL("../../migrations/109-evidence-search-projections.sql", import.meta.url)
);
const MIGRATION_110 = fileURLToPath(
  new URL("../../migrations/110-evidence-search-projection-kinds.sql", import.meta.url)
);

describe("migration 110 evidence search projection kinds", () => {
  it("retains v109 rows and permits kind-local numeric identities", () => {
    const database = new BetterSqlite3(":memory:");
    try {
      seedOwnerTable(database);
      database.exec(fs.readFileSync(MIGRATION_109, "utf8"));
      insertProjection(database, "user_assertion", 1, "I commute by bicycle.");

      database.exec(fs.readFileSync(MIGRATION_110, "utf8"));
      insertProjection(database, "assistant_observation", 1, "Choose the TrailShell pack.");

      expect(readProjectionIdentities(database)).toEqual([
        { projection_kind: "assistant_observation", projection_id: 1 },
        { projection_kind: "user_assertion", projection_id: 1 }
      ]);
      expect(readFtsKinds(database)).toEqual([
        { projection_kind: "assistant_observation" }
      ]);
      expect(() => insertProjection(database, "unknown", 2, "invalid"))
        .toThrow(/CHECK constraint failed/u);
    } finally {
      database.close();
    }
  });
});

function seedOwnerTable(database: BetterSqlite3.Database): void {
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE evidence_capsules (
      object_id TEXT PRIMARY KEY
    );
    INSERT INTO evidence_capsules (object_id) VALUES ('evidence-1');
  `);
}

function insertProjection(
  database: BetterSqlite3.Database,
  projectionKind: string,
  projectionId: number,
  content: string
): void {
  database.prepare(`
    INSERT INTO evidence_search_projections (
      evidence_object_id, projection_id, projection_kind,
      workspace_id, source_hash, content
    ) VALUES ('evidence-1', ?, ?, 'workspace-1', 'source-hash-1', ?)
  `).run(projectionId, projectionKind, content);
}

function readProjectionIdentities(database: BetterSqlite3.Database) {
  return database.prepare(`
    SELECT projection_kind, projection_id
    FROM evidence_search_projections
    ORDER BY projection_kind ASC, projection_id ASC
  `).all();
}

function readFtsKinds(database: BetterSqlite3.Database) {
  return database.prepare(`
    SELECT projection_kind
    FROM evidence_search_projection_fts
    WHERE evidence_search_projection_fts MATCH ?
  `).all(`content:"TrailShell"`);
}
