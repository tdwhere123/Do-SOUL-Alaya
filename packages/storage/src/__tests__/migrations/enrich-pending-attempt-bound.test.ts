import { afterEach, describe, expect, it } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import { StorageDatabase } from "../../sqlite/db.js";
import { SqliteEnrichPendingRepo } from "../../repos/garden/enrich-pending-repo.js";
import { openBaselineDatabase, seedWorkspaceRow } from "./apply-baseline.js";

const openDbs = new Set<BetterSqlite3.Database>();

afterEach(() => {
  for (const db of openDbs) {
    db.close();
  }
  openDbs.clear();
});

describe("enrich_pending attempt bound", () => {
  it("defaults retry columns and excludes abandoned rows from the claimable index", () => {
    const db = openBaselineDatabase();
    openDbs.add(db);
    seedWorkspaceRow(db, "workspace-1");
    seedPendingRow(db, "memory-abandoned", "2026-05-30T00:00:00.000Z");
    seedPendingRow(db, "memory-healthy", "2026-05-30T00:01:00.000Z");

    const rows = db
      .prepare(
        `SELECT memory_id, attempt_count, abandoned_at
        FROM enrich_pending
        ORDER BY memory_id ASC`
      )
      .all() as ReadonlyArray<{
      readonly memory_id: string;
      readonly attempt_count: number;
      readonly abandoned_at: string | null;
    }>;
    expect(rows).toEqual([
      { memory_id: "memory-abandoned", attempt_count: 0, abandoned_at: null },
      { memory_id: "memory-healthy", attempt_count: 0, abandoned_at: null }
    ]);

    const indexSqlRow = db
      .prepare(
        `SELECT sql
        FROM sqlite_master
        WHERE type = 'index' AND name = 'idx_enrich_pending_claimable'`
      )
      .get() as Readonly<{ readonly sql: string }> | undefined;
    expect(indexSqlRow?.sql).toContain("abandoned_at IS NULL");

    db.prepare(
      `UPDATE enrich_pending
      SET attempt_count = 3, abandoned_at = ?
      WHERE workspace_id = ? AND memory_id = ?`
    ).run("2026-05-30T02:00:00.000Z", "workspace-1", "memory-abandoned");

    const repo = new SqliteEnrichPendingRepo(new StorageDatabase(":memory:", db));
    const claimed = repo.claimBatch("workspace-1", 5, "2026-05-30T03:00:00.000Z", 3);
    expect(claimed.map((entry) => entry.memoryId)).toEqual(["memory-healthy"]);
  });
});

function seedPendingRow(
  db: BetterSqlite3.Database,
  memoryId: string,
  enqueuedAt: string
): void {
  db.prepare(
    `INSERT INTO enrich_pending (
      workspace_id, memory_id, run_id, source_signal_id, enqueued_at, claimed_at, processed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run("workspace-1", memoryId, "run-1", `${memoryId}-signal`, enqueuedAt, null, null);
}
