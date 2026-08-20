import { afterEach, describe, expect, it } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import { openBaselineDatabase, seedWorkspaceRow } from "./apply-baseline.js";

const databases = new Set<BetterSqlite3.Database>();

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

describe("soft association path relations", () => {
  it("does not promote legacy projections without usage authority", () => {
    const database = openBaselineDatabase();
    databases.add(database);
    seedWorkspaceRow(database, "workspace-1");
    insertPath(database, "path_relations", "canonical", "co_recalled", "attention_only");
    insertPath(database, "path_relations", "legacy-truth", "supports", "recall_allowed");

    expect(database.prepare(
      "SELECT path_id FROM soft_association_path_relations ORDER BY path_id"
    ).all()).toEqual([]);
    expect(() => insertPath(
      database,
      "soft_association_path_relations",
      "invalid-soft",
      "supports",
      "attention_only"
    )).toThrow(/CHECK constraint failed/u);
  });
});

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
