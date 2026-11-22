import { readFileSync } from "node:fs";
import BetterSqlite3 from "better-sqlite3";
import { expect, it } from "vitest";
import { registerRetainedSourceChunkDigest } from "../../sqlite/retained-source-chunk-digest.js";
import { registerUtcInstantComparison } from "../../sqlite/utc-instant-comparison.js";
import { applyBaselineSql, insertEvidenceCapsule, seedWorkspaceRow } from "./apply-baseline.js";

it("retires populated formation and factor tables without removing their source spans", () => {
  const db = new BetterSqlite3(":memory:");
  try {
    registerRetainedSourceChunkDigest(db);
    registerUtcInstantComparison(db);
    db.pragma("foreign_keys = OFF");
    applyBaselineSql(db, 50);
    db.pragma("foreign_keys = ON");
    seedWorkspaceRow(db, "workspace");
    seedFactors(db);
    seedFormations(db);
    const retired = [
      "factor_descriptors", "factor_incidences",
      "evidence_fact_frame_formations", "evidence_semantic_factor_formations"
    ];
    const retiredSchema = db.prepare("SELECT name FROM sqlite_schema WHERE tbl_name IN (SELECT value FROM json_each(?))");
    expect(retiredSchema.all(JSON.stringify(retired)).length).toBeGreaterThan(retired.length);

    const sql = readFileSync(new URL("../../migrations/051-retire-formations-and-factors.sql", import.meta.url), "utf8");
    db.transaction(() => db.exec(sql)).immediate();

    expect(retiredSchema.all(JSON.stringify(retired))).toEqual([]);
    expect(db.prepare("SELECT span_id FROM source_spans").all()).toEqual([{ span_id: "span" }]);
    expect(db.prepare("SELECT source_body FROM source_records").all()).toEqual([{ source_body: "retained body" }]);
    expect(db.prepare("SELECT gist FROM evidence_capsules").all()).toEqual([{ gist: "retained gist" }]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  } finally {
    db.close();
  }
});

function seedFactors(db: BetterSqlite3.Database): void {
  db.exec(`
    INSERT INTO source_records (
      workspace_id, record_id, source_id, source_version, content_digest, recorded_at, operator_id, source_body
    ) VALUES ('workspace', 'record', 'source', '1', 'digest', '2026-11-01T00:00:00Z', 'operator', 'retained body');
    INSERT INTO source_spans (
      workspace_id, span_id, record_id, start_offset, end_offset, purpose, producer_version, recorded_at
    ) VALUES ('workspace', 'span', 'record', 0, 13, 'sentence', 'operator', '2026-11-01T00:00:00Z');
    INSERT INTO factor_descriptors (
      workspace_id, factor_id, family, canonical_payload, operator_id, recorded_at
    ) VALUES ('workspace', 'factor', 'f0', 'retained body', 'operator', '2026-11-01T00:00:00Z');
    INSERT INTO factor_incidences (
      workspace_id, incidence_id, span_id, factor_id, scope, operator_id, recorded_at
    ) VALUES ('workspace', 'incidence', 'span', 'factor', 'workspace', 'operator', '2026-11-01T00:00:00Z');
  `);
}

function seedFormations(db: BetterSqlite3.Database): void {
  insertEvidenceCapsule(db, "evidence", { workspaceId: "workspace", gist: "retained gist" });
  const digest = `sha256:${"a".repeat(64)}`;
  db.prepare(`
    INSERT INTO evidence_fact_frame_formations (
      evidence_object_id, workspace_id, schema_version, operator_id, status, capture_digest
    ) VALUES ('evidence', 'workspace', 1, 'evidence_fact_frame_formation_v1', 'unavailable', ?)
  `).run(digest);
  db.prepare(`
    INSERT INTO evidence_semantic_factor_formations (
      evidence_object_id, workspace_id, schema_version, operator_id, status, capture_digest
    ) VALUES ('evidence', 'workspace', 1, 'open_semantic_factor_formation_v1', 'unavailable', ?)
  `).run(digest);
}
