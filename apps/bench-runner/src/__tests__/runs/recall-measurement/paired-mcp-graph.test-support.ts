import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import { createAuditedSourceAdmission, EventPublisher, fieldContractSha256, RelationAssertionService, SessionStructuralRelationService,
  type RoundStructuralNode, type StructuralSourceEventRecord } from "@do-soul/alaya-core";
import { initDatabase, SqliteEventLogRepo, SqliteRelationAssertionRepo } from "@do-soul/alaya-storage";
import { createDaemonFieldRepos } from "../../../../../core-daemon/src/runtime/field/field-repos.js";
import { createSqliteFieldFormationStores } from "../../../../../core-daemon/src/runtime/field/sqlite-field-formation-stores.js";
import { hashRegularFileNoFollow } from "../../../runs/snapshot/bound-file.js";
import type { SemanticChainConfig } from "../../../runs/recall-measurement/contract.js";

export async function withHistoricalGraph(config: SemanticChainConfig, root: string, anchor: string, neighbor: string) {
  const control = join(root, "ordinary-indexed-with-retained-neighbor.sqlite");
  copyFileSync(config.snapshot_path, control);
  await admitUnindexedNeighbor(control, config.workspace_id, neighbor);
  const snapshot = join(root, "ordinary-indexed-with-relations.sqlite");
  copyFileSync(control, snapshot);
  const database = initDatabase({ filename: snapshot });
  const workspaceId = config.workspace_id;
  let neighborRoot: string;
  try {
    // These two fixture records represent successive rounds of the same authored container.
    const rounds = [anchor, neighbor].map((body, roundIndex): RoundStructuralNode => {
      const row = database.connection.prepare(`SELECT record_id, event_time FROM source_records
        WHERE workspace_id = ? AND instr(source_body, ?) > 0`).get(workspaceId, body) as {
          record_id: string; event_time: string;
        };
      const event = database.connection.prepare(`SELECT * FROM event_log
        WHERE workspace_id = ? AND entity_id = ? AND event_type = 'soul.field.source_record.admitted'`)
        .get(workspaceId, row.record_id) as StructuralSourceEventRecord & { payload_json: string };
      return { workspaceId, containerKey: "authored-round-pair", roundIndex, recordId: row.record_id,
        observedAt: row.event_time, sourceOccurredAt: row.event_time,
        sourceEvent: { ...event, payload_json: JSON.parse(event.payload_json) } };
    });
    neighborRoot = rounds[1]!.recordId;
    const eventLogRepo = new SqliteEventLogRepo(database);
    const eventPublisher = new EventPublisher({ eventLogRepo,
      runtimeNotifier: { notify: async () => undefined, notifyEntry: async () => undefined },
      runHotStateService: { apply: () => undefined } });
    const assertionService = new RelationAssertionService({
      repo: new SqliteRelationAssertionRepo(database), eventHistory: eventLogRepo, eventPublisher
    });
    const materialized = await new SessionStructuralRelationService({ assertionService }).materialize({
      workspaceId, runId: null, causedBy: "authored_fixture", rounds, statements: [], useSourceRecordedTime: true
    });
    expect(materialized).toMatchObject({ assertionsAdmitted: 2, assertionsFailed: 0 });
    const admittedTimes = database.connection.prepare("SELECT admitted_at FROM relation_assertions WHERE workspace_id = ?")
      .pluck().all(workspaceId);
    expect(admittedTimes).toEqual(rounds.map(() => rounds[1]!.sourceOccurredAt));
    expect(rounds[1]!.sourceOccurredAt < config.interpretation_clock).toBe(true);
    database.connection.pragma("wal_checkpoint(TRUNCATE)");
    database.connection.pragma("journal_mode = DELETE");
  } finally { database.close({ optimize: false }); }
  expect(hashRegularFileNoFollow(config.snapshot_path)).toBe(config.snapshot_sha256);
  const bind = (path: string) => ({ ...config, snapshot_path: path, snapshot_sha256: hashRegularFileNoFollow(path) });
  return { control: bind(control), graph: bind(snapshot), neighborRoot };
}

async function admitUnindexedNeighbor(snapshot: string, workspaceId: string, body: string) {
  const database = initDatabase({ filename: snapshot });
  try {
    const stores = createSqliteFieldFormationStores({ database, repos: createDaemonFieldRepos({ database }) });
    const admission = createAuditedSourceAdmission({ stores, eventLogRepo: new SqliteEventLogRepo(database),
      runtimeNotifier: { notifyEntry: async () => undefined }, sha256: fieldContractSha256 });
    await admission.admit({
      workspace_id: workspaceId, source_id: "authored-neighbor", source_version: "1", content_bytes: body,
      evidence_object_id: null, recorded_at: "2026-09-13T00:00:00.000Z", event_time: "2023-09-12T00:01:00.000Z",
      valid_from: null, valid_to: null, speaker: "user", scope_class: "project", spans: []
    }, { workspaceId });
    database.connection.pragma("wal_checkpoint(TRUNCATE)");
    database.connection.pragma("journal_mode = DELETE");
  } finally { database.close({ optimize: false }); }
}
