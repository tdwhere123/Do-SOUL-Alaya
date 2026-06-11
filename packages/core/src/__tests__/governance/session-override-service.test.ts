import { describe, expect, it, vi } from "vitest";
import { WorkspaceRunEventType, GreenGovernanceEventType, type EventLogEntry } from "@do-soul/alaya-protocol";
import { SessionOverrideService } from "../../governance/session-override-service.js";
import type { TestMock } from "../mock-types.js";

function createEventLogEntry(event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">): EventLogEntry {
  return {
    event_id: `event-${event.event_type}`,
    created_at: "2026-03-24T00:00:00.000Z",
    revision: 0,
    ...event
  };
}

describe("SessionOverrideService", () => {
  it("applies an override, appends audit event before store mutation, and returns an active override", async () => {
    let service!: SessionOverrideService;
    const appendSpy = vi.fn(async (event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => {
      await expect(service.getActiveFor("run-1")).resolves.toEqual([]);
      return createEventLogEntry(event);
    });

    service = new SessionOverrideService({
      now: () => "2026-03-24T00:00:00.000Z",
      generateRuntimeId: () => "11111111-1111-4111-8111-111111111111",
      eventLogRepo: createEventLogRepo({ append: appendSpy })
    });

    const override = await service.apply({
      runId: "run-1",
      workspaceId: "workspace-1",
      targetObject: "memory:build-style",
      correction: "Use pnpm instead of npm.",
      priority: 2
    });

    expect(override).toMatchObject({
      runtime_id: "11111111-1111-4111-8111-111111111111",
      object_kind: "session_override",
      scope: "session_only",
      target_object: "memory:build-style",
      correction: "Use pnpm instead of npm.",
      priority: 2,
      retention_policy: "session_only",
      expires_at: "2026-03-24T01:00:00.000Z"
    });
    await expect(service.getActiveFor("run-1")).resolves.toEqual([override]);
    expect(appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: GreenGovernanceEventType.SOUL_SESSION_OVERRIDE_APPLIED,
        entity_type: "session_override",
        entity_id: override.runtime_id,
        workspace_id: "workspace-1",
        run_id: "run-1",
        payload_json: expect.objectContaining({
          override_id: override.runtime_id,
          target_object: "memory:build-style",
          correction: "Use pnpm instead of npm.",
          priority: 2,
          run_id: "run-1"
        })
      })
    );
  });

  it("returns active overrides sorted by priority descending and empty for unknown runs", async () => {
    const service = new SessionOverrideService({
      now: () => "2026-03-24T00:00:00.000Z",
      generateRuntimeId: createRuntimeIdGenerator(),
      eventLogRepo: createEventLogRepo()
    });

    await service.apply({
      runId: "run-1",
      workspaceId: "workspace-1",
      targetObject: "memory:a",
      correction: "a",
      priority: 1
    });
    await service.apply({
      runId: "run-1",
      workspaceId: "workspace-1",
      targetObject: "memory:b",
      correction: "b",
      priority: 3
    });
    await service.apply({
      runId: "run-1",
      workspaceId: "workspace-1",
      targetObject: "memory:c",
      correction: "c",
      priority: 2
    });

    expect((await service.getActiveFor("run-1")).map((entry) => entry.priority)).toEqual([3, 2, 1]);
    await expect(service.getActiveFor("missing-run")).resolves.toEqual([]);
  });

  it("filters expired overrides from active lookups", async () => {
    let now = "2026-03-24T00:00:00.000Z";
    const service = new SessionOverrideService({
      now: () => now,
      generateRuntimeId: createRuntimeIdGenerator(),
      eventLogRepo: createEventLogRepo()
    });

    await service.apply({
      runId: "run-1",
      workspaceId: "workspace-1",
      targetObject: "memory:expired",
      correction: "expired",
      expiresAt: "2026-03-24T00:10:00.000Z"
    });
    await service.apply({
      runId: "run-1",
      workspaceId: "workspace-1",
      targetObject: "memory:active",
      correction: "active",
      expiresAt: "2026-03-24T01:00:00.000Z"
    });

    now = "2026-03-24T00:30:00.000Z";

    expect((await service.getActiveFor("run-1")).map((entry) => entry.target_object)).toEqual(["memory:active"]);
  });

  it("clearExpired prunes expired entries across runs", async () => {
    let now = "2026-03-24T00:00:00.000Z";
    const service = new SessionOverrideService({
      now: () => now,
      generateRuntimeId: createRuntimeIdGenerator(),
      eventLogRepo: createEventLogRepo()
    });

    await service.apply({
      runId: "run-1",
      workspaceId: "workspace-1",
      targetObject: "memory:expired",
      correction: "expired",
      expiresAt: "2026-03-24T00:05:00.000Z"
    });
    await service.apply({
      runId: "run-2",
      workspaceId: "workspace-1",
      targetObject: "memory:active",
      correction: "active",
      expiresAt: "2026-03-24T01:00:00.000Z"
    });

    now = "2026-03-24T00:30:00.000Z";
    service.clearExpired();

    await expect(service.getActiveFor("run-1")).resolves.toEqual([]);
    expect((await service.getActiveFor("run-2")).map((entry) => entry.target_object)).toEqual(["memory:active"]);
  });

  it("clearRun invalidates one run cache and lets deleted EventLog truth win", async () => {
    const appendedEvents: EventLogEntry[] = [];
    const deletedRuns = new Set<string>();
    const queryByRun = vi.fn(async (runId: string) => {
      if (deletedRuns.has(runId)) {
        return [];
      }

      return appendedEvents.filter((entry) => entry.run_id === runId);
    });
    const eventLogRepo = {
      append: vi.fn(async (event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => {
        const entry = createEventLogEntry(event);
        appendedEvents.push(entry);
        return entry;
      }),
      queryByEntity: vi.fn(async () => []),
      queryByRun
    };
    const service = new SessionOverrideService({
      now: () => "2026-03-24T00:00:00.000Z",
      generateRuntimeId: createRuntimeIdGenerator(),
      eventLogRepo
    });

    await service.apply({
      runId: "run-1",
      workspaceId: "workspace-1",
      targetObject: "memory:a",
      correction: "a"
    });
    await service.apply({
      runId: "run-2",
      workspaceId: "workspace-1",
      targetObject: "memory:b",
      correction: "b"
    });

    service.clearRun("run-1");
    deletedRuns.add("run-1");
    const queryCountBeforeLookup = queryByRun.mock.calls.length;

    await expect(service.getActiveFor("run-1")).resolves.toEqual([]);
    expect(queryByRun).toHaveBeenCalledTimes(queryCountBeforeLookup + 1);
    expect(queryByRun).toHaveBeenLastCalledWith("run-1");
    await expect(service.getActiveFor("run-2")).resolves.toHaveLength(1);
  });

  it("rehydrates active overrides from the EventLog when a new service instance is created", async () => {
    const eventLogRepo = createEventLogRepo();
    const firstService = new SessionOverrideService({
      now: () => "2026-03-24T00:00:00.000Z",
      generateRuntimeId: createRuntimeIdGenerator(),
      eventLogRepo
    });

    await firstService.apply({
      runId: "run-1",
      workspaceId: "workspace-1",
      targetObject: "memory:a",
      correction: "a",
      derivedFrom: "msg_user_explicit"
    });

    const restartedService = new SessionOverrideService({
      now: () => "2026-03-24T00:00:00.000Z",
      generateRuntimeId: createRuntimeIdGenerator(),
      eventLogRepo
    });

    await expect(restartedService.getActiveFor("run-1")).resolves.toEqual([
      expect.objectContaining({
        runtime_id: "00000000-0000-4000-8000-000000000000",
        target_object: "memory:a",
        correction: "a",
        derived_from: "msg_user_explicit"
      })
    ]);
  });

  it("rehydrates legacy applied events that predate derived_from persistence", async () => {
    const eventLogRepo = createEventLogRepo({
      queryByRun: vi.fn(async () => [
        createEventLogEntry({
          event_type: GreenGovernanceEventType.SOUL_SESSION_OVERRIDE_APPLIED,
          entity_type: "session_override",
          entity_id: "00000000-0000-4000-8000-000000000123",
          workspace_id: "workspace-1",
          run_id: "run-1",
          caused_by: "user_action",
          payload_json: {
            override_id: "00000000-0000-4000-8000-000000000123",
            target_object: "memory:a",
            correction: "a",
            priority: 0,
            run_id: "run-1",
            expires_at: "2026-03-24T01:00:00.000Z",
            occurred_at: "2026-03-24T00:00:00.000Z"
          }
        })
      ])
    });
    const service = new SessionOverrideService({
      now: () => "2026-03-24T00:00:00.000Z",
      generateRuntimeId: createRuntimeIdGenerator(),
      eventLogRepo
    });

    await expect(service.getActiveFor("run-1")).resolves.toEqual([
      expect.objectContaining({
        runtime_id: "00000000-0000-4000-8000-000000000123",
        target_object: "memory:a",
        derived_from: null
      })
    ]);
  });

  it("does not let a stale rehydration overwrite a newly applied override", async () => {
    const queryDeferred = createDeferred<readonly EventLogEntry[]>();
    const service = new SessionOverrideService({
      now: () => "2026-03-24T00:00:00.000Z",
      generateRuntimeId: createRuntimeIdGenerator(),
      eventLogRepo: createEventLogRepo({
        queryByRun: vi.fn(async () => await queryDeferred.promise)
      })
    });

    const pendingLookup = service.getActiveFor("run-1");
    const applyPromise = service.apply({
      runId: "run-1",
      workspaceId: "workspace-1",
      targetObject: "memory:fresh",
      correction: "fresh correction",
      derivedFrom: "msg_user_fresh"
    });

    queryDeferred.resolve(Object.freeze([]));
    await pendingLookup;
    await applyPromise;
    await expect(service.getActiveFor("run-1")).resolves.toEqual([
      expect.objectContaining({
        target_object: "memory:fresh",
        derived_from: "msg_user_fresh"
      })
    ]);
  });

  it("defaults priority to zero and expiresAt to one hour from now", async () => {
    const service = new SessionOverrideService({
      now: () => "2026-03-24T00:00:00.000Z",
      generateRuntimeId: () => "11111111-1111-4111-8111-111111111111",
      eventLogRepo: createEventLogRepo()
    });

    const override = await service.apply({
      runId: "run-1",
      workspaceId: "workspace-1",
      targetObject: "memory:build-style",
      correction: "Use pnpm instead of npm."
    });

    expect(override.priority).toBe(0);
    expect(override.expires_at).toBe("2026-03-24T01:00:00.000Z");
  });

  it("derives evidence from the latest user message when none is provided", async () => {
    const service = new SessionOverrideService({
      now: () => "2026-03-24T00:00:00.000Z",
      generateRuntimeId: () => "11111111-1111-4111-8111-111111111111",
      eventLogRepo: createEventLogRepo({
        queryByRun: vi.fn(async () => [
          createEventLogEntry({
            event_type: WorkspaceRunEventType.RUN_MESSAGE_APPENDED,
            entity_type: "message",
            entity_id: "msg_user_1",
            workspace_id: "workspace-1",
            run_id: "run-1",
            caused_by: "user_action",
            payload_json: {
              run_id: "run-1",
              role: "user",
              content: "Use pnpm instead of npm.",
              message_id: "msg_user_1"
            }
          })
        ])
      })
    });

    const override = await service.apply({
      runId: "run-1",
      workspaceId: "workspace-1",
      targetObject: "memory:build-style",
      correction: "Use pnpm instead of npm."
    });

    expect(override.derived_from).toBe("msg_user_1");
  });

  it("prefers an explicit derivedFrom over run lookup", async () => {
    const service = new SessionOverrideService({
      now: () => "2026-03-24T00:00:00.000Z",
      generateRuntimeId: () => "11111111-1111-4111-8111-111111111111",
      eventLogRepo: createEventLogRepo()
    });

    const override = await service.apply({
      runId: "run-1",
      workspaceId: "workspace-1",
      targetObject: "memory:build-style",
      correction: "Use pnpm instead of npm.",
      derivedFrom: "msg_user_explicit"
    });

    expect(override.derived_from).toBe("msg_user_explicit");
  });
});

function createEventLogRepo(overrides: Partial<{
  append: TestMock;
  queryByRun: TestMock;
}> = {}) {
  const appendedEvents: EventLogEntry[] = [];

  return {
    append:
      overrides.append ??
      vi.fn(async (event) => {
        const entry = createEventLogEntry(event);
        appendedEvents.push(entry);
        return entry;
      }),
    queryByEntity: vi.fn(async () => []),
    queryByRun:
      overrides.queryByRun ??
      vi.fn(async (runId: string) => appendedEvents.filter((entry) => entry.run_id === runId))
  };
}

function createRuntimeIdGenerator(): () => string {
  let index = 0;

  return () => {
    const value = `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
    index += 1;
    return value;
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
