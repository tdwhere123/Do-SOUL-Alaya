import fs from "node:fs";
import { fileURLToPath } from "node:url";
import BetterSqlite3 from "better-sqlite3";
import { describe, expect, it } from "vitest";

const migration = fileURLToPath(new URL(
  "../../migrations/116-evidence-fact-frame-formations.sql",
  import.meta.url
));

describe("migration 116 evidence fact-frame formations", () => {
  it("stores formed and unavailable captures and cascades with evidence", () => {
    const database = createDatabase();
    try {
      insertCapture(database, "formed", JSON.stringify({ schema_version: 1, slots: [] }));
      insertCapture(database, "unavailable", null, "evidence-2");

      expect(database.prepare(`
        SELECT evidence_object_id, status FROM evidence_fact_frame_formations
        ORDER BY evidence_object_id
      `).all()).toEqual([
        { evidence_object_id: "evidence-1", status: "formed" },
        { evidence_object_id: "evidence-2", status: "unavailable" }
      ]);
      database.prepare("DELETE FROM evidence_capsules WHERE object_id = 'evidence-1'").run();
      expect(database.prepare(`
        SELECT evidence_object_id FROM evidence_fact_frame_formations
      `).all()).toEqual([{ evidence_object_id: "evidence-2" }]);
    } finally {
      database.close();
    }
  });

  it("rejects state shapes that cannot represent a sealed capture", () => {
    const database = createDatabase();
    try {
      expect(() => insertCapture(database, "formed", null)).toThrow();
      expect(() => insertCapture(
        database,
        "unavailable",
        JSON.stringify({ schema_version: 1, slots: [] })
      )).toThrow();
      expect(() => database.prepare(`
        INSERT INTO evidence_fact_frame_formations (
          evidence_object_id, workspace_id, schema_version, operator_id, status,
          producer_operator_id, source_hash, fact_frame_json, capture_digest
        ) VALUES ('evidence-1', 'workspace-1', 1,
          'evidence_fact_frame_formation_v1', 'unavailable', NULL, 'hash-1', NULL, 'bad')
      `).run()).toThrow();
    } finally {
      database.close();
    }
  });
});

function createDatabase(): BetterSqlite3.Database {
  const database = new BetterSqlite3(":memory:");
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE evidence_capsules (object_id TEXT PRIMARY KEY);
    INSERT INTO evidence_capsules (object_id) VALUES ('evidence-1'), ('evidence-2');
  `);
  database.exec(fs.readFileSync(migration, "utf8"));
  return database;
}

function insertCapture(
  database: BetterSqlite3.Database,
  status: "formed" | "unavailable",
  factFrameJson: string | null,
  evidenceObjectId = "evidence-1"
): void {
  database.prepare(`
    INSERT INTO evidence_fact_frame_formations (
      evidence_object_id, workspace_id, schema_version, operator_id, status,
      producer_operator_id, source_hash, fact_frame_json, capture_digest
    ) VALUES (?, 'workspace-1', 1, 'evidence_fact_frame_formation_v1', ?, ?,
      'hash-1', ?, ?)
  `).run(
    evidenceObjectId,
    status,
    status === "formed" ? "producer-v1" : null,
    factFrameJson,
    `sha256:${"a".repeat(64)}`
  );
}
