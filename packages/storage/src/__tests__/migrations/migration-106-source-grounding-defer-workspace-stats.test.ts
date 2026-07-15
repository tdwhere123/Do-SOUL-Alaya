import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations", import.meta.url));
const MIGRATION_106 = "106-source-grounding-defer-workspace-stats.sql";
const databases = new Set<BetterSqlite3.Database>();

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

describe("migration 106 source-grounding workspace stats", () => {
  it("upgrades 105 rows and rebuilds per-workspace counts from audit evidence", () => {
    const database = migrateThrough105();
    seedWorkspace(database, "workspace-a");
    seedWorkspace(database, "workspace-b");
    seedQueueRow(database, "workspace-a", "signal-a");
    seedQueueRow(database, "workspace-b", "signal-b");
    database.prepare(`
      INSERT INTO source_grounding_defer_reason_counts (defer_reason, enqueue_count)
      VALUES ('source_assertion_incomplete', 99)
    `).run();
    seedDeferEvent(database, "workspace-a", "event-a1");
    seedDeferEvent(database, "workspace-a", "event-a2");
    seedDeferEvent(database, "workspace-b", "event-b1");

    applyMigration(database, MIGRATION_106);

    expect(database.prepare(`
      SELECT workspace_id, defer_reason, enqueue_count
      FROM source_grounding_defer_reason_counts
      ORDER BY workspace_id
    `).all()).toEqual([
      {
        workspace_id: "workspace-a",
        defer_reason: "source_assertion_incomplete",
        enqueue_count: 2
      },
      {
        workspace_id: "workspace-b",
        defer_reason: "source_assertion_incomplete",
        enqueue_count: 1
      }
    ]);
    expect(database.prepare(`
      SELECT workspace_id, signal_id FROM source_grounding_defer_queue ORDER BY workspace_id
    `).all()).toEqual([
      { workspace_id: "workspace-a", signal_id: "signal-a" },
      { workspace_id: "workspace-b", signal_id: "signal-b" }
    ]);
    const queueColumns = database.prepare(
      `PRAGMA table_info(source_grounding_defer_queue)`
    ).all() as Array<{ readonly name: string }>;
    expect(queueColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "claim_token",
      "claim_token_fingerprint",
      "claim_expires_at",
      "capacity_blocked"
    ]));
    const queueIndexes = database.prepare(
      `PRAGMA index_list(source_grounding_defer_queue)`
    ).all() as Array<{ readonly name: string }>;
    expect(queueIndexes.map((index) => index.name)).toEqual(expect.arrayContaining([
      "idx_source_grounding_defer_queue_workspace_enqueued",
      "idx_source_grounding_defer_queue_claim_expiry",
      "idx_source_grounding_defer_queue_admission"
    ]));
  });
});

function migrateThrough105(): BetterSqlite3.Database {
  const database = new BetterSqlite3(":memory:");
  databases.add(database);
  database.pragma("foreign_keys = ON");
  for (const fileName of listMigrationFiles()) {
    if (fileName === MIGRATION_106) break;
    applyMigration(database, fileName);
  }
  return database;
}

function listMigrationFiles(): readonly string[] {
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter((fileName) => fileName.endsWith(".sql"))
    .sort();
}

function applyMigration(database: BetterSqlite3.Database, fileName: string): void {
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, fileName), "utf8");
  database.transaction(() => database.exec(sql))();
}

function seedWorkspace(database: BetterSqlite3.Database, workspaceId: string): void {
  database.prepare(`
    INSERT INTO workspaces (
      workspace_id, name, root_path, workspace_kind,
      workspace_state, created_at, default_engine_class
    ) VALUES (?, ?, ?, 'local_repo', 'active', ?, NULL)
  `).run(workspaceId, workspaceId, `/tmp/${workspaceId}`, "2026-07-15T00:00:00.000Z");
}

function seedQueueRow(
  database: BetterSqlite3.Database,
  workspaceId: string,
  signalId: string
): void {
  database.prepare(`
    INSERT INTO source_grounding_defer_queue (
      signal_id, workspace_id, run_id, defer_reason, enqueued_at
    ) VALUES (?, ?, ?, 'source_assertion_incomplete', ?)
  `).run(signalId, workspaceId, `run-${workspaceId}`, "2026-07-15T00:00:00.000Z");
}

function seedDeferEvent(
  database: BetterSqlite3.Database,
  workspaceId: string,
  eventId: string
): void {
  database.prepare(`
    INSERT INTO event_log (
      event_id, event_type, entity_type, entity_id, workspace_id,
      run_id, caused_by, revision, payload_json, created_at
    ) VALUES (?, 'soul.signal.triaged', 'candidate_memory_signal', ?, ?, ?,
      'materialization_router', 0, ?, ?)
  `).run(
    eventId,
    `signal-${eventId}`,
    workspaceId,
    `run-${workspaceId}`,
    JSON.stringify({
      triage_result: "deferred",
      defer_class: "source_grounding",
      defer_reason: "source_assertion_incomplete"
    }),
    "2026-07-15T00:00:00.000Z"
  );
}
