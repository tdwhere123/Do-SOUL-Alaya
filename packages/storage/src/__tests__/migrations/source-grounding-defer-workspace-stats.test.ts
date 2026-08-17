import { afterEach, describe, expect, it } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import { openBaselineDatabase, seedWorkspaceRow } from "./apply-baseline.js";

const databases = new Set<BetterSqlite3.Database>();

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

describe("source-grounding workspace stats", () => {
  it("stores per-workspace queue rows and reason counts", () => {
    const database = openBaselineDatabase();
    databases.add(database);
    seedWorkspaceRow(database, "workspace-a");
    seedWorkspaceRow(database, "workspace-b");
    seedQueueRow(database, "workspace-a", "signal-a");
    seedQueueRow(database, "workspace-b", "signal-b");
    database.prepare(`
      INSERT INTO source_grounding_defer_reason_counts (workspace_id, defer_reason, enqueue_count)
      VALUES ('workspace-a', 'source_assertion_incomplete', 2),
             ('workspace-b', 'source_assertion_incomplete', 1)
    `).run();

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
