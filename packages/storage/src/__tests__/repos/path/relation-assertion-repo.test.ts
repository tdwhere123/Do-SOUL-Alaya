import { afterEach, describe, expect, it } from "vitest";
import type { EventLogEntry, PathRelation } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../../sqlite/db.js";
import { SqliteEventLogRepo } from "../../../repos/runtime/event-log-repo.js";
import { SqliteRelationAssertionRepo } from "../../../repos/path/relation-assertion-repo.js";
import { digestRelationFormationEventSource } from "../../../repos/path/relation-assertion/source-digest.js";
import {
  createEvidenceCapsule,
  createEvidenceCapsuleRepo
} from "../capsules/evidence-capsule-repo-fixture.js";
import {
  createPathRelationFixture,
  createRepo,
  trackedDatabases
} from "./path-relation-repo-fixture.js";

const asOf = "2026-07-17T01:30:00.000Z";
const currentHistoryDigest = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const staleHistoryDigest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

afterEach(() => {
  for (const database of trackedDatabases) {
    database.close();
  }
  trackedDatabases.clear();
});

describe("SqliteRelationAssertionRepo", () => {
  it("verifies independently anchored evidence receipts against EventLog", async () => {
    const { database, repo: evidenceRepo } = await createEvidenceCapsuleRepo();
    trackedDatabases.add(database);
    const repo = new SqliteRelationAssertionRepo(database);
    const firstEvidenceId = "f6c1b587-be07-4410-b2ca-8bfbc4d82db4";
    const secondEvidenceId = "3ca5f78f-b5fd-4543-99eb-ce72ab2578ab";
    const firstEvent = await appendSourceEvent(database, "workspace-1", "run-1", "response-1");
    const secondEvent = await appendSourceEvent(database, "workspace-1", "run-1", "response-2");

    await evidenceRepo.create(createEvidenceCapsule({
      object_id: firstEvidenceId,
      event_anchor: evidenceReceipt(firstEvidenceId, firstEvent.event_id).source_event_anchor
    }));
    await evidenceRepo.create(createEvidenceCapsule({
      object_id: secondEvidenceId,
      event_anchor: evidenceReceipt(secondEvidenceId, secondEvent.event_id).source_event_anchor
    }));

    expect(() => repo.assertFormationInputsInCurrentTransaction({
      workspaceId: "workspace-1",
      evidenceReceipts: [
        evidenceReceipt(firstEvidenceId, firstEvent.event_id),
        evidenceReceipt(secondEvidenceId, secondEvent.event_id)
      ],
      formationReceipt: formationReceipt([firstEvent, secondEvent])
    })).not.toThrow();
  });

  it("rejects a receipt when any Evidence belongs to another workspace", async () => {
    const { database, repo: evidenceRepo } = await createEvidenceCapsuleRepo();
    trackedDatabases.add(database);
    const repo = new SqliteRelationAssertionRepo(database);
    const workspaceEvidenceId = "f6c1b587-be07-4410-b2ca-8bfbc4d82db4";
    const foreignEvidenceId = "256a7ff5-6150-4a82-9a53-99dbfd08cb77";
    const workspaceEvent = await appendSourceEvent(database, "workspace-1", "run-1", "response-1");
    const foreignEvent = await appendSourceEvent(database, "workspace-2", "run-3", "response-2");

    await evidenceRepo.create(createEvidenceCapsule({
      object_id: workspaceEvidenceId,
      event_anchor: evidenceReceipt(workspaceEvidenceId, workspaceEvent.event_id).source_event_anchor
    }));
    await evidenceRepo.create(createEvidenceCapsule({
      object_id: foreignEvidenceId,
      workspace_id: "workspace-2",
      run_id: "run-3",
      event_anchor: evidenceReceipt(foreignEvidenceId, foreignEvent.event_id).source_event_anchor
    }));

    expect(() => repo.assertFormationInputsInCurrentTransaction({
      workspaceId: "workspace-1",
      evidenceReceipts: [
        evidenceReceipt(workspaceEvidenceId, workspaceEvent.event_id),
        evidenceReceipt(foreignEvidenceId, foreignEvent.event_id)
      ],
      formationReceipt: formationReceipt([workspaceEvent])
    })).toThrow(/Evidence 256a7ff5-6150-4a82-9a53-99dbfd08cb77 is not available in the assertion workspace\./);
  });

  it("rejects a formation source whose digest does not match EventLog", async () => {
    const { database, repo: evidenceRepo } = await createEvidenceCapsuleRepo();
    trackedDatabases.add(database);
    const repo = new SqliteRelationAssertionRepo(database);
    const evidenceId = "f6c1b587-be07-4410-b2ca-8bfbc4d82db4";
    const sourceEvent = await appendSourceEvent(database, "workspace-1", "run-1", "response-1");
    await evidenceRepo.create(createEvidenceCapsule({
      object_id: evidenceId,
      event_anchor: evidenceReceipt(evidenceId, sourceEvent.event_id).source_event_anchor
    }));
    const receipt = formationReceipt([sourceEvent]);

    expect(() => repo.assertFormationInputsInCurrentTransaction({
      workspaceId: "workspace-1",
      evidenceReceipts: [evidenceReceipt(evidenceId, sourceEvent.event_id)],
      formationReceipt: {
        ...receipt,
        source_observations: receipt.source_observations.map((source) => ({
          ...source,
          source_sha256: "0".repeat(64)
        }))
      }
    })).toThrow(/Formation EventLog source .* digest does not match/);
  });

  it("binds an exact as-of read to the current verified history generation", async () => {
    const { database } = createRepo();
    const repo = new SqliteRelationAssertionRepo(database);
    const stalePath = createPathRelationFixture({
      path_id: "path-stale",
      created_at: asOf,
      updated_at: asOf
    });
    const currentPath = createPathRelationFixture({
      path_id: "path-current",
      created_at: asOf,
      updated_at: asOf
    });

    insertAssertion(database.connection, "assertion-stale", "event-stale", "identity-stale");
    insertAssertion(database.connection, "assertion-current", "event-current", "identity-current");
    insertGeneration(database.connection, {
      generation: "temporal-z-stale",
      historyDigest: staleHistoryDigest
    });
    insertGeneration(database.connection, {
      generation: "temporal-a-current",
      historyDigest: currentHistoryDigest
    });
    insertProjection(database.connection, "temporal-z-stale", "assertion-stale", stalePath);
    insertProjection(database.connection, "temporal-a-current", "assertion-current", currentPath);
    database.connection.prepare(`
      UPDATE temporal_schema_state
      SET assertion_schema_generation = 'relation_assertion_v2',
          assertion_event_contract_generation = 'relation_assertion_event_v2',
          projection_schema_generation = 'relation_path_projection_v1',
          active_projection_generation = 'temporal-a-current',
          active_as_of = ?,
          projection_policy_id = 'relation-path-projection-v1',
          projection_policy_sha256 = 'fixture-policy',
          history_digest = ?,
          projection_count = 1,
          projection_digest = 'temporal-a-current-digest'
      WHERE state_id = 1
    `).run(asOf, currentHistoryDigest);

    await expect(repo.findProjectionByWorkspaceAtAsOf("workspace-1", asOf))
      .resolves.toEqual([currentPath]);
  });

  it("fails a current read when the active generation tuple is broken", async () => {
    const { database } = createRepo();
    const repo = new SqliteRelationAssertionRepo(database);
    database.connection.prepare(`
      UPDATE temporal_schema_state
      SET active_projection_generation = 'missing-generation'
      WHERE state_id = 1
    `).run();

    await expect(repo.findActiveProjectionByWorkspace("workspace-1"))
      .rejects.toThrow("active generation is missing or inconsistent");
  });

  it("keeps the active generation while caching a same-history as-of generation", async () => {
    const { database } = createRepo();
    const repo = new SqliteRelationAssertionRepo(database);
    const currentPath = createPathRelationFixture({
      path_id: "assertion-current",
      created_at: asOf,
      updated_at: asOf
    });
    insertAssertion(database.connection, "assertion-current", "event-current", "identity-current");
    repo.writeProjectionGenerationInCurrentTransaction(
      projectionGeneration("temporal-current", currentHistoryDigest, asOf, [currentPath]),
      { activate: true }
    );

    repo.writeProjectionGenerationInCurrentTransaction(
      projectionGeneration(
        "temporal-historical",
        currentHistoryDigest,
        "2026-07-16T01:30:00.000Z",
        []
      ),
      { activate: false }
    );

    await expect(repo.findActiveProjectionByWorkspace("workspace-1"))
      .resolves.toEqual([currentPath]);
    expect(tableCount(database, "temporal_projection_generations")).toBe(2);
  });

  it("retains current-history as-of caches while pruning unreadable histories", async () => {
    const { database } = createRepo();
    const repo = new SqliteRelationAssertionRepo(database);
    const firstPath = createPathRelationFixture({
      path_id: "assertion-first",
      created_at: asOf,
      updated_at: asOf
    });
    insertAssertion(database.connection, "assertion-first", "event-first", "identity-first");

    repo.writeProjectionGenerationInCurrentTransaction(
      projectionGeneration("temporal-current", staleHistoryDigest, asOf, [firstPath]),
      { activate: true }
    );
    const historicalAsOf = "2026-07-16T01:30:00.000Z";
    repo.writeProjectionGenerationInCurrentTransaction(
      projectionGeneration("temporal-as-of", staleHistoryDigest, historicalAsOf, [firstPath]),
      { activate: false }
    );

    await expect(repo.findProjectionByWorkspaceAtAsOf("workspace-1", historicalAsOf))
      .resolves.toEqual([firstPath]);
    expect(tableCount(database, "temporal_projection_generations")).toBe(2);

    const secondPath = createPathRelationFixture({
      path_id: "assertion-second",
      created_at: asOf,
      updated_at: asOf
    });
    insertAssertion(database.connection, "assertion-second", "event-second", "identity-second");
    repo.writeProjectionGenerationInCurrentTransaction(
      projectionGeneration(
        "temporal-next-history",
        currentHistoryDigest,
        "2026-07-18T01:30:00.000Z",
        [firstPath, secondPath]
      ),
      { activate: true }
    );

    expect(tableCount(database, "temporal_projection_generations")).toBe(1);
    expect(tableCount(database, "relation_path_projections")).toBe(2);
    await expect(repo.findProjectionByWorkspaceAtAsOf("workspace-1", historicalAsOf))
      .resolves.toBeNull();
  });

  it("verifies admitted non-erased source_records receipts and rejects erased or mismatched anchors", async () => {
    const { database } = await createEvidenceCapsuleRepo();
    trackedDatabases.add(database);
    const repo = new SqliteRelationAssertionRepo(database);
    const recordId = `sha256:${"d".repeat(64)}`;
    const foreignRecordId = `sha256:${"e".repeat(64)}`;
    const eventTime = "2026-05-01T08:00:00.000Z";
    const recordedAt = "2026-05-02T08:00:00.000Z";
    const admissionEvent = await new SqliteEventLogRepo(database).append({
      event_type: "soul.field.source_record.admitted",
      entity_type: "source_record",
      entity_id: recordId,
      workspace_id: "workspace-1",
      run_id: "run-1",
      caused_by: "test",
      payload_json: { record_id: recordId }
    });
    const foreignAdmissionEvent = await new SqliteEventLogRepo(database).append({
      event_type: "soul.field.source_record.admitted",
      entity_type: "source_record",
      entity_id: foreignRecordId,
      workspace_id: "workspace-2",
      run_id: "run-2",
      caused_by: "test",
      payload_json: { record_id: foreignRecordId }
    });
    database.connection.prepare(`
      INSERT INTO source_records (
        workspace_id, record_id, source_id, source_version, content_digest,
        recorded_at, event_time, operator_id
      ) VALUES (?, ?, 'host-session:s1:r0', 'host-session-v1', ?, ?, ?, 'source_span_identity_v1')
    `).run("workspace-1", recordId, `sha256:${"1".repeat(64)}`, recordedAt, eventTime);
    database.connection.prepare(`
      INSERT INTO source_records (
        workspace_id, record_id, source_id, source_version, content_digest,
        recorded_at, event_time, operator_id
      ) VALUES (?, ?, 'host-session:s2:r0', 'host-session-v1', ?, ?, ?, 'source_span_identity_v1')
    `).run("workspace-2", foreignRecordId, `sha256:${"2".repeat(64)}`, recordedAt, eventTime);

    const validReceipt = {
      evidence_id: recordId,
      source_event_anchor: {
        event_type: "soul.field.source_record.admitted" as const,
        event_id: admissionEvent.event_id,
        occurred_at: eventTime
      }
    };
    expect(() => repo.assertFormationInputsInCurrentTransaction({
      workspaceId: "workspace-1",
      evidenceReceipts: [validReceipt],
      formationReceipt: formationReceipt([admissionEvent])
    })).not.toThrow();

    expect(() => repo.assertFormationInputsInCurrentTransaction({
      workspaceId: "workspace-1",
      evidenceReceipts: [{
        evidence_id: recordId,
        source_event_anchor: {
          event_type: "soul.field.source_record.admitted",
          event_id: admissionEvent.event_id,
          occurred_at: recordedAt
        }
      }],
      formationReceipt: formationReceipt([admissionEvent])
    })).toThrow(/is not anchored to its admitted source EventLog observation\./);

    expect(() => repo.assertFormationInputsInCurrentTransaction({
      workspaceId: "workspace-1",
      evidenceReceipts: [{
        evidence_id: foreignRecordId,
        source_event_anchor: {
          event_type: "soul.field.source_record.admitted",
          event_id: foreignAdmissionEvent.event_id,
          occurred_at: eventTime
        }
      }],
      formationReceipt: formationReceipt([admissionEvent])
    })).toThrow(/is not available in the assertion workspace\./);

    database.connection.prepare(`
      INSERT INTO projection_erase_barriers (
        workspace_id, barrier_id, receipt_identity, generation_id, subject_kind, subject_id, erased_at
      ) VALUES ('workspace-1', 'barrier-1', 'erase-1', NULL, 'source_record', ?, ?)
    `).run(recordId, recordedAt);

    expect(() => repo.assertFormationInputsInCurrentTransaction({
      workspaceId: "workspace-1",
      evidenceReceipts: [validReceipt],
      formationReceipt: formationReceipt([admissionEvent])
    })).toThrow(/Relation formation uses erased evidence/);
  });

});

