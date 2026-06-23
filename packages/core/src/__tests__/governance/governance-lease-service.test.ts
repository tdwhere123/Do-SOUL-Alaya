import { describe, expect, it, vi } from "vitest";
import {
  GovernanceLeasePiercingConditionKind,
  GreenGovernanceEventType,
  type EventLogEntry
} from "@do-soul/alaya-protocol";
import { GovernanceLeaseService } from "../../governance/governance-lease-service.js";

function createEventLogEntry(event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">): EventLogEntry {
  return {
    event_id: `event-${event.event_type}-${event.entity_id}`,
    created_at: "2026-03-25T00:00:00.000Z",
    revision: 0,
    ...event
  };
}

describe("GovernanceLeaseService", () => {
  it("acquires a lease, appends the audit event before store mutation, and exposes the active lease", async () => {
    let service!: GovernanceLeaseService;
    const appendSpy = vi.fn(async (event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => {
      await expect(service.getActive("run-1")).resolves.toBeNull();
      return createEventLogEntry(event);
    });

    service = new GovernanceLeaseService({
      now: () => "2026-03-25T00:00:00.000Z",
      generateRuntimeId: () => "11111111-1111-4111-8111-111111111111",
      eventLogRepo: createEventLogRepo({ append: appendSpy })
    });

    const lease = await service.acquire({
      runId: "run-1",
      workspaceId: "workspace-1"
    });

    expect(lease).toMatchObject({
      runtime_id: "11111111-1111-4111-8111-111111111111",
      object_kind: "governance_lease",
      lease_id: "11111111-1111-4111-8111-111111111111",
      holder: "run:run-1:turn:11111111-1111-4111-8111-111111111111",
      retention_policy: "session_only",
      expires_at: "2026-03-25T00:05:00.000Z"
    });
    await expect(service.isHeld("run-1")).resolves.toBe(true);
    await expect(service.getActive("run-1")).resolves.toEqual(lease);
    expect(appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: GreenGovernanceEventType.SOUL_GOVERNANCE_LEASE_ACQUIRED,
        entity_type: "governance_lease",
        entity_id: lease.runtime_id,
        workspace_id: "workspace-1",
        run_id: "run-1",
        payload_json: expect.objectContaining({
          lease_id: lease.lease_id,
          holder: lease.holder,
          run_id: "run-1"
        })
      })
    );
  });

  it("releases a held lease by appending a release event", async () => {
    const appendSpy = vi.fn(async (event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => createEventLogEntry(event));
    const service = new GovernanceLeaseService({
      now: () => "2026-03-25T00:00:00.000Z",
      generateRuntimeId: () => "11111111-1111-4111-8111-111111111111",
      eventLogRepo: createEventLogRepo({ append: appendSpy })
    });

    await service.acquire({
      runId: "run-1",
      workspaceId: "workspace-1"
    });
    appendSpy.mockClear();

    await service.release("run-1");

    await expect(service.isHeld("run-1")).resolves.toBe(false);
    expect(appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: GreenGovernanceEventType.SOUL_GOVERNANCE_LEASE_RELEASED,
        entity_type: "governance_lease",
        run_id: "run-1",
        workspace_id: "workspace-1",
        payload_json: expect.objectContaining({
          lease_id: "11111111-1111-4111-8111-111111111111",
          run_id: "run-1"
        })
      })
    );
  });

  it("rejects an empty runId when releasing a lease", async () => {
    const appendSpy = vi.fn(async (event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => createEventLogEntry(event));
    const service = new GovernanceLeaseService({
      now: () => "2026-03-25T00:00:00.000Z",
      generateRuntimeId: () => "11111111-1111-4111-8111-111111111111",
      eventLogRepo: createEventLogRepo({ append: appendSpy })
    });

    await service.acquire({
      runId: "run-1",
      workspaceId: "workspace-1"
    });
    appendSpy.mockClear();

    let error: unknown;

    try {
      await service.release("   ");
    } catch (caughtError) {
      error = caughtError;
    }

    expect(error).toMatchObject({ code: "VALIDATION" });
    await expect(service.isHeld("run-1")).resolves.toBe(true);
    expect(appendSpy).not.toHaveBeenCalled();
  });

  it("pierces an active lease and appends the pierced audit event", async () => {
    const appendSpy = vi.fn(async (event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => createEventLogEntry(event));
    const service = new GovernanceLeaseService({
      now: () => "2026-03-25T00:00:00.000Z",
      generateRuntimeId: () => "11111111-1111-4111-8111-111111111111",
      eventLogRepo: createEventLogRepo({ append: appendSpy })
    });

    await service.acquire({
      runId: "run-1",
      workspaceId: "workspace-1"
    });
    appendSpy.mockClear();

    await service.pierce({
      runId: "run-1",
      workspaceId: "workspace-1",
      conditionKind: GovernanceLeasePiercingConditionKind.EXPLICIT_LIFECYCLE_EVENT,
      description: "User switched branches"
    });

    await expect(service.getActive("run-1")).resolves.toBeNull();
    expect(appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: GreenGovernanceEventType.SOUL_GOVERNANCE_LEASE_PIERCED,
        entity_type: "governance_lease",
        workspace_id: "workspace-1",
        run_id: "run-1",
        payload_json: expect.objectContaining({
          lease_id: "11111111-1111-4111-8111-111111111111",
          piercing_condition_kind: GovernanceLeasePiercingConditionKind.EXPLICIT_LIFECYCLE_EVENT,
          run_id: "run-1"
        })
      })
    );
  });

  it("rejects unsupported piercing conditions without mutating the active lease", async () => {
    const appendSpy = vi.fn(async (event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => createEventLogEntry(event));
    const service = new GovernanceLeaseService({
      now: () => "2026-03-25T00:00:00.000Z",
      generateRuntimeId: () => "11111111-1111-4111-8111-111111111111",
      eventLogRepo: createEventLogRepo({ append: appendSpy })
    });

    await service.acquire({
      runId: "run-1",
      workspaceId: "workspace-1"
    });
    appendSpy.mockClear();

    await expect(
      service.pierce({
        runId: "run-1",
        workspaceId: "workspace-1",
        conditionKind: "invalid_condition" as GovernanceLeasePiercingConditionKind,
        description: "Unexpected runtime input"
      })
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(service.getActive("run-1")).resolves.not.toBeNull();
    expect(appendSpy).not.toHaveBeenCalled();
  });

  it("expires leases on lookup and clearExpired", async () => {
    let now = "2026-03-25T00:00:00.000Z";
    const service = new GovernanceLeaseService({
      now: () => now,
      generateRuntimeId: () => "11111111-1111-4111-8111-111111111111",
      eventLogRepo: createEventLogRepo()
    });

    await service.acquire({
      runId: "run-1",
      workspaceId: "workspace-1",
      expiresAt: "2026-03-25T00:01:00.000Z"
    });

    now = "2026-03-25T00:02:00.000Z";

    await expect(service.isHeld("run-1")).resolves.toBe(false);
    await expect(service.getActive("run-1")).resolves.toBeNull();

    await service.acquire({
      runId: "run-2",
      workspaceId: "workspace-1",
      expiresAt: "2026-03-25T00:01:00.000Z"
    });
    service.clearExpired();

    await expect(service.getActive("run-2")).resolves.toBeNull();
  });

  it("rehydrates the active lease from the EventLog and honors released state after restart", async () => {
    const eventLogRepo = createEventLogRepo();
    const firstService = new GovernanceLeaseService({
      now: () => "2026-03-25T00:00:00.000Z",
      generateRuntimeId: () => "11111111-1111-4111-8111-111111111111",
      eventLogRepo
    });

    await firstService.acquire({
      runId: "run-1",
      workspaceId: "workspace-1"
    });

    const restartedBeforeRelease = new GovernanceLeaseService({
      now: () => "2026-03-25T00:00:00.000Z",
      generateRuntimeId: () => "22222222-2222-4222-8222-222222222222",
      eventLogRepo
    });
    await expect(restartedBeforeRelease.getActive("run-1")).resolves.toMatchObject({
      lease_id: "11111111-1111-4111-8111-111111111111",
      holder: "run:run-1:turn:11111111-1111-4111-8111-111111111111"
    });

    await firstService.release("run-1");

    const restartedAfterRelease = new GovernanceLeaseService({
      now: () => "2026-03-25T00:00:00.000Z",
      generateRuntimeId: () => "33333333-3333-4333-8333-333333333333",
      eventLogRepo
    });
    await expect(restartedAfterRelease.getActive("run-1")).resolves.toBeNull();
  });

  it("does not rehydrate expired leases after restart or emit release events for them", async () => {
    const appendSpy = vi.fn(async (event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => createEventLogEntry(event));
    const eventLogRepo = createEventLogRepo({ append: appendSpy });
    const firstService = new GovernanceLeaseService({
      now: () => "2026-03-25T00:00:00.000Z",
      generateRuntimeId: () => "11111111-1111-4111-8111-111111111111",
      eventLogRepo
    });

    await firstService.acquire({
      runId: "run-1",
      workspaceId: "workspace-1",
      expiresAt: "2026-03-25T00:01:00.000Z"
    });
    appendSpy.mockClear();

    const restartedService = new GovernanceLeaseService({
      now: () => "2026-03-25T00:02:00.000Z",
      generateRuntimeId: () => "22222222-2222-4222-8222-222222222222",
      eventLogRepo
    });

    await expect(restartedService.getActive("run-1")).resolves.toBeNull();
    await restartedService.release("run-1");
    expect(appendSpy).not.toHaveBeenCalled();
  });

  it("fails closed instead of reporting not-held when EventLog rehydrate read fails", async () => {
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const queryByRunAll = vi.fn(async () => {
      throw new Error("event log read failed");
    });
    const service = new GovernanceLeaseService({
      now: () => "2026-03-25T00:00:00.000Z",
      generateRuntimeId: () => "11111111-1111-4111-8111-111111111111",
      eventLogRepo: createEventLogRepo({ queryByRunAll })
    });

    await expect(service.getActive("run-1")).rejects.toMatchObject({
      code: "CONFLICT",
      subCode: "CONCURRENT_MODIFICATION"
    });
    await expect(service.isHeld("run-1")).rejects.toMatchObject({ code: "CONFLICT" });
    expect(queryByRunAll).toHaveBeenCalledWith("run-1");
    expect(emitWarning).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ code: "ALAYA_GOVERNANCE_LEASE_REHYDRATE_FAILED" })
    );
    emitWarning.mockRestore();
  });

  it("fails replay when a persisted governance lease event payload is malformed", async () => {
    const service = new GovernanceLeaseService({
      now: () => "2026-03-25T00:00:00.000Z",
      generateRuntimeId: () => "11111111-1111-4111-8111-111111111111",
      eventLogRepo: createEventLogRepo({
        queryByRunAll: vi.fn(async () => [
          createEventLogEntry({
            event_type: GreenGovernanceEventType.SOUL_GOVERNANCE_LEASE_ACQUIRED,
            entity_type: "governance_lease",
            entity_id: "lease-bad",
            workspace_id: "workspace-1",
            run_id: "run-1",
            caused_by: "system",
            payload_json: {
              lease_id: "",
              holder: "run:run-1:turn:lease-bad",
              run_id: "run-1",
              expires_at: "2026-03-25T00:05:00.000Z",
              occurred_at: "2026-03-25T00:00:00.000Z"
            }
          })
        ])
      })
    });

    await expect(service.getActive("run-1")).rejects.toMatchObject({
      code: "CONFLICT"
    });
  });

  it("does not let a stale rehydration overwrite a newly acquired lease", async () => {
    const queryDeferred = createDeferred<readonly EventLogEntry[]>();
    const staleEvents = Object.freeze([
      createEventLogEntry({
        event_type: GreenGovernanceEventType.SOUL_GOVERNANCE_LEASE_ACQUIRED,
        entity_type: "governance_lease",
        entity_id: "99999999-9999-4999-8999-999999999999",
        workspace_id: "workspace-1",
        run_id: "run-1",
        caused_by: "system",
        payload_json: {
          lease_id: "99999999-9999-4999-8999-999999999999",
          holder: "run:run-1:turn:99999999-9999-4999-8999-999999999999",
          run_id: "run-1",
          expires_at: "2026-03-25T00:05:00.000Z",
          occurred_at: "2026-03-25T00:00:00.000Z"
        }
      })
    ] satisfies readonly EventLogEntry[]);
    const service = new GovernanceLeaseService({
      now: () => "2026-03-25T00:00:00.000Z",
      generateRuntimeId: () => "11111111-1111-4111-8111-111111111111",
      eventLogRepo: createEventLogRepo({
        queryByRunAll: vi.fn(async () => await queryDeferred.promise)
      })
    });

    const pendingLookup = service.getActive("run-1");

    const freshLease = await service.acquire({
      runId: "run-1",
      workspaceId: "workspace-1"
    });

    queryDeferred.resolve(staleEvents);

    await expect(pendingLookup).resolves.toEqual(freshLease);
    await expect(service.getActive("run-1")).resolves.toEqual(freshLease);
  });
});

function createEventLogRepo(overrides: Partial<{
  append: (event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => Promise<EventLogEntry>;
  queryByRun: (runId: string) => Promise<readonly EventLogEntry[]>;
  queryByRunAll: (runId: string) => Promise<readonly EventLogEntry[]>;
  queryByEntity: (entityType: string, entityId: string) => Promise<readonly EventLogEntry[]>;
}> = {}) {
  const appendedEvents: EventLogEntry[] = [];
  const queryByRunAll =
    overrides.queryByRunAll ??
    vi.fn(async (runId: string) => appendedEvents.filter((entry) => entry.run_id === runId));

  return {
    append:
      overrides.append ??
      vi.fn(async (event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => {
        const entry = createEventLogEntry(event);
        appendedEvents.push(entry);
        return entry;
      }),
    queryByEntity:
      overrides.queryByEntity ??
      vi.fn(async (entityType: string, entityId: string) =>
        appendedEvents.filter((entry) => entry.entity_type === entityType && entry.entity_id === entityId)
      ),
    queryByRun: overrides.queryByRun ?? queryByRunAll,
    queryByRunAll
  };
}

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return { promise, resolve, reject };
}
