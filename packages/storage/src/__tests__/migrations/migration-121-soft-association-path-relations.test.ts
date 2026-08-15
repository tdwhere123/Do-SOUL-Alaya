import fs from "node:fs";
import { fileURLToPath } from "node:url";
import BetterSqlite3 from "better-sqlite3";
import { describe, expect, it } from "vitest";

const migration = fileURLToPath(new URL(
  "../../migrations/121-soft-association-path-relations.sql",
  import.meta.url
));

describe("migration 121 soft association path relations", () => {
  it("does not promote legacy projections without usage authority", () => {
    const database = createDatabase();
    try {
      insertLegacyPath(database, "canonical", "co_recalled", "attention_only");
      insertLegacyPath(database, "legacy-truth", "supports", "recall_allowed");
      database.exec(fs.readFileSync(migration, "utf8"));

      expect(database.prepare(
        "SELECT path_id FROM soft_association_path_relations ORDER BY path_id"
      ).all()).toEqual([]);
      expect(() => insertSoftPath(database, "invalid-soft", "supports", "attention_only"))
        .toThrow(/CHECK constraint failed/u);
    } finally {
      database.close();
    }
  });
});

function createDatabase(): BetterSqlite3.Database {
  const database = new BetterSqlite3(":memory:");
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE workspaces (workspace_id TEXT PRIMARY KEY);
    INSERT INTO workspaces (workspace_id) VALUES ('workspace-1');
    CREATE TABLE path_relations (
      path_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      anchors_json TEXT NOT NULL,
      constitution_json TEXT NOT NULL,
      effect_vector_json TEXT NOT NULL,
      plasticity_state_json TEXT NOT NULL,
      lifecycle_json TEXT NOT NULL,
      legitimacy_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return database;
}

function insertLegacyPath(
  database: BetterSqlite3.Database,
  pathId: string,
  relationKind: string,
  governanceClass: string
): void {
  insertPath(database, "path_relations", pathId, relationKind, governanceClass);
}

function insertSoftPath(
  database: BetterSqlite3.Database,
  pathId: string,
  relationKind: string,
  governanceClass: string
): void {
  insertPath(database, "soft_association_path_relations", pathId, relationKind, governanceClass);
}

function insertPath(
  database: BetterSqlite3.Database,
  table: "path_relations" | "soft_association_path_relations",
  pathId: string,
  relationKind: string,
  governanceClass: string
): void {
  database.prepare(`INSERT INTO ${table} (
    path_id, workspace_id, anchors_json, constitution_json, effect_vector_json,
    plasticity_state_json, lifecycle_json, legitimacy_json, created_at, updated_at
  ) VALUES (?, 'workspace-1', ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      pathId,
      JSON.stringify({
        source_anchor: { kind: "object", object_id: "object-1" },
        target_anchor: { kind: "object", object_id: "object-2" }
      }),
      JSON.stringify({ relation_kind: relationKind, why_this_relation_exists: ["test"] }),
      JSON.stringify({ recall_bias: 0.5 }),
      JSON.stringify({ strength: 0.5 }),
      JSON.stringify({ status: "active" }),
      JSON.stringify({
        evidence_basis: ["recalls_edge_co_usage"],
        governance_class: governanceClass
      }),
      "2026-04-17T00:00:00.000Z",
      "2026-04-17T00:00:00.000Z"
    );
}
