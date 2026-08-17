import { afterEach, describe, expect, it } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import { insertEvidenceCapsule, openBaselineDatabase } from "./apply-baseline.js";

const databases = new Set<BetterSqlite3.Database>();

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

describe("evidence semantic factor formations", () => {
  it("stores formed and unavailable captures and cascades with evidence", () => {
    const database = createDatabase();
    insertCapture(database, "formed", JSON.stringify({
      schema_version: 1,
      source_kind: "evidence",
      factors: [],
      variables: [],
      propositions: []
    }));
    insertCapture(database, "unavailable", null, "evidence-2");

    expect(database.prepare(`
      SELECT evidence_object_id, status FROM evidence_semantic_factor_formations
      ORDER BY evidence_object_id
    `).all()).toEqual([
      { evidence_object_id: "evidence-1", status: "formed" },
      { evidence_object_id: "evidence-2", status: "unavailable" }
    ]);
    database.prepare("DELETE FROM evidence_capsules WHERE object_id = 'evidence-1'").run();
    expect(database.prepare(`
      SELECT evidence_object_id FROM evidence_semantic_factor_formations
    `).all()).toEqual([{ evidence_object_id: "evidence-2" }]);
  });

  it("rejects unsealed state shapes", () => {
    const database = createDatabase();
    expect(() => insertCapture(database, "formed", null)).toThrow();
    expect(() => insertCapture(database, "unavailable", "{}")).toThrow();
    expect(() => database.prepare(`
      INSERT INTO evidence_semantic_factor_formations (
        evidence_object_id, workspace_id, schema_version, operator_id, status,
        producer_operator_id, source_sha256, graph_json, capture_digest
      ) VALUES ('evidence-1', 'workspace-1', 1,
        'open_semantic_factor_formation_v1', 'unavailable', NULL,
        'sha256:${"b".repeat(64)}', NULL, 'bad')
    `).run()).toThrow();
  });
});

function createDatabase(): BetterSqlite3.Database {
  const database = openBaselineDatabase();
  databases.add(database);
  insertEvidenceCapsule(database, "evidence-1", { gist: "formed source" });
  insertEvidenceCapsule(database, "evidence-2", { gist: "unavailable source" });
  return database;
}

function insertCapture(
  database: BetterSqlite3.Database,
  status: "formed" | "unavailable",
  graphJson: string | null,
  evidenceObjectId = "evidence-1"
): void {
  database.prepare(`
    INSERT INTO evidence_semantic_factor_formations (
      evidence_object_id, workspace_id, schema_version, operator_id, status,
      producer_operator_id, source_sha256, graph_json, capture_digest
    ) VALUES (?, 'workspace-1', 1, 'open_semantic_factor_formation_v1', ?, ?,
      'sha256:${"b".repeat(64)}', ?, ?)
  `).run(
    evidenceObjectId,
    status,
    status === "formed" ? "producer-v1" : null,
    graphJson,
    `sha256:${"a".repeat(64)}`
  );
}
