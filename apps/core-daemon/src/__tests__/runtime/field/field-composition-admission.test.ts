import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const boundary = await vi.hoisted(async () => {
  const { installStrictProviderFreeBoundary } = await import("../../../../../../scripts/test-support/provider-free/strict-provider-free-boundary.js");
  return installStrictProviderFreeBoundary();
});
afterAll(() => { expect(boundary.forbidden).toEqual([]); boundary.restore(); });
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
  StorageDatabase
} from "@do-soul/alaya-storage";
import type { FieldProjectionAdmissionMode } from
  "../../../runtime/field/admission-mode.js";
import { createDaemonFieldComposition } from
  "../../../runtime/field/field-composition.js";

import { plantRevoke } from "./source-field-harness.js";

const CLOCK = "2026-08-16T00:00:00.000Z";
const WORKSPACE = "workspace-1";
const tracked = new Set<StorageDatabase>();
const roots = new Set<string>();

afterEach(() => {
  for (const database of tracked) database.close();
  tracked.clear();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
  vi.restoreAllMocks();
});

describe("field composition admission", () => {
  it("recovers a committed deferred source after closing and reopening the database", () => {
    const root = mkdtempSync(join(tmpdir(), "field-recovery-"));
    roots.add(root);
    const filename = join(root, "alaya.sqlite");
    const first = openComposition("explicit_checkpoint", filename);
    first.stores.putRecord(sourceRecord("Ada wrote notes."), "Ada wrote notes.");
    expect(first.fieldRepos.generations.readActive(WORKSPACE)).toBeNull();
    expect(pendingRebuildCount(first.database)).toBe(1);
    first.database.close(); tracked.delete(first.database);

    const database = initDatabase({ filename }); tracked.add(database);
    const recovered = createDaemonFieldComposition({ database, eventLogRepo: new SqliteEventLogRepo(database),
      fieldProjectionAdmissionMode: "explicit_checkpoint" });
    expect(recovered.stores.listStoredRecords(WORKSPACE).map(row => row.content_bytes)).toEqual(["Ada wrote notes."]);
    expect(recovered.fieldRepos.generations.readActive(WORKSPACE)?.status).toBe("active");
    expect(pendingRebuildCount(database)).toBe(0);
    expect(rebuildStartedCount(database)).toBe(1);
  });

  it("serializes a competing same-clock write with rebuild acknowledgement", () => {
    const root = mkdtempSync(join(tmpdir(), "field-race-")); roots.add(root);
    const filename = join(root, "alaya.sqlite");
    const first = openComposition("explicit_checkpoint", filename);
    // Open the competitor before enqueuing, so its startup cannot drain our work.
    const database = new StorageDatabase(filename, new Database(filename)); tracked.add(database);
    expect(database.connection).not.toBe(first.database.connection);
    database.connection.pragma("busy_timeout = 0");
    database.connection.pragma("foreign_keys = ON");
    const competitor = createDaemonFieldComposition({ database, eventLogRepo: new SqliteEventLogRepo(database),
      fieldProjectionAdmissionMode: "explicit_checkpoint" });
    first.stores.putRecord(sourceRecord("Ada wrote notes."), "Ada wrote notes.");
    const prepare = first.database.connection.prepare.bind(first.database.connection);
    let attempted = false;
    let conflict: unknown;
    const pendingWrite = () => competitor.stores.putRecord(sourceRecord("Ada revised notes."), "Ada revised notes.");
    const interception = vi.spyOn(first.database.connection, "prepare").mockImplementation(sql => {
      if (!attempted && /DELETE FROM field_projection_rebuild_requests/.test(sql)) {
        attempted = true;
        try { pendingWrite(); } catch (error) { conflict = error; }
      }
      return prepare(sql);
    });
    first.projectionLifecycle.checkpoint();
    interception.mockRestore();
    expect(attempted).toBe(true);
    expect(conflict).toBeDefined();
    expect(competitor.stores.listStoredRecords(WORKSPACE)).toHaveLength(1);
    const before = first.fieldRepos.generations.readActive(WORKSPACE)!.generation_id;
    // The rejected writer can retry; its same-clock intent must not disappear.
    pendingWrite();
    expect(pendingRebuildCount(database)).toBe(1);
    competitor.projectionLifecycle.checkpoint();
    expect(competitor.fieldRepos.generations.readActive(WORKSPACE)!.generation_id).not.toBe(before);
    expect(competitor.stores.listStoredRecords(WORKSPACE)).toHaveLength(2);
    expect(pendingRebuildCount(database)).toBe(0);
  });

  it("rolls back an effect decision when its durable rebuild request cannot be stored", () => {
    const field = openComposition("explicit_checkpoint");
    field.database.connection.exec(`CREATE TRIGGER reject_rebuild BEFORE INSERT ON field_projection_rebuild_requests
      BEGIN SELECT RAISE(ABORT, 'rebuild intent unavailable'); END`);
    expect(() => plantRevoke(field, "evidence-1", CLOCK)).toThrow("rebuild intent unavailable");
    expect(field.database.connection.prepare("SELECT * FROM proof_effect_decisions").all()).toEqual([]);
    expect(pendingRebuildCount(field.database)).toBe(0);
  });

  it.each([false, true])("rolls back source persistence when durable rebuild intent fails (atomic=%s)", atomic => {
    const { database, stores } = openComposition("explicit_checkpoint");
    database.connection.exec(`CREATE TRIGGER reject_rebuild BEFORE INSERT ON field_projection_rebuild_requests
      BEGIN SELECT RAISE(ABORT, 'rebuild intent unavailable'); END`);
    const write = () => stores.putRecord(sourceRecord("Ada wrote notes."), "Ada wrote notes.");
    expect(() => atomic ? stores.runAtomic(write) : write()).toThrow("rebuild intent unavailable");
    expect(stores.listRecords(WORKSPACE)).toEqual([]);
    expect(pendingRebuildCount(database)).toBe(0);
    database.connection.exec("DROP TRIGGER reject_rebuild");
    const restarted = createDaemonFieldComposition({ database, eventLogRepo: new SqliteEventLogRepo(database) });
    expect(restarted.fieldRepos.generations.readActive(WORKSPACE)).toBeNull();
  });

  it("keeps the durable repair request when activation audit fails, then recovers on restart", () => {
    const { database, stores, eventLogRepo } = openComposition();
    database.connection.exec(`CREATE TRIGGER reject_activation BEFORE INSERT ON event_log
      WHEN NEW.event_type = 'soul.field.generation.activated'
      BEGIN SELECT RAISE(ABORT, 'activation audit unavailable'); END`);
    const record = sourceRecord("Ada wrote notes.");
    const outcome = stores.runAtomicWithOutcome!(() => stores.putRecord(record, "Ada wrote notes."));
    expect(outcome).toMatchObject({ status: "committed", projection: "unready" });
    expect(stores.getRecord(WORKSPACE, record.identity)).toMatchObject(record);
    expect(pendingRebuildCount(database)).toBe(1);
    expect(database.connection.prepare("SELECT * FROM projection_generation_pointer").all()).toEqual([]);
    expect(rebuildStartedCount(database)).toBe(0);
    database.connection.exec("DROP TRIGGER reject_activation");
    const restarted = createDaemonFieldComposition({ database, eventLogRepo });
    expect(restarted.fieldRepos.generations.readActive(WORKSPACE)?.status).toBe("active");
    expect(pendingRebuildCount(database)).toBe(0);
  });

  it.each(["immediate", "explicit_checkpoint"] as const)("reports the committed transaction projection under %s admission", mode => {
    const { database, stores } = openComposition(mode);
    const record = sourceRecord("Ada wrote notes.");
    const outcome = stores.runAtomicWithOutcome!(() => stores.putRecord(record, "Ada wrote notes."));
    expect(outcome).toMatchObject({ status: "committed", result: record,
      projection: mode === "immediate" ? "ready" : "deferred" });
    expect(rebuildStartedCount(database)).toBe(mode === "immediate" ? 1 : 0);
    expect(pendingRebuildCount(database)).toBe(mode === "immediate" ? 0 : 1);
  });

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
    expect(projectionLifecycle.drainPending()).toBe("deferred");

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

function openComposition(mode?: FieldProjectionAdmissionMode, filename = ":memory:") {
  const database = initDatabase({ filename });
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
    evidence_object_id: null,
    recorded_at: CLOCK,
    event_time: null,
    valid_from: null,
    valid_to: null,
    operator_id: SOURCE_SPAN_IDENTITY_OPERATOR_ID
  };
}
