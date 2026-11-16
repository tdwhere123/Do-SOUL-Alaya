import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventLogEntry } from "@do-soul/alaya-protocol";
import { SqliteEventLogRepo, SqliteKarmaEventRepo, type StorageDatabase } from "@do-soul/alaya-storage";
import { DynamicsService, type DynamicsServiceDependencies } from "../../dynamics/dynamics-service.js";
import { KarmaTransitionEngine } from "../../dynamics/karma-transition-engine.js";
import { EventPublisher } from "../../runtime/event-publisher.js";
import { requireAt } from "../helpers/defined.js";
import { createRecallRealStorage } from "../shared/real-sqlite.test-support.js";
import { createMemoryEntry } from "./karma-fixtures.js";

const databases: StorageDatabase[] = [];
const NOW = "2026-03-23T00:00:00.000Z";
const EVENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEMORY_ID = "11111111-2222-4222-8222-333333333333";
const REPLACEMENT_ID = "22222222-3333-4333-8333-444444444444";
type EmissionInput = Parameters<DynamicsService["emitKarmaEvent"]>[0];
type EmissionMode = "standalone" | "current transaction";
afterEach(() => {
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) database.close();
});

async function fixture(clocks: Pick<DynamicsServiceDependencies, "now" | "generateEventId"> = {}) {
  const storage = await createRecallRealStorage(database => databases.push(database));
  const memory = await storage.memoryEntryRepo.create(createMemoryEntry({ object_id: MEMORY_ID, evidence_refs: [] }));
  const eventLogRepo = new SqliteEventLogRepo(storage.database);
  const karmaEventRepo = new SqliteKarmaEventRepo(storage.database);
  const notificationCommitChecks: boolean[] = [];
  const notifyEntry = vi.fn((entry: EventLogEntry) => {
    notificationCommitChecks.push(
      !storage.database.connection.inTransaction &&
      storage.database.connection.prepare("SELECT event_id FROM event_log WHERE event_id = ?").get(entry.event_id) !== undefined &&
      storage.memoryEntryRepo.findByIdSync(memory.object_id)?.reinforcement_count === 1
    );
  });
  const green = vi.fn(async () => undefined);
  const eventPublisher = new EventPublisher({
    eventLogRepo,
    runtimeNotifier: { notifyEntry, notify: () => undefined },
    runHotStateService: { apply: () => undefined }
  });
  const service = new DynamicsService({
    memoryRepo: storage.memoryEntryRepo, karmaEventRepo, eventLogRepo, eventPublisher,
    runtimeNotifier: { notifyEntry }, greenService: { reevaluate: green },
    now: () => NOW, generateEventId: () => EVENT_ID, ...clocks
  });
  return { ...storage, memory, eventLogRepo, karmaEventRepo, service, eventPublisher,
    green, notifyEntry, notificationCommitChecks };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
function input(overrides: Partial<EmissionInput> = {}): EmissionInput {
  return { kind: "accept_gain", objectId: MEMORY_ID, workspaceId: "workspace-1", ...overrides };
}

async function emit(mode: EmissionMode, f: Fixture, value: EmissionInput) {
  if (mode === "standalone") {
    await f.service.emitKarmaEvent(value);
    return undefined;
  }
  const { result } = await f.eventPublisher.mutateThenAppendMany(() => {
    const mutation = f.service.emitKarmaEventInCurrentTransaction(value);
    return { events: mutation.events, result: mutation };
  });
  return result;
}

describe.each<EmissionMode>(["standalone", "current transaction"])("Karma emission: %s", mode => {
  it.each([
    { label: "omitted defaults", overrides: {}, amount: 0.15, runId: null },
    { label: "explicit zero and run", overrides: { amount: 0, runId: "run-1" }, amount: 0, runId: "run-1" }
  ])("persists $label and leaves post-commit effects with the route owner", async ({ overrides, amount, runId }) => {
    const f = await fixture();
    const mutation = await emit(mode, f, input(overrides));

    expect(await f.karmaEventRepo.findByObjectId(MEMORY_ID)).toEqual([{
      event_id: EVENT_ID, kind: "accept_gain", object_id: MEMORY_ID, amount,
      created_at: NOW, workspace_id: "workspace-1", run_id: runId
    }]);
    expect(await f.memoryEntryRepo.findById(MEMORY_ID)).toMatchObject({ reinforcement_count: 1 });
    expect(f.notifyEntry).toHaveBeenCalled();
    expect(f.notificationCommitChecks.every(Boolean)).toBe(true);
    if (mutation !== undefined) {
      expect(f.green).not.toHaveBeenCalled();
      mutation.afterCommit();
    }
    await vi.waitFor(() => expect(f.green).toHaveBeenCalledExactlyOnceWith({
      targetObjectId: MEMORY_ID, workspaceId: "workspace-1"
    }));
  });

  it("passes supersession context into the actual memory transition", async () => {
    const f = await fixture();
    await f.memoryEntryRepo.create(createMemoryEntry({ object_id: REPLACEMENT_ID, evidence_refs: [] }));
    const mutation = await emit(mode, f, input({ kind: "supersede_penalty", supersedingObjectId: REPLACEMENT_ID }));
    expect(await f.memoryEntryRepo.findById(MEMORY_ID)).toMatchObject({ superseded_by: REPLACEMENT_ID });
    expect(await f.karmaEventRepo.findByObjectId(MEMORY_ID)).toMatchObject([{ amount: -0.2 }]);
    mutation?.afterCommit();
    await vi.waitFor(() => expect(f.green).toHaveBeenCalledTimes(1));
  });

  it("preserves field/clock reads and freezes only the transition context", async () => {
    const reads: string[] = [];
    const f = await fixture({
      generateEventId: () => { reads.push("id"); return EVENT_ID; },
      now: () => { reads.push("clock"); return NOW; }
    });
    const value: EmissionInput = {
      get amount() { reads.push("amount"); return 0.15; },
      get kind(): EmissionInput["kind"] { reads.push("kind"); return "accept_gain"; },
      get supersedingObjectId() { reads.push("superseding"); return REPLACEMENT_ID; },
      get objectId() { reads.push("object"); return MEMORY_ID; },
      get workspaceId() { reads.push("workspace"); return "workspace-1"; },
      get runId() { reads.push("run"); return null; }
    };
    const capture = mode === "standalone"
      ? vi.spyOn(KarmaTransitionEngine.prototype, "processKarmaEvent").mockResolvedValueOnce(undefined)
      : vi.spyOn(KarmaTransitionEngine.prototype, "processKarmaEventInCurrentTransaction")
        .mockReturnValueOnce({ updated: f.memory, events: [] });
    if (mode === "standalone") await f.service.emitKarmaEvent(value);
    else f.service.emitKarmaEventInCurrentTransaction(value);

    expect(reads).toEqual(["amount", "superseding", "superseding", "id", "kind",
      "object", "clock", "workspace", "run"]);
    const [event, context] = requireAt(capture.mock.calls, 0);
    expect(event).toEqual({ event_id: EVENT_ID, kind: "accept_gain", object_id: MEMORY_ID,
      amount: 0.15, created_at: NOW, workspace_id: "workspace-1", run_id: null });
    expect(context).toEqual({ supersedingObjectId: REPLACEMENT_ID });
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(value)).toBe(false);
    expect(f.notifyEntry).not.toHaveBeenCalled();
  });

  it("preserves clock failure identity without starting persistence or side effects", async () => {
    const failure = new Error("clock unavailable");
    const f = await fixture({ now: () => { throw failure; } });
    let caught: unknown;
    try {
      if (mode === "standalone") await f.service.emitKarmaEvent(input());
      else f.service.emitKarmaEventInCurrentTransaction(input());
    } catch (error) { caught = error; }
    expect(caught).toBe(failure);
    expect(await f.karmaEventRepo.findByObjectId(MEMORY_ID)).toEqual([]);
    expect(await f.eventLogRepo.queryByEntity("memory_entry", MEMORY_ID)).toEqual([]);
    expect(f.green).not.toHaveBeenCalled();
    expect(f.notifyEntry).not.toHaveBeenCalled();
  });

  it("rolls back a rejected SQLite write and retries the same event without duplicate effects", async () => {
    const f = await fixture();
    f.database.connection.exec("CREATE TRIGGER reject_karma BEFORE INSERT ON karma_events BEGIN SELECT RAISE(ABORT, 'karma blocked'); END;");
    await expect(emit(mode, f, input())).rejects.toMatchObject({
      name: "StorageError",
      code: "QUERY_FAILED",
      message: `Failed to create karma event ${EVENT_ID}.`,
      cause: { message: "karma blocked", code: "SQLITE_CONSTRAINT_TRIGGER" }
    });
    expect(await f.karmaEventRepo.findByObjectId(MEMORY_ID)).toEqual([]);
    expect(await f.eventLogRepo.queryByEntity("memory_entry", MEMORY_ID)).toEqual([]);
    expect(await f.memoryEntryRepo.findById(MEMORY_ID)).toMatchObject({ reinforcement_count: 0 });
    expect(f.green).not.toHaveBeenCalled();
    expect(f.notifyEntry).not.toHaveBeenCalled();
    f.database.connection.exec("DROP TRIGGER reject_karma");
    const mutation = await emit(mode, f, input());
    mutation?.afterCommit();
    expect(await f.karmaEventRepo.findByObjectId(MEMORY_ID)).toHaveLength(1);
    expect(await f.memoryEntryRepo.findById(MEMORY_ID)).toMatchObject({ reinforcement_count: 1 });
    await vi.waitFor(() => expect(f.green).toHaveBeenCalledTimes(1));
    expect(f.notifyEntry).toHaveBeenCalled();
    expect(f.notificationCommitChecks.every(Boolean)).toBe(true);
  });
});
