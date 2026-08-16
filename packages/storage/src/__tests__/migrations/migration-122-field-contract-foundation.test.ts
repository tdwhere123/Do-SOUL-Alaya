import fs from "node:fs";
import { fileURLToPath } from "node:url";
import BetterSqlite3 from "better-sqlite3";
import { describe, expect, it } from "vitest";

const migration = fileURLToPath(new URL(
  "../../migrations/122-field-contract-foundation.sql",
  import.meta.url
));

describe("migration 122 field contract foundation", () => {
  it("applies workspace-qualified keys and rejects inverted spans and delivery learning", () => {
    const database = createDatabase();
    try {
      database.exec(fs.readFileSync(migration, "utf8"));
      insertRecord(database, "workspace-1", "record-1", "visible body");
      insertRecord(database, "workspace-2", "record-1", "other body");
      database.prepare(`
        INSERT INTO source_spans (
          span_id, record_id, start_offset, end_offset, purpose, producer_version,
          workspace_id, recorded_at
        ) VALUES ('span-1', 'record-1', 0, 4, 'sentence', 'source_span_identity_v1',
          'workspace-1', '2026-08-16T00:00:00.000Z')
      `).run();

      expect(database.prepare(`
        SELECT workspace_id, record_id FROM source_records ORDER BY workspace_id
      `).all()).toEqual([
        { workspace_id: "workspace-1", record_id: "record-1" },
        { workspace_id: "workspace-2", record_id: "record-1" }
      ]);
      expect(() => database.prepare(`
        INSERT INTO source_spans (
          span_id, record_id, start_offset, end_offset, purpose, producer_version,
          workspace_id, recorded_at
        ) VALUES ('span-bad', 'record-1', 4, 2, 'sentence', 'source_span_identity_v1',
          'workspace-1', '2026-08-16T00:00:00.000Z')
      `).run()).toThrow(/CHECK constraint failed/u);
      expect(() => database.prepare(`
        INSERT INTO source_spans (
          span_id, record_id, start_offset, end_offset, purpose, producer_version,
          workspace_id, recorded_at
        ) VALUES ('span-neg', 'record-1', -1, 2, 'sentence', 'source_span_identity_v1',
          'workspace-1', '2026-08-16T00:00:00.000Z')
      `).run()).toThrow(/CHECK constraint failed/u);
      expect(() => database.prepare(`
        INSERT INTO causal_usage_receipts (
          identity, workspace_id, causal_key, occurred_at, downstream_ref, weight,
          scope, usage_kind, operator_id, recorded_at
        ) VALUES (?, 'workspace-1', 'use-1', '2026-08-16T00:00:00.000Z', 'path-1',
          0.5, 'workspace-1', 'delivery', 'causal_usage_v1', '2026-08-16T00:00:00.000Z')
      `).run("sha256:" + "a".repeat(64))).toThrow(/CHECK constraint failed/u);
      expect(() => database.prepare(`
        INSERT INTO causal_usage_receipts (
          identity, workspace_id, causal_key, occurred_at, downstream_ref, weight,
          scope, usage_kind, operator_id, recorded_at
        ) VALUES (?, 'workspace-1', 'use-2', '2026-08-16T00:00:00.000Z', 'path-1',
          1e999, 'workspace-1', 'causal', 'causal_usage_v1', '2026-08-16T00:00:00.000Z')
      `).run("sha256:" + "b".repeat(64))).toThrow(/CHECK constraint failed/u);
    } finally {
      database.close();
    }
  });
});

function createDatabase(): BetterSqlite3.Database {
  const database = new BetterSqlite3(":memory:");
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE workspaces (workspace_id TEXT PRIMARY KEY);
    INSERT INTO workspaces (workspace_id) VALUES ('workspace-1'), ('workspace-2');
  `);
  return database;
}

function insertRecord(
  database: BetterSqlite3.Database,
  workspaceId: string,
  recordId: string,
  sourceBody: string
): void {
  database.prepare(`
    INSERT INTO source_records (
      record_id, workspace_id, source_id, source_version, content_digest,
      evidence_object_id, recorded_at, event_time, valid_from, valid_to,
      operator_id, source_body
    ) VALUES (?, ?, 'src-1', 'v1', 'sha256:aaa', NULL, '2026-08-16T00:00:00.000Z',
      NULL, NULL, NULL, 'source_span_identity_v1', ?)
  `).run(recordId, workspaceId, sourceBody);
}