function insertAssertion(
  connection: { prepare(sql: string): { run(...params: readonly unknown[]): unknown } },
  assertionId: string,
  eventId: string,
  identityKey: string
): void {
  connection.prepare(`
    INSERT INTO relation_assertions (
      assertion_id, workspace_id, admission_event_id, identity_key,
      anchors_json, relation_kind, validity_json, admitted_at
    ) VALUES (?, 'workspace-1', ?, ?, ?, 'supports', ?, ?)
  `).run(
    assertionId,
    eventId,
    identityKey,
    JSON.stringify({
      source_anchor: { kind: "object", object_id: "object-1" },
      target_anchor: { kind: "object", object_id: "object-2" }
    }),
    JSON.stringify({ kind: "open", valid_from: asOf }),
    asOf
  );
}

function insertGeneration(
  connection: { prepare(sql: string): { run(...params: readonly unknown[]): unknown } },
  input: Readonly<{ readonly generation: string; readonly historyDigest: string }>
): void {
  connection.prepare(`
    INSERT INTO temporal_projection_generations (
      generation, assertion_schema_generation, assertion_event_contract_generation,
      projection_schema_generation, projection_policy_id, projection_policy_sha256,
      history_digest, as_of, projection_count, projection_digest, status,
      created_at, verified_at
    ) VALUES (?, 'relation_assertion_v2', 'relation_assertion_event_v2',
      'relation_path_projection_v1', 'relation-path-projection-v1', 'fixture-policy',
      ?, ?, 1, ?, 'verified', ?, ?)
  `).run(
    input.generation,
    input.historyDigest,
    asOf,
    `${input.generation}-digest`,
    asOf,
    asOf
  );
}

