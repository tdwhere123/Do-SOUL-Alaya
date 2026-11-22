import { readFileSync } from "node:fs";
import BetterSqlite3 from "better-sqlite3";
import { expect, it } from "vitest";
import { registerRetainedSourceChunkDigest } from "../../sqlite/retained-source-chunk-digest.js";
import { registerUtcInstantComparison } from "../../sqlite/utc-instant-comparison.js";
import { applyBaselineSql, seedWorkspaceRow } from "./apply-baseline.js";

it("preserves existing proof decisions and allows a runless human erase review", () => {
  const db = new BetterSqlite3(":memory:");
  try {
    registerRetainedSourceChunkDigest(db);
    registerUtcInstantComparison(db);
    db.pragma("foreign_keys = OFF");
    applyBaselineSql(db, 49);
    db.pragma("foreign_keys = ON");
    seedWorkspaceRow(db, "workspace");
    const insert = () => db.prepare(`
      INSERT INTO proof_effect_decisions VALUES
        ('workspace', ?, 2, 'reviewer', ?, 'proposal', ?, 'source', 'workspace',
         '2026-11-01T00:00:00Z', 'allow', '[]', '[]', 'frontier', 'policy', '1', '2026-11-01T00:00:00Z')
    `);
    insert().run("existing", "prior-run", "erase");
    const migration = readFileSync(new URL("../../migrations/050-human-review-without-run.sql", import.meta.url), "utf8");
    db.transaction(() => db.exec(migration)).immediate();

    insert().run("human", null, "erase");
    expect(() => insert().run("other", null, "read")).toThrow(/CHECK constraint failed/u);
    expect(db.prepare("SELECT request_digest, run_id FROM proof_effect_decisions ORDER BY request_digest").all())
      .toEqual([{ request_digest: "existing", run_id: "prior-run" }, { request_digest: "human", run_id: null }]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  } finally {
    db.close();
  }
});
