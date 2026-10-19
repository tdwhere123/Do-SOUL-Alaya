import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GovernanceLeasePiercingConditionKind,
  GreenGovernanceEventType,
  type EventLogEntry
} from "@do-soul/alaya-protocol";
import { initDatabase, SqliteEventLogRepo, type StorageDatabase } from "@do-soul/alaya-storage";
import { GovernanceLeaseService } from "../../governance/policy/governance-lease-service.js";
import { EventPublisherPropagationError } from "../../runtime/event-publisher.js";

const RUN_ID = "run-lease-recovery";
const WORKSPACE_ID = "workspace-lease-recovery";
const databases = new Set<StorageDatabase>();

afterEach(() => {
  vi.restoreAllMocks();
  for (const database of databases) database.close();
  databases.clear();
});

describe("GovernanceLeaseService committed EventLog recovery", () => {
  it.each([false, true])("releases the second committed lease after notification fails with recovery read: %s", async readBeforeRelease => {
    const f = fixture();
    const first = await f.service.acquire({ runId: RUN_ID, workspaceId: WORKSPACE_ID });
    f.notifyEntry.mockRejectedValueOnce(new Error("lease listener offline"));

    const failure = await f.service.acquire({ runId: RUN_ID, workspaceId: WORKSPACE_ID }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(EventPublisherPropagationError);
    if (!(failure instanceof EventPublisherPropagationError)) throw failure;
    expect(failure).toMatchObject({
      code: "EVENT_PUBLISHER_PROPAGATION_FAILED",
      cause: { message: "lease listener offline" }
    });
    const rows = await f.eventLogRepo.queryGovernanceLeaseEventsByRun(RUN_ID);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual(failure.entry);
    expect(failure.entry.entity_id).not.toBe(first.lease_id);
    if (readBeforeRelease) {
      await expect(f.service.getActive(RUN_ID)).resolves.toMatchObject({ lease_id: failure.entry.entity_id });
    }

    await f.service.release(RUN_ID);

    const released = await f.eventLogRepo.queryGovernanceLeaseEventsByRun(RUN_ID);
    expect(released).toHaveLength(3);
    expect(released[2]).toMatchObject({
      event_type: GreenGovernanceEventType.SOUL_GOVERNANCE_LEASE_RELEASED,
      entity_id: failure.entry.entity_id,
      payload_json: { lease_id: failure.entry.entity_id }
    });
    await expect(f.service.getActive(RUN_ID)).resolves.toBeNull();
    await expect(f.restart().getActive(RUN_ID)).resolves.toBeNull();
  });

  it("recovers the latest committed lease when an older acquire notification fails after a newer acquire returns", async () => {
    const f = fixture();
    await f.service.acquire({ runId: RUN_ID, workspaceId: WORKSPACE_ID });
    let reached!: () => void;
    let unblock!: () => void;
    const notifying = new Promise<void>(resolve => { reached = resolve; });
    const gate = new Promise<void>(resolve => { unblock = resolve; });
    f.notifyEntry.mockImplementationOnce(async () => {
      reached();
      await gate;
      throw new Error("delayed lease listener failure");
    });
    const pending = f.service.acquire({ runId: RUN_ID, workspaceId: WORKSPACE_ID }).catch((error: unknown) => error);
    await notifying;
    const newest = await f.service.acquire({ runId: RUN_ID, workspaceId: WORKSPACE_ID });
    unblock();

    expect(await pending).toBeInstanceOf(EventPublisherPropagationError);
    await expect(f.service.getActive(RUN_ID)).resolves.toEqual(newest);
    await f.service.release(RUN_ID);
    const rows = await f.eventLogRepo.queryGovernanceLeaseEventsByRun(RUN_ID);
    expect(rows).toHaveLength(4);
    expect(rows[3]).toMatchObject({ entity_id: newest.lease_id });
    await expect(f.restart().getActive(RUN_ID)).resolves.toBeNull();
  });

  it("does not let a precommit rehydration restore the predecessor after a committed acquire notification fails", async () => {
    const f = fixture();
    await f.service.acquire({ runId: RUN_ID, workspaceId: WORKSPACE_ID });
    const service = f.restart();
    const query = f.eventLogRepo.queryGovernanceLeaseEventsByRun.bind(f.eventLogRepo);
    let reached!: () => void;
    let unblock!: () => void;
    const loading = new Promise<void>(resolve => { reached = resolve; });
    const gate = new Promise<void>(resolve => { unblock = resolve; });
    vi.spyOn(f.eventLogRepo, "queryGovernanceLeaseEventsByRun").mockImplementationOnce(async runId => {
      const snapshot = await query(runId);
      reached();
      await gate;
      return snapshot;
    });
    const pendingRead = service.getActive(RUN_ID);
    await loading;
    f.notifyEntry.mockRejectedValueOnce(new Error("lease listener offline"));
    const failure = await service.acquire({ runId: RUN_ID, workspaceId: WORKSPACE_ID }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(EventPublisherPropagationError);
    if (!(failure instanceof EventPublisherPropagationError)) throw failure;
    unblock();
    await pendingRead;

    await expect(service.getActive(RUN_ID)).resolves.toMatchObject({ lease_id: failure.entry.entity_id });
    await service.release(RUN_ID);
    await expect(f.restart().getActive(RUN_ID)).resolves.toBeNull();
  });

  it.each(["release", "pierce"] as const)("does not retain a lease or append another %s after its committed notification fails", async operation => {
    const f = fixture();
    const lease = await f.service.acquire({ runId: RUN_ID, workspaceId: WORKSPACE_ID });
    f.notifyEntry.mockRejectedValueOnce(new Error("lease listener offline"));

    const failure = await terminate(f.service, operation).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(EventPublisherPropagationError);
    if (!(failure instanceof EventPublisherPropagationError)) throw failure;
    const rows = await f.eventLogRepo.queryGovernanceLeaseEventsByRun(RUN_ID);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual(failure.entry);
    expect(failure.entry.entity_id).toBe(lease.lease_id);
    await expect(f.service.isHeld(RUN_ID)).resolves.toBe(false);
    await terminate(f.service, operation);
    expect(await f.eventLogRepo.queryGovernanceLeaseEventsByRun(RUN_ID)).toHaveLength(2);
    await expect(f.restart().getActive(RUN_ID)).resolves.toBeNull();
  });

  it.each(["acquire", "release", "pierce"] as const)("preserves the held lease when SQLite refuses the %s append before commit", async operation => {
    const f = fixture();
    const lease = await f.service.acquire({ runId: RUN_ID, workspaceId: WORKSPACE_ID });
    const query = vi.spyOn(f.eventLogRepo, "queryGovernanceLeaseEventsByRun");
    f.notifyEntry.mockClear();
    f.database.connection.exec(`CREATE TEMP TRIGGER refuse_lease_event BEFORE INSERT ON event_log
      BEGIN SELECT RAISE(ABORT, 'lease audit unavailable'); END`);

    const pending = operation === "acquire"
      ? f.service.acquire({ runId: RUN_ID, workspaceId: WORKSPACE_ID })
      : terminate(f.service, operation);
    const failure = await pending.catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(EventPublisherPropagationError);
    await expect(f.service.getActive(RUN_ID)).resolves.toEqual(lease);
    expect(query).not.toHaveBeenCalled();
    expect(f.notifyEntry).not.toHaveBeenCalled();
    expect(await f.eventLogRepo.queryGovernanceLeaseEventsByRun(RUN_ID)).toHaveLength(1);

    f.database.connection.exec("DROP TRIGGER refuse_lease_event");
    await f.service.release(RUN_ID);
    await expect(f.restart().getActive(RUN_ID)).resolves.toBeNull();
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
    service: new GovernanceLeaseService(dependencies),
    restart: () => new GovernanceLeaseService(dependencies)
  };
}

function terminate(service: GovernanceLeaseService, operation: "release" | "pierce"): Promise<void> {
  return operation === "release" ? service.release(RUN_ID) : service.pierce({
    runId: RUN_ID,
    workspaceId: WORKSPACE_ID,
    conditionKind: GovernanceLeasePiercingConditionKind.EXPLICIT_LIFECYCLE_EVENT,
    description: "Session ended"
  });
}
