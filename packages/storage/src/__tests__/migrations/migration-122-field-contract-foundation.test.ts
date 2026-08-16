import fs from "node:fs";
import { fileURLToPath } from "node:url";
import BetterSqlite3 from "better-sqlite3";
import { describe, expect, it } from "vitest";

const migration = fileURLToPath(new URL(
  "../../migrations/122-field-contract-foundation.sql",
  import.meta.url
));

describe("migration 122 field contract foundation", () => {
  it("applies identity tables and rejects inverted spans and delivery learning", () => {
    const database = createDatabase();
    try {
      database.exec(fs.readFileSync(migration, "utf8"));
      insertRecord(database, "record-1", "visible body");
      database.prepare(`
        INSERT INTO source_spans (
          span_id, record_id, start_offset, end_offset, purpose, producer_version, workspace_id
        ) VALUES ('span-1', 'record-1', 0, 4, 'sentence', 'source_span_identity_v1', 'workspace-1')
      `).run();

      expect(database.prepare("SELECT record_id FROM source_records").all()).toEqual([
        { record_id: "record-1" }
      ]);
      expect(() => database.prepare(`
        INSERT INTO source_spans (
          span_id, record_id, start_offset, end_offset, purpose, producer_version, workspace_id
        ) VALUES ('span-bad', 'record-1', 4, 2, 'sentence', 'source_span_identity_v1', 'workspace-1')
      `).run()).toThrow(/CHECK constraint failed/u);
      expect(() => database.prepare(`
        INSERT INTO causal_usage_receipts (
          receipt_id, workspace_id, causal_key, occurred_at, downstream_ref, weight, scope, usage_kind
        ) VALUES ('usage-1', 'workspace-1', 'use-1', '2026-08-16T00:00:00.000Z', 'path-1', 0.5, 'workspace-1', 'delivery')
      `).run()).toThrow(/CHECK constraint failed/u);
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
    INSERT INTO workspaces (workspace_id) VALUES ('workspace-1');
  `);
  return database;
}

function insertRecord(
  database: BetterSqlite3.Database,
  recordId: string,
  sourceBody: string
): void {
  database.prepare(`
    INSERT INTO source_records (
      record_id, workspace_id, source_id, source_version, content_digest,
      evidence_object_id, recorded_at, operator_version, source_body
    ) VALUES (?, 'workspace-1', 'src-1', 'v1', 'sha256:aaa', NULL, '2026-08-16T00:00:00.000Z',
      'source_span_identity_v1', ?)
  `).run(recordId, sourceBody);
}
