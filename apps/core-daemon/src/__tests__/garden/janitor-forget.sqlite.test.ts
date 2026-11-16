import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryService } from "@do-soul/alaya-core";
import { GardenTaskKind, GardenTier, type EventLogEntry, type GardenTaskDescriptor } from "@do-soul/alaya-protocol";
import { Janitor } from "@do-soul/alaya-soul";
import { createGardenBackgroundDataPorts, SqliteEventLogRepo, SqliteSynthesisCapsuleRepo, type StorageDatabase } from "@do-soul/alaya-storage";
import { createTombstoneDispositionSweepPort, createTombstoneGcPort } from "../../garden/support/forget-disposition-ports.js";
import { createRecallRealStorage } from "../../../../../packages/core/src/__tests__/shared/real-sqlite.test-support.js";
import { createMemoryEntry } from "../../../../../packages/storage/src/__tests__/repos/proposal/proposal-repo-fixture.js";

const FIRST = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const SECOND = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const THIRD = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
const databases = new Set<StorageDatabase>();
afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

async function fixture(gcMode: "active" | "deferred" | "missing" = "active") {
  const now = new Date().toISOString();
  const storage = await createRecallRealStorage(db => databases.add(db));
  const eventLogRepo = new SqliteEventLogRepo(storage.database);
  const ports = createGardenBackgroundDataPorts(storage.database, { now: () => now });
  const scheduler = { reportCompletion: vi.fn(async () => undefined) };
  const notifications: { event: EventLogEntry; committed: boolean; row: unknown }[] = [];
  const service = new MemoryService({
    memoryEntryRepo: storage.memoryEntryRepo, eventLogRepo,
    evidenceService: { findById: async () => null }, now: () => now,
    runtimeNotifier: { notifyEntry: event => {
      const persisted = storage.database.connection.prepare("SELECT event_id FROM event_log WHERE event_id = ?").get(event.event_id);
      notifications.push({ event, committed: !storage.database.connection.inTransaction && persisted !== undefined,
        row: storage.database.connection.prepare("SELECT lifecycle_state FROM memory_entries WHERE object_id = ?").get(event.entity_id) });
    } }
  });
  const tombstoneAuthority = {
    autonomousTombstone: service.autonomousTombstone.bind(service),
    autonomousHardDeleteTombstoned: service.autonomousHardDeleteTombstoned.bind(service),
    findTombstonedMemoriesWithDisposition: storage.memoryEntryRepo.findTombstonedMemoriesWithDisposition.bind(storage.memoryEntryRepo)
  };
  const gcPort = createTombstoneGcPort({ tombstoneAuthority });
  const findGcCandidates = vi.spyOn(gcPort, "findTombstonedMemories");
  const janitor = new Janitor({
    cleanupPort: { findExpiredObjects: async () => [], removeExpiredObjects: () => undefined },
    tieringPort: ports.tieringPort, scheduler, now: () => now,
    dispositionSweepPort: createTombstoneDispositionSweepPort({
      memoryLookup: storage.memoryEntryRepo,
      capsuleLookup: new SqliteSynthesisCapsuleRepo(storage.database), tombstoneAuthority
    }),
    ...(gcMode === "missing" ? {} : { tombstoneGcPort: gcPort }),
    ...(gcMode === "deferred" ? { tombstoneGcDeferredReason: "temporal_assertion_provenance_required" } : {})
  });
  const task: GardenTaskDescriptor = {
    task_id: "task-forget", task_kind: GardenTaskKind.TOMBSTONE_GC, required_tier: GardenTier.TIER_0,
    workspace_id: "workspace-1", run_id: "run-1", target_object_refs: [], priority: 10, created_at: now
  };
  await storage.memoryEntryRepo.create(createMemoryEntry({
    object_id: FIRST, lifecycle_state: "dormant", evidence_refs: [], decay_profile: "normal"
  }));
  await storage.memoryEntryRepo.create(createMemoryEntry({
    object_id: SECOND, lifecycle_state: "tombstone", retention_state: "tombstoned",
    evidence_refs: [], decay_profile: "normal", forget_disposition: "judged_useless",
    forget_disposition_ref: null, updated_at: "2020-01-01T00:00:00.000Z"
  }));
  return { ...storage, eventLogRepo, scheduler, janitor, task, notifications, findGcCandidates };
}