function insertProjection(
  connection: { prepare(sql: string): { run(...params: readonly unknown[]): unknown } },
  generation: string,
  assertionId: string,
  path: PathRelation
): void {
  connection.prepare(`
    INSERT INTO relation_path_projections (
      generation, path_id, assertion_id, workspace_id, projection_json
    ) VALUES (?, ?, ?, ?, ?)
  `).run(generation, path.path_id, assertionId, path.workspace_id, JSON.stringify(path));
}

function projectionGeneration(
  generation: string,
  historyDigest: string,
  generationAsOf: string,
  projections: readonly PathRelation[]
) {
  return {
    generation,
    assertionSchemaGeneration: "relation_assertion_v2",
    assertionEventContractGeneration: "relation_assertion_event_v2",
    projectionSchemaGeneration: "relation_path_projection_v1",
    projectionPolicyId: "relation-path-projection-v1",
    projectionPolicySha256: "f".repeat(64),
    historyDigest,
    asOf: generationAsOf,
    projectionDigest: generation.padEnd(64, "0").slice(0, 64),
    projections,
    createdAt: generationAsOf
  };
}

function tableCount(database: StorageDatabase, table: string): number {
  const row = database.connection.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
    readonly count: number;
  };
  return row.count;
}

async function appendSourceEvent(
  database: StorageDatabase,
  workspaceId: string,
  runId: string,
  entityId: string
) {
  return await new SqliteEventLogRepo(database).append({
    event_type: "engine.response.received",
    entity_type: "engine_response",
    entity_id: entityId,
    workspace_id: workspaceId,
    run_id: runId,
    caused_by: "test",
    payload_json: { source: "test" }
  });
}

function evidenceReceipt(evidenceId: string, eventId: string) {
  return {
    evidence_id: evidenceId,
    source_event_anchor: {
      event_type: "engine.response.received" as const,
      event_id: eventId,
      occurred_at: "2026-03-20T00:00:00.000Z"
    }
  };
}

function formationReceipt(events: readonly EventLogEntry[]) {
  return {
    operator_id: "relation_assertion_repo_test_v1",
    operator_sha256: "a".repeat(64),
    parameters: {},
    parameter_sha256: "b".repeat(64),
    source_observations: events.map((event) => ({
      source_kind: "event_log_entry" as const,
      source_id: event.event_id,
      source_sha256: digestRelationFormationEventSource(event)
    })),
    decision: {},
    decision_sha256: "c".repeat(64)
  };
}
