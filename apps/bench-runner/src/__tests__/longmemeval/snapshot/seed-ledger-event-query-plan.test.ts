import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { SignalEventType } from "@do-soul/alaya-protocol";
import {
  SNAPSHOT_RECONCILIATION_NOOP_EVENT_SQL,
  SNAPSHOT_SIGNAL_MATERIALIZATION_EVENT_SQL
} from "../../../longmemeval/snapshot/seed-ledger/seed-ledger-materialization-proof.js";

describe("snapshot seed-ledger event query plans", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE event_log (
        event_type TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        run_id TEXT,
        caused_by TEXT,
        payload_json TEXT NOT NULL,
        revision INTEGER NOT NULL
      );
      CREATE INDEX idx_event_log_type ON event_log(event_type);
      CREATE INDEX idx_event_log_entity ON event_log(entity_type, entity_id);
      CREATE INDEX idx_event_log_entity_revision
        ON event_log(entity_type, entity_id, revision);
    `);
  });

  afterEach(() => {
    db.close();
  });

  it.each([
    [
      "materialization",
      SNAPSHOT_SIGNAL_MATERIALIZATION_EVENT_SQL,
      ["signal-1", SignalEventType.SOUL_SIGNAL_MATERIALIZED]
    ],
    [
      "reconciliation NOOP",
      SNAPSHOT_RECONCILIATION_NOOP_EVENT_SQL,
      ["signal-1:noop_audit"]
    ]
  ] as const)("uses the entity lookup index for %s proof", (_label, sql, params) => {
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{
      readonly detail: string;
    }>;

    expect(plan.map((row) => row.detail).join("\n")).toMatch(
      /SEARCH event_log USING INDEX idx_event_log_entity(?:_revision)? \(entity_type=\? AND entity_id=\?\)/u
    );
  });
});