describe("Janitor autonomous forget through Core and SQLite", () => {
  it("accounts for both phases without claiming a refused delete or bypassing fresh-tombstone grace", async () => {
    const f = await fixture();
    await f.memoryEntryRepo.create(createMemoryEntry({
      object_id: THIRD, lifecycle_state: "tombstone", retention_state: "tombstoned",
      evidence_refs: ["recovered-evidence"], forget_disposition: "judged_useless",
      forget_disposition_ref: null, updated_at: "2020-01-01T00:00:00.000Z"
    }));

    const result = await f.janitor.run(f.task);

    expect(result.error_message).toBeNull();
    expect(result).toMatchObject({ success: true, outcome: "completed", objects_affected: [FIRST, SECOND],
      audit_entries: [
        "disposition_sweep: 1 dormant memories autonomously tombstoned (0 retained, no disposition or strong ref)",
        "tombstone_gc: 1 tombstoned memories hard-deleted (1 refused: preservation revoked)"
      ] });
    expect(await f.memoryEntryRepo.findById(FIRST)).toMatchObject({ lifecycle_state: "tombstone", forget_disposition: "judged_useless" });
    expect(await f.memoryEntryRepo.findById(SECOND)).toBeNull();
    expect(await f.memoryEntryRepo.findById(THIRD)).toMatchObject({ lifecycle_state: "tombstone" });
    const events = await f.eventLogRepo.queryByTypeAll("soul.memory.state_changed");
    expect(events.map(event => [event.entity_id, event.payload_json.to_state])).toEqual([
      [FIRST, "tombstone"], [SECOND, "deleted"], [THIRD, "tombstone"]
    ]);
    expect(events[2]?.payload_json.reason_code).toContain("verdict_revoked");
    expect(f.notifications.map(notification => [notification.committed, notification.row])).toEqual([
      [true, { lifecycle_state: "tombstone" }], [true, undefined], [true, { lifecycle_state: "tombstone" }]
    ]);
    expect(f.scheduler.reportCompletion).toHaveBeenCalledExactlyOnceWith(result);
  });

  it("reports unavailable GC without losing the already-committed disposition accounting", async () => {
    const f = await fixture("missing");

    const result = await f.janitor.run(f.task);

    expect(result).toMatchObject({ success: false, outcome: "failed", objects_affected: [FIRST],
      audit_entries: [
        "disposition_sweep: 1 dormant memories autonomously tombstoned (0 retained, no disposition or strong ref)",
        "[UNAVAILABLE] tombstone_gc: gc port not wired"
      ], error_message: "tombstone GC port is not configured" });
    expect(await f.memoryEntryRepo.findById(FIRST)).toMatchObject({ lifecycle_state: "tombstone", forget_disposition: "judged_useless" });
    expect(await f.memoryEntryRepo.findById(SECOND)).toMatchObject({ lifecycle_state: "tombstone" });
    expect(f.findGcCandidates).not.toHaveBeenCalled();
    expect((await f.eventLogRepo.queryByTypeAll("soul.memory.state_changed")).map(event =>
      [event.entity_id, event.payload_json.to_state])).toEqual([[FIRST, "tombstone"]]);
    expect(f.notifications.map(notification => [notification.committed, notification.row])).toEqual([
      [true, { lifecycle_state: "tombstone" }]
    ]);
    expect(f.scheduler.reportCompletion).toHaveBeenCalledExactlyOnceWith(result);
  });

  it("keeps committed disposition work on a physical-delete SQL fault and retries only remaining GC", async () => {
    const f = await fixture();
    f.database.connection.exec(`CREATE TRIGGER reject_memory_delete BEFORE DELETE ON memory_entries
      WHEN OLD.object_id = '${SECOND}' BEGIN SELECT RAISE(ABORT, 'delete blocked'); END;`);

    const failed = await f.janitor.run(f.task);

    expect(failed.error_message).toContain("delete");
    expect(failed).toMatchObject({ success: false, outcome: "failed", objects_affected: [], audit_entries: [] });
    expect(await f.memoryEntryRepo.findById(FIRST)).toMatchObject({ lifecycle_state: "tombstone" });
    expect(await f.memoryEntryRepo.findById(SECOND)).not.toBeNull();
    expect((await f.eventLogRepo.queryByTypeAll("soul.memory.state_changed"))
      .map(event => [event.entity_id, event.payload_json.to_state])).toEqual([[FIRST, "tombstone"]]);
    expect(f.notifications).toHaveLength(1);
    expect(f.scheduler.reportCompletion).toHaveBeenCalledExactlyOnceWith(failed);

    f.database.connection.exec("DROP TRIGGER reject_memory_delete");
    const retried = await f.janitor.run(f.task);
    expect(retried).toMatchObject({ success: true, objects_affected: [SECOND] });
    expect(await f.memoryEntryRepo.findById(SECOND)).toBeNull();
    expect(await f.memoryEntryRepo.findById(FIRST)).toMatchObject({ lifecycle_state: "tombstone" });
    expect((await f.eventLogRepo.queryByTypeAll("soul.memory.state_changed"))
      .map(event => [event.entity_id, event.payload_json.to_state])).toEqual([[FIRST, "tombstone"], [SECOND, "deleted"]]);
    expect(f.notifications.map(notification => notification.committed)).toEqual([true, true]);
  });

  it("commits the disposition sweep before intentional physical-GC deferral", async () => {
    const f = await fixture("deferred");

    const result = await f.janitor.run(f.task);

    expect(result).toMatchObject({ success: true, outcome: "completed", objects_affected: [FIRST],
      audit_entries: [
        "disposition_sweep: 1 dormant memories autonomously tombstoned (0 retained, no disposition or strong ref)",
        "[DEFERRED] tombstone_gc: temporal_assertion_provenance_required"
      ] });
    expect(await f.memoryEntryRepo.findById(FIRST)).toMatchObject({ lifecycle_state: "tombstone" });
    expect(await f.memoryEntryRepo.findById(SECOND)).not.toBeNull();
    expect(f.findGcCandidates).not.toHaveBeenCalled();
    expect((await f.eventLogRepo.queryByTypeAll("soul.memory.state_changed"))
      .map(event => [event.entity_id, event.payload_json.to_state])).toEqual([[FIRST, "tombstone"]]);
    expect(f.notifications.map(notification => notification.committed)).toEqual([true]);
    expect(f.scheduler.reportCompletion).toHaveBeenCalledExactlyOnceWith(result);
  });
});
