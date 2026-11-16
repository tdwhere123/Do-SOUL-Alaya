import { afterEach, describe, expect, it } from "vitest";
import { TransitionCausedBy, type EventLogEntry } from "@do-soul/alaya-protocol";
import { SqliteEventLogRepo, SqliteSynthesisCapsuleRepo, type StorageDatabase } from "@do-soul/alaya-storage";
import { MemoryService } from "../../memory/memory-service.js";
import { createRecallRealStorage } from "../shared/real-sqlite.test-support.js";
import { createMemoryEntry } from "./memory-service-test-fixtures.js";
import { createSynthesisCapsule } from "../../../../storage/src/__tests__/repos/proposal/proposal-repo-fixture.js";
import { seedHistoricalMember } from "../../../../storage/src/__tests__/repos/memory-entry/historical-preservation-fixture.js";

const MEMORY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const CAPSULE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const NOW = "2020-02-01T00:00:00.000Z";
const CAUSED_BY = TransitionCausedBy.DETERMINISTIC_RULE;
const databases = new Set<StorageDatabase>();
afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

async function fixture(disposition: "judged_useless" | "compressed" = "judged_useless", dormant = false) {
  const storage = await createRecallRealStorage(db => databases.add(db));
  const eventLogRepo = new SqliteEventLogRepo(storage.database);
  const capsuleRepo = new SqliteSynthesisCapsuleRepo(storage.database);
  const startsDormant = dormant;
  if (disposition === "compressed") {
    await seedHistoricalMember(storage.database, storage.memoryEntryRepo, MEMORY_ID, CAPSULE_ID);
  } else await storage.memoryEntryRepo.create(createMemoryEntry({
    object_id: MEMORY_ID, lifecycle_state: startsDormant ? "dormant" : "tombstone",
    retention_state: startsDormant ? "working" : "tombstoned", evidence_refs: [], reinforcement_count: 0,
    created_at: "2020-01-01T00:00:00.000Z", updated_at: "2020-01-01T00:00:00.000Z",
    forget_disposition: startsDormant ? null : disposition,
    forget_disposition_ref: null
  }));
  const notifications: { event: EventLogEntry; committed: boolean; row: unknown }[] = [];
  let beforeTimestamp = () => {};
  const service = new MemoryService({
    memoryEntryRepo: storage.memoryEntryRepo, eventLogRepo, synthesisCapsuleLookup: capsuleRepo,
    evidenceService: { findById: async () => null },
    now: () => { beforeTimestamp(); return NOW; },
    runtimeNotifier: { notifyEntry: event => {
      const persisted = storage.database.connection.prepare("SELECT event_id FROM event_log WHERE event_id = ?").get(event.event_id);
      notifications.push({ event, committed: !storage.database.connection.inTransaction && persisted !== undefined,
        row: storage.database.connection.prepare("SELECT lifecycle_state FROM memory_entries WHERE object_id = ?").get(event.entity_id) });
    } }
  });
  const setupEvents = await eventLogRepo.queryByEntityAll("memory_entry", MEMORY_ID);
  notifications.length = 0;
  return { ...storage, service, eventLogRepo, capsuleRepo, notifications, setupEvents,
    beforeTimestamp: (callback: () => void) => { beforeTimestamp = callback; } };
}

async function eventsAfterSetup(f: Awaited<ReturnType<typeof fixture>>) {
  const events = await f.eventLogRepo.queryByEntityAll("memory_entry", MEMORY_ID);
  expect(events.slice(0, f.setupEvents.length)).toEqual(f.setupEvents);
  return events.slice(f.setupEvents.length);
}

async function deleteMemory(f: Awaited<ReturnType<typeof fixture>>) {
  return f.service.autonomousHardDeleteTombstoned(MEMORY_ID, "autonomous_tombstone_gc", CAUSED_BY);
}

async function tombstoneMemory(f: Awaited<ReturnType<typeof fixture>>) {
  return f.service.autonomousTombstone(MEMORY_ID, "judged_useless", null, "autonomous_forget_sweep", CAUSED_BY);
}

