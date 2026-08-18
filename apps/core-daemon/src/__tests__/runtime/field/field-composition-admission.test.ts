import { afterEach, describe, expect, it } from "vitest";
import {
  FieldGenerationEventType,
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
import type { FieldProjectionAdmissionMode } from
  "../../../runtime/field/admission-mode.js";
import { createDaemonFieldComposition } from
  "../../../runtime/field/field-composition.js";

const CLOCK = "2026-08-16T00:00:00.000Z";
const WORKSPACE = "workspace-1";
const tracked = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of tracked) database.close();
  tracked.clear();
});

describe("field composition admission", () => {
  it("rebuilds on each source write when admission is immediate", () => {
    const { database, stores } = openComposition();
    stores.putRecord(sourceRecord("Ada wrote notes."), "Ada wrote notes.");
    stores.putRecord(sourceRecord("Ada revised notes."), "Ada revised notes.");
    expect(rebuildStartedCount(database)).toBe(2);
    expect(pendingRebuildCount(database)).toBe(0);
  });

  it("queues many writes and rebuilds once at checkpoint", async () => {
    const { database, fieldProjectionCheckpoint, projectionLifecycle, stores } =
      openComposition("explicit_checkpoint");
    stores.putRecord(sourceRecord("Ada wrote notes."), "Ada wrote notes.");
    stores.putRecord(sourceRecord("Ada revised notes."), "Ada revised notes.");
    projectionLifecycle.requestRebuild(WORKSPACE, "2026-08-16T00:03:00.000Z");
    projectionLifecycle.drainPending();

    expect(rebuildStartedCount(database)).toBe(0);
    expect(pendingRebuildCount(database)).toBe(1);

    projectionLifecycle.checkpoint();
    expect(rebuildStartedCount(database)).toBe(1);
    expect(pendingRebuildCount(database)).toBe(0);

    await expect(fieldProjectionCheckpoint.refresh()).resolves.toBe(true);
    projectionLifecycle.checkpoint();
    expect(rebuildStartedCount(database)).toBe(1);
  });

  it("drains leftover queued rebuilds on restart before wrapping drainPending", () => {
    const { database, eventLogRepo, stores } = openComposition("explicit_checkpoint");
    stores.putRecord(sourceRecord("Ada wrote notes."), "Ada wrote notes.");
    expect(pendingRebuildCount(database)).toBe(1);
    expect(rebuildStartedCount(database)).toBe(0);

    const restarted = createDaemonFieldComposition({
      database,
      eventLogRepo,
      sha256: fieldContractSha256,
      fieldProjectionAdmissionMode: "explicit_checkpoint"
    });
    expect(restarted.fieldRepos.generations.readActive(WORKSPACE)).not.toBeNull();
    expect(pendingRebuildCount(database)).toBe(0);
    expect(rebuildStartedCount(database)).toBe(1);
    restarted.stores.putRecord(sourceRecord("Ada revised notes."), "Ada revised notes.");
    expect(rebuildStartedCount(database)).toBe(1);
    restarted.projectionLifecycle.drainPending();
    expect(rebuildStartedCount(database)).toBe(1);
    restarted.projectionLifecycle.checkpoint();
    expect(rebuildStartedCount(database)).toBe(2);
  });
});

function openComposition(mode?: FieldProjectionAdmissionMode) {
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
      sha256: fieldContractSha256,
      ...(mode === undefined ? {} : { fieldProjectionAdmissionMode: mode })
    })
  };
}

function rebuildStartedCount(database: StorageDatabase): number {
  return (database.connection.prepare(`
    SELECT COUNT(*) AS n FROM event_log
    WHERE workspace_id = ? AND event_type = ?
  `).get(
    WORKSPACE,
    FieldGenerationEventType.SOUL_FIELD_GENERATION_REBUILD_STARTED
  ) as { readonly n: number }).n;
}

function pendingRebuildCount(database: StorageDatabase): number {
  return (database.connection.prepare(`
    SELECT COUNT(*) AS n FROM field_projection_rebuild_requests
    WHERE workspace_id = ?
  `).get(WORKSPACE) as { readonly n: number }).n;
}

function seedWorkspace(database: StorageDatabase): void {
  database.connection.prepare(`
    INSERT INTO workspaces (
      workspace_id, name, root_path, workspace_kind, default_engine_binding,
      workspace_state, created_at, archived_at, default_engine_class
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    WORKSPACE,
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
    workspace_id: WORKSPACE,
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
