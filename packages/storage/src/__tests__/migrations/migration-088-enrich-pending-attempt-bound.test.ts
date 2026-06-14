import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { StorageDatabase } from "../../sqlite/db.js";
import { SqliteEnrichPendingRepo } from "../../repos/garden/enrich-pending-repo.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations", import.meta.url));
const MIGRATION_088 = "088-enrich-pending-attempt-bound.sql";

const openDbs = new Set<BetterSqlite3.Database>();

afterEach(() => {
  for (const db of openDbs) {
    db.close();
  }
  openDbs.clear();
});

function listMigrationFiles(): readonly string[] {
  return fs
    .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();
}

function applyMigration(db: BetterSqlite3.Database, fileName: string): void {
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, fileName), "utf8");
  db.transaction(() => {
    db.exec(sql);
  })();
}

function migrateThroughPre088(): BetterSqlite3.Database {
  const db = new BetterSqlite3(":memory:");
  openDbs.add(db);
  db.pragma("foreign_keys = ON");
  for (const fileName of listMigrationFiles()) {
    if (fileName === MIGRATION_088) {
      break;
    }
    applyMigration(db, fileName);
  }
  return db;
}

function seedWorkspace(db: BetterSqlite3.Database): void {
  db.prepare(
    `INSERT INTO workspaces (
      workspace_id, name, root_path, workspace_kind,
      default_engine_binding, workspace_state, created_at, archived_at, default_engine_class
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    "workspace-1",
    "Enrich Queue Workspace",
    "/tmp/workspace-1",
    "local_repo",
    null,
    "active",
    "2026-05-30T00:00:00.000Z",
    null,
    null
  );
}

function seedPre088PendingRow(
  db: BetterSqlite3.Database,
  input: {
    readonly memoryId: string;
    readonly enqueuedAt: string;
  }
): void {
  db.prepare(
    `INSERT INTO enrich_pending (
      workspace_id,
      memory_id,
      run_id,
      source_signal_id,
      enqueued_at,
      claimed_at,
      processed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run("workspace-1", input.memoryId, "run-1", `${input.memoryId}-signal`, input.enqueuedAt, null, null);
}

describe("migration 088 enrich_pending attempt bound", () => {
  it("backfills retry columns for pre-088 rows and rebuilds the claimable index to exclude abandoned rows", () => {
    const db = migrateThroughPre088();
    seedWorkspace(db);
    seedPre088PendingRow(db, {
      memoryId: "memory-abandoned",
      enqueuedAt: "2026-05-30T00:00:00.000Z"
    });
    seedPre088PendingRow(db, {
      memoryId: "memory-healthy",
      enqueuedAt: "2026-05-30T00:01:00.000Z"
    });

    applyMigration(db, MIGRATION_088);

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
