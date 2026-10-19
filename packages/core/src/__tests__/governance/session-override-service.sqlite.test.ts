import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GreenGovernanceEventType, type EventLogEntry } from "@do-soul/alaya-protocol";
import { initDatabase, SqliteEventLogRepo, type StorageDatabase } from "@do-soul/alaya-storage";
import { SessionOverrideService } from "../../governance/proposals/session-override-service.js";
import { EventPublisherPropagationError } from "../../runtime/event-publisher.js";

const RUN_ID = "run-override-recovery";
const WORKSPACE_ID = "workspace-override-recovery";
const databases = new Set<StorageDatabase>();

afterEach(() => {
  vi.restoreAllMocks();
  for (const database of databases) database.close();
  databases.clear();
});

describe("SessionOverrideService committed EventLog recovery", () => {
  it.each([false, true])("recovers a committed override after notification fails with prior override cached: %s", async hasPrevious => {
    const f = fixture();
    if (hasPrevious) await f.service.apply(request("previous", 1));
    await f.service.getActiveFor(RUN_ID);
    f.notifyEntry.mockRejectedValueOnce(new Error("override listener offline"));

    const failure = await f.service.apply(request("stop", 3)).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(EventPublisherPropagationError);
    if (!(failure instanceof EventPublisherPropagationError)) throw failure;
    expect(failure).toMatchObject({
      code: "EVENT_PUBLISHER_PROPAGATION_FAILED",
      cause: { message: "override listener offline" }
    });
    const rows = await f.eventLogRepo.queryByRunAndEntityType(RUN_ID, "session_override");
    expect(rows).toHaveLength(hasPrevious ? 2 : 1);
    expect(rows.at(-1)).toEqual(failure.entry);
    expect(failure.entry.event_type).toBe(GreenGovernanceEventType.SOUL_SESSION_OVERRIDE_APPLIED);
    const active = await f.service.getActiveFor(RUN_ID);
    expect(active.map(override => override.target_object)).toEqual(hasPrevious ? ["stop", "previous"] : ["stop"]);
    expect(active[0]).toMatchObject({ runtime_id: failure.entry.entity_id, correction: "Correct stop", priority: 3 });
    await expect(f.restart().getActiveFor(RUN_ID)).resolves.toEqual(active);

    await f.service.apply(request("later", 2));

    expect((await f.service.getActiveFor(RUN_ID)).map(override => override.target_object))
      .toEqual(hasPrevious ? ["stop", "later", "previous"] : ["stop", "later"]);
    expect(await f.eventLogRepo.queryByRunAndEntityType(RUN_ID, "session_override"))
      .toHaveLength(hasPrevious ? 3 : 2);
  });

  it("recovers both committed overrides when an older notification fails after a newer apply returns", async () => {
    const f = fixture();
    await f.service.apply(request("previous", 1));
    let reached!: () => void;
    let unblock!: () => void;
    const notifying = new Promise<void>(resolve => { reached = resolve; });
    const gate = new Promise<void>(resolve => { unblock = resolve; });
    f.notifyEntry.mockImplementationOnce(async () => {
      reached();
      await gate;
      throw new Error("delayed override listener failure");
    });
    const pending = f.service.apply(request("stop", 3)).catch((error: unknown) => error);
    await notifying;
    await f.service.apply(request("later", 2));
    unblock();

    expect(await pending).toBeInstanceOf(EventPublisherPropagationError);
    expect((await f.service.getActiveFor(RUN_ID)).map(override => override.target_object))
      .toEqual(["stop", "later", "previous"]);
    expect(await f.eventLogRepo.queryByRunAndEntityType(RUN_ID, "session_override")).toHaveLength(3);
    await expect(f.restart().getActiveFor(RUN_ID)).resolves.toEqual(await f.service.getActiveFor(RUN_ID));
  });

  it("does not cache a precommit override snapshot after committed notification failure", async () => {
    const f = fixture();
    await f.service.apply(request("previous", 1));
    const append = f.eventLogRepo.append.bind(f.eventLogRepo);
    const query = f.eventLogRepo.queryByRunAndEntityType.bind(f.eventLogRepo);
    let pendingRead!: ReturnType<SessionOverrideService["getActiveFor"]>;
    let reached!: () => void;
    let unblock!: () => void;
    const loading = new Promise<void>(resolve => { reached = resolve; });
    const gate = new Promise<void>(resolve => { unblock = resolve; });
    vi.spyOn(f.eventLogRepo, "queryByRunAndEntityType").mockImplementationOnce(async (runId, entityType) => {
      const snapshot = await query(runId, entityType);
      reached();
      await gate;
      return snapshot;
    });
    vi.spyOn(f.eventLogRepo, "append").mockImplementationOnce(async input => {
      f.service.clearRun(RUN_ID);
      pendingRead = f.service.getActiveFor(RUN_ID);
      await loading;
      return await append(input);
    });
    f.notifyEntry.mockRejectedValueOnce(new Error("override listener offline"));

    const failure = await f.service.apply(request("stop", 3)).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(EventPublisherPropagationError);
    unblock();
    await pendingRead;

    expect((await f.service.getActiveFor(RUN_ID)).map(override => override.target_object)).toEqual(["stop", "previous"]);
    expect(await f.eventLogRepo.queryByRunAndEntityType(RUN_ID, "session_override")).toHaveLength(2);
  });

  it("keeps the prior cache and excludes an override when SQLite refuses its audit append before commit", async () => {
    const f = fixture();
    const previous = await f.service.apply(request("previous", 1));
    const query = vi.spyOn(f.eventLogRepo, "queryByRunAndEntityType");
    f.notifyEntry.mockClear();
    f.database.connection.exec(`CREATE TEMP TRIGGER refuse_override_event BEFORE INSERT ON event_log
      BEGIN SELECT RAISE(ABORT, 'override audit unavailable'); END`);

    const failure = await f.service.apply(request("rejected", 3)).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(EventPublisherPropagationError);
    await expect(f.service.getActiveFor(RUN_ID)).resolves.toEqual([previous]);
    expect(query).not.toHaveBeenCalled();
    expect(f.notifyEntry).not.toHaveBeenCalled();
    expect(await f.eventLogRepo.queryByRunAndEntityType(RUN_ID, "session_override")).toHaveLength(1);

    f.database.connection.exec("DROP TRIGGER refuse_override_event");
    await f.service.apply(request("retry", 2));
    expect((await f.service.getActiveFor(RUN_ID)).map(override => override.target_object)).toEqual(["retry", "previous"]);
    await expect(f.restart().getActiveFor(RUN_ID)).resolves.toEqual(await f.service.getActiveFor(RUN_ID));
  });
});

function fixture() {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);
  const eventLogRepo = new SqliteEventLogRepo(database);
  const notifyEntry = vi.fn(async (_entry: EventLogEntry) => undefined);
  const dependencies = {
    eventLogRepo,
    runtimeNotifier: { notifyEntry },
    runLookup: { getById: async () => ({ workspace_id: WORKSPACE_ID }) },
    generateRuntimeId: randomUUID,
    now: () => "2026-03-25T00:00:00.000Z"
  };
  return {
    database,
    eventLogRepo,
    notifyEntry,
    service: new SessionOverrideService(dependencies),
    restart: () => new SessionOverrideService(dependencies)
  };
}

function request(targetObject: string, priority: number) {
  return { runId: RUN_ID, workspaceId: WORKSPACE_ID, targetObject, correction: `Correct ${targetObject}`, priority };
}