describe("MemoryService autonomous forget through SQLite", () => {
  it("commits disposition and tombstone audit before notifying through the repository instance", async () => {
    const f = await fixture("judged_useless", true);

    await expect(tombstoneMemory(f)).resolves.toMatchObject({
      lifecycle_state: "tombstone", retention_state: "tombstoned", forget_disposition: "judged_useless"
    });

    expect(await f.memoryEntryRepo.findById(MEMORY_ID)).toMatchObject({ lifecycle_state: "tombstone", updated_at: NOW });
    expect(await eventsAfterSetup(f)).toMatchObject([
      { event_type: "soul.memory.state_changed", payload_json: { from_state: "dormant", to_state: "tombstone" } }
    ]);
    expect(f.notifications).toMatchObject([{ committed: true, row: { lifecycle_state: "tombstone" } }]);
    expect(f.notifications).toHaveLength(1);
  });

  it("commits judged-useless deletion and audit before notifying", async () => {
    const f = await fixture();

    await expect(deleteMemory(f)).resolves.toBe(true);

    expect(await f.memoryEntryRepo.findById(MEMORY_ID)).toBeNull();
    expect(await eventsAfterSetup(f)).toMatchObject([
      { event_type: "soul.memory.state_changed", payload_json: { to_state: "deleted",
        reason_code: "forget_disposition=judged_useless: autonomous_tombstone_gc" } }
    ]);
    expect(f.notifications).toMatchObject([{ committed: true, row: undefined }]);
    expect(f.notifications).toHaveLength(1);
  });

  it("refuses a dormant row pinned after selection without mutation, audit or notification", async () => {
    const f = await fixture("judged_useless", true);
    f.beforeTimestamp(() => {
      f.database.connection.prepare("UPDATE memory_entries SET decay_profile = 'pinned' WHERE object_id = ?").run(MEMORY_ID);
    });

    await expect(tombstoneMemory(f)).rejects.toMatchObject({ code: "VALIDATION", message: expect.stringContaining("explicitly protected") });

    expect(await f.memoryEntryRepo.findById(MEMORY_ID)).toMatchObject({ lifecycle_state: "dormant", forget_disposition: null });
    expect(await eventsAfterSetup(f)).toEqual([]);
    expect(f.notifications).toEqual([]);
  });

  it("refuses deletion when evidence is gained after the Core verdict precheck", async () => {
    const f = await fixture();
    f.beforeTimestamp(() => {
      f.database.connection.prepare("UPDATE memory_entries SET evidence_refs = '[\"new-evidence\"]' WHERE object_id = ?").run(MEMORY_ID);
    });

    await expect(deleteMemory(f)).resolves.toBe(false);

    expect(await f.memoryEntryRepo.findById(MEMORY_ID)).toMatchObject({ lifecycle_state: "tombstone" });
    // A stale inspected revision cannot acquire a durable refusal receipt.
    expect(await eventsAfterSetup(f)).toEqual([]);
    expect(f.notifications).toEqual([]);
    await expect(deleteMemory(f)).resolves.toBe(false);
    await expect(deleteMemory(f)).resolves.toBe(false);
    const events = await eventsAfterSetup(f);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload_json).toMatchObject({ to_state: "tombstone",
      reason_code: expect.stringContaining("verdict_revoked") });
    expect(f.notifications).toMatchObject([{ committed: true, row: { lifecycle_state: "tombstone" } }]);
    expect(f.notifications).toHaveLength(1);
  });

  it("deletes a proven compressed member atomically while leaving its historical capsule readable", async () => {
    const f = await fixture("compressed");
    await expect(deleteMemory(f)).resolves.toBe(true);
    expect(await f.memoryEntryRepo.findById(MEMORY_ID)).toBeNull();
    expect(await f.capsuleRepo.readHistoricalMember("workspace-1", CAPSULE_ID, MEMORY_ID)).toMatchObject({ status: "ready" });
    expect(await eventsAfterSetup(f)).toMatchObject([{ payload_json: { to_state: "deleted" } }]);
    expect(f.notifications).toMatchObject([{ committed: true, row: undefined }]);
  });

  it("never backfills proof or releases quarantine for legacy compressed membership", async () => {
    const f = await fixture("judged_useless", true);
    await f.capsuleRepo.create(createSynthesisCapsule({ object_id: CAPSULE_ID,
      source_memory_refs: [MEMORY_ID], evidence_refs: [], run_id: "run-1" }));
    await expect(f.service.autonomousTombstone(MEMORY_ID, "compressed", CAPSULE_ID, "legacy membership", CAUSED_BY))
      .rejects.toMatchObject({ code: "VALIDATION", subCode: "PRESERVATION_INELIGIBLE" });
    // A historical marker below the owner is still not proof and cannot clear its privacy quarantine.
    f.database.connection.prepare(`UPDATE memory_entries SET lifecycle_state='tombstone', retention_state='tombstoned',
      forget_disposition='compressed', forget_disposition_ref=? WHERE object_id=?`).run(CAPSULE_ID, MEMORY_ID);
    await expect(deleteMemory(f)).resolves.toBe(false);
    await expect(f.capsuleRepo.findById(CAPSULE_ID)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await f.capsuleRepo.readHistoricalMember("workspace-1", CAPSULE_ID, MEMORY_ID)).toEqual({ status: "missing" });
    expect(await f.memoryEntryRepo.findById(MEMORY_ID)).not.toBeNull();
  });

  it.each(["tombstone", "judged_useless"] as const)("rolls back %s and emits no notification when its audit insert fails, then permits retry", async operation => {
    const f = await fixture("judged_useless", operation === "tombstone");
    const before = await f.memoryEntryRepo.findById(MEMORY_ID);
    f.database.connection.exec(`CREATE TRIGGER reject_forget_audit BEFORE INSERT ON event_log
      WHEN NEW.entity_id = '${MEMORY_ID}' BEGIN SELECT RAISE(ABORT, 'audit blocked'); END;`);
    const run = () => operation === "tombstone" ? tombstoneMemory(f) : deleteMemory(f);

    await expect(run()).rejects.toThrow();

    expect(await f.memoryEntryRepo.findById(MEMORY_ID)).toEqual(before);
    expect(await eventsAfterSetup(f)).toEqual([]);
    expect(f.notifications).toEqual([]);
    f.database.connection.exec("DROP TRIGGER reject_forget_audit");
    await run();
    expect(await eventsAfterSetup(f)).toHaveLength(1);
    expect(f.notifications).toHaveLength(1);
    expect(f.notifications[0]?.committed).toBe(true);
  });
});
