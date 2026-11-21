import { readFileSync } from "node:fs";
import BetterSqlite3 from "better-sqlite3";
import { expect, it } from "vitest";
import { registerRetainedSourceChunkDigest } from "../../sqlite/retained-source-chunk-digest.js";
import { registerUtcInstantComparison } from "../../sqlite/utc-instant-comparison.js";
import { applyBaselineSql } from "./apply-baseline.js";

it("invalidates statement vectors and pending work by typed root or dependency", () => {
  const db = new BetterSqlite3(":memory:");
  try {
    registerRetainedSourceChunkDigest(db);
    registerUtcInstantComparison(db);
    db.pragma("foreign_keys = OFF");
    applyBaselineSql(db, 51);
    db.pragma("foreign_keys = ON");
    seedOverlay(db);

    const sql = readFileSync(new URL("../../migrations/052-source-relation-vector-trigger-and-index-hygiene.sql", import.meta.url), "utf8");
    db.transaction(() => db.exec(sql)).immediate();
    const invalidate = db.prepare("INSERT INTO source_index_invalidations VALUES ('workspace', ?, 'same-id', NULL)");
    invalidate.run("evidence_capsule");

    for (const table of ["source_statement_relation_vectors", "source_statement_relation_pending"]) {
      expect(db.prepare(`SELECT workspace_id, root_key FROM ${table} ORDER BY workspace_id, root_key`).all()).toEqual([
        { workspace_id: "other", root_key: "statement" },
        { workspace_id: "workspace", root_key: "statement" }
      ]);
      const index = `idx_${table}_root`;
      expect(db.prepare("SELECT name FROM pragma_index_info(?) ORDER BY seqno").all(index))
        .toEqual([{ name: "workspace_id" }, { name: "root_key" }]);
    }
    invalidate.run("source_record");
    for (const table of ["source_statement_relation_vectors", "source_statement_relation_pending"]) {
      expect(db.prepare(`SELECT workspace_id, root_key FROM ${table}`).all())
        .toEqual([{ workspace_id: "other", root_key: "statement" }]);
    }
    expect(db.prepare("SELECT name FROM pragma_index_list('projection_erase_barriers') WHERE name = ?")
      .get("idx_source_erase_recovery_subject")).toBeUndefined();
    expect(db.pragma("foreign_key_check")).toEqual([]);
  } finally {
    db.close();
  }
});

function seedOverlay(db: BetterSqlite3.Database): void {
  db.exec(`
    INSERT INTO source_index_roots VALUES
      ('workspace', 'statement', 'source_record', 'same-id', 'source', '{}'),
      ('workspace', 'capsule', 'evidence_capsule', 'same-id', NULL, '{}'),
      ('workspace', 'dependent', 'source_record', 'another-id', 'another-source', '{}'),
      ('other', 'statement', 'source_record', 'same-id', 'source', '{}');
    INSERT INTO source_index_dependencies VALUES
      ('workspace', 'dependent', 'evidence_capsule', 'same-id', NULL);
    INSERT INTO source_statement_relation_vectors
      SELECT workspace_id, 'generation', root_key, 'digest', 1, zeroblob(4), 1 FROM source_index_roots;
    INSERT INTO source_statement_relation_pending
      SELECT workspace_id, generation_id, root_key FROM source_statement_relation_vectors;
  `);
}
