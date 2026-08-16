import { afterEach, describe, expect, it } from "vitest";
import {
  FieldGenerationEventType,
  hashCausalUsageId,
  hashContentDigest,
  hashSourceRecordId,
  SOURCE_SPAN_IDENTITY_OPERATOR_ID
} from "@do-soul/alaya-protocol";
import { fieldContractSha256 } from "@do-soul/alaya-core";
import {
  initDatabase,
  SqliteEventLogRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { createDaemonFieldComposition } from
  "../../../runtime/field/field-composition.js";
import { rebuildAndActivateProjectionGeneration } from
  "../../../runtime/field/shadow-rebuild.js";

const CLOCK = "2026-08-16T00:00:00.000Z";
const tracked = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of tracked) database.close();
  tracked.clear();
});

describe("field composition", () => {
  it("persists source admission through the SQLite field stores", () => {
    const { stores } = openComposition();
    const record = stores.putRecord(sourceRecord("Ada wrote notes."));
    const replay = stores.putRecord(record);
    expect(replay.identity).toBe(record.identity);
    expect(stores.getRecord("workspace-1", record.identity)?.content_digest)
      .toBe(record.content_digest);
    expect(stores.listRecords("workspace-1")).toHaveLength(1);
  });

  it("records causal usage at the composition port, not a request-local fallback", () => {
    const { usagePort } = openComposition();
    const receipt = usagePort.recordUsage(causalReceipt());
    const replay = usagePort.recordUsage(receipt);
    expect(replay.identity).toBe(receipt.identity);
    expect(replay.usage_kind).toBe("causal");
    expect(usagePort.recordUsage(receipt).identity).toBe(receipt.identity);
  });

  it("rebuilds a sealed frontier twice with the same generation and activates the pointer", () => {
    const { database, fieldRepos, eventLogRepo } = openComposition();
    const first = rebuildAndActivateProjectionGeneration({
      workspaceId: "workspace-1",
      inputEventFrontier: "sealed:empty",
      governanceFrontier: "sealed:empty",
      recordedAt: CLOCK,
      generations: fieldRepos.generations,
      eventLog: eventLogRepo
    });
    const second = rebuildAndActivateProjectionGeneration({
      workspaceId: "workspace-1",
      inputEventFrontier: "sealed:empty",
      governanceFrontier: "sealed:empty",
      recordedAt: CLOCK,
      generations: fieldRepos.generations,
      eventLog: eventLogRepo
    });
    const active = fieldRepos.generations.readActive("workspace-1");
    expect(second.generation_id).toBe(first.generation_id);
    expect(active?.generation_id).toBe(first.generation_id);
    expect(active?.status).toBe("active");
    const activated = database.connection.prepare(`
      SELECT COUNT(*) AS n FROM event_log WHERE event_type = ? AND workspace_id = ?
    `).get(
      FieldGenerationEventType.SOUL_FIELD_GENERATION_ACTIVATED,
      "workspace-1"
    ) as { readonly n: number };
    expect(activated.n).toBeGreaterThan(0);
  });
});

function openComposition() {
  const database = initDatabase({ filename: ":memory:" });
  tracked.add(database);
  seedWorkspace(database);
  const eventLogRepo = new SqliteEventLogRepo(database);
  return {
    database,
    eventLogRepo,
    ...createDaemonFieldComposition({
      database,
      eventLogRepo,
      sha256: fieldContractSha256
    })
  };
}

function seedWorkspace(database: StorageDatabase): void {
  database.connection.prepare(`
    INSERT INTO workspaces (
      workspace_id, name, root_path, workspace_kind, default_engine_binding,
      workspace_state, created_at, archived_at, default_engine_class
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "workspace-1",
    "Field workspace",
    "/tmp/workspace-1",
    "local_repo",
    null,
    "active",
    CLOCK,
    null,
    null
  );
}

function sourceRecord(body: string) {
  const content_digest = hashContentDigest(body, fieldContractSha256);
  const identity = hashSourceRecordId({
    source_id: "src-1",
    source_version: "1",
    content_digest
  }, fieldContractSha256);
  return {
    schema_version: 1 as const,
    producer: SOURCE_SPAN_IDENTITY_OPERATOR_ID,
    consumer: "projection_generation",
    identity,
    replay_rule: "idempotent_same_identity" as const,
    failure_disposition: "fail_closed" as const,
    governance_effect: "none" as const,
    deletion_behavior: "retain_identity" as const,
    workspace_id: "workspace-1",
    source_id: "src-1",
    source_version: "1",
    content_digest,
    evidence_object_id: "85b3671a-d8d8-4848-9e5c-07d0a89f5ae9",
    recorded_at: CLOCK,
    event_time: null,
    valid_from: null,
    valid_to: null,
    operator_id: SOURCE_SPAN_IDENTITY_OPERATOR_ID
  };
}

function causalReceipt() {
  const causal_key = "delivery_1:mem1";
  const downstream_ref = "mem1";
  const scope = "workspace-1";
  return {
    schema_version: 1 as const,
    producer: "causal_usage_v1",
    consumer: "path_projection",
    identity: hashCausalUsageId({
      causal_key,
      downstream_ref,
      scope,
      operator_id: "causal_usage_v1"
    }, fieldContractSha256),
    replay_rule: "idempotent_same_identity" as const,
    failure_disposition: "fail_closed" as const,
    governance_effect: "none" as const,
    deletion_behavior: "rebuildable" as const,
    workspace_id: "workspace-1",
    causal_key,
    occurred_at: CLOCK,
    downstream_ref,
    weight: 1,
    scope,
    usage_kind: "causal" as const,
    operator_id: "causal_usage_v1",
    recorded_at: CLOCK
  };
}
