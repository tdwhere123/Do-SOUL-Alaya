import { describe, expect, it, vi } from "vitest";
import {
  Phase0EventType,
  RunCreatedPayloadSchema,
  RunMessageAppendedPayloadSchema,
  WorkerStateChangedPayloadSchema,
  type EventLogEntry
} from "@do-what/protocol";
import { EventPublisher, EventPublisherPropagationError } from "../event-publisher.js";

describe("EventPublisher", () => {
  it("publishes A1 worker lifecycle events without requiring Phase 0 parsing", async () => {
    const recorded: string[] = [];
    const runHotStateService = {
      apply: vi.fn(async () => {
        recorded.push("apply");
      })
    };
    const broadcaster = {
      broadcast: vi.fn(),
      broadcastEntry: vi.fn(async () => {
        recorded.push("broadcast");
      })
    };
    const entry = createEventLogEntry({
      event_type: "worker.state_changed",
      entity_type: "worker_run",
      entity_id: "worker-1",
      workspace_id: "ws-1",
      run_id: "run-1",
      caused_by: "system",
      revision: 0,
      payload_json: WorkerStateChangedPayloadSchema.parse({
        workerId: "worker-1",
        state: "active",
        previousState: "init"
      })
    });
    const publisher = new EventPublisher({
      eventLogRepo: {
        append: vi.fn(async () => {
          recorded.push("append");
          return entry;
        }),
        deleteById: vi.fn()
      },
      runHotStateService: runHotStateService as any,
      sseBroadcaster: broadcaster
    });

    await expect(
      publisher.publish({
        event_type: entry.event_type,
        entity_type: entry.entity_type,
        entity_id: entry.entity_id,
        workspace_id: entry.workspace_id,
        run_id: entry.run_id,
        caused_by: entry.caused_by,
        revision: entry.revision,
        payload_json: entry.payload_json
      })
    ).resolves.toEqual(entry);

    expect(recorded).toEqual(["append", "broadcast"]);
    expect(runHotStateService.apply).not.toHaveBeenCalled();
    expect(broadcaster.broadcastEntry).toHaveBeenCalledWith(entry);
  });

  it("still applies Phase 0 run hot state updates for legacy events", async () => {
    const recorded: string[] = [];
    const entry = createEventLogEntry({
      event_type: Phase0EventType.RUN_CREATED,
      entity_type: "run",
      entity_id: "run-1",
      workspace_id: "ws-1",
      run_id: "run-1",
      caused_by: "user_action",
      revision: 0,
      payload_json: RunCreatedPayloadSchema.parse({
        run_id: "run-1",
        workspace_id: "ws-1",
        run_mode: "chat",
        title: "Test run"
      })
    });
    const runHotStateService = {
      apply: vi.fn(async () => {
        recorded.push("apply");
      })
    };
    const broadcaster = {
      broadcast: vi.fn(),
      broadcastEntry: vi.fn(async () => {
        recorded.push("broadcast");
      })
    };
    const publisher = new EventPublisher({
      eventLogRepo: {
        append: vi.fn(async () => {
          recorded.push("append");
          return entry;
        }),
        deleteById: vi.fn()
      },
      runHotStateService: runHotStateService as any,
      sseBroadcaster: broadcaster
    });

    await publisher.publish({
      event_type: entry.event_type,
      entity_type: entry.entity_type,
      entity_id: entry.entity_id,
      workspace_id: entry.workspace_id,
      run_id: entry.run_id,
      caused_by: entry.caused_by,
      revision: entry.revision,
      payload_json: entry.payload_json
    });

    expect(recorded).toEqual(["append", "apply", "broadcast"]);
    expect(runHotStateService.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: Phase0EventType.RUN_CREATED,
        run_id: "run-1"
      })
    );
    expect(broadcaster.broadcastEntry).toHaveBeenCalledWith(entry);
  });

  it("surfaces when propagation fails after append so callers know the event is already durable", async () => {
    const entry = createEventLogEntry({
      event_type: "worker.integration_status",
      entity_type: "worker_run",
      entity_id: "worker-1",
      workspace_id: "ws-1",
      run_id: "run-1",
      caused_by: "system",
      revision: 0,
      payload_json: {
        workerRunId: "worker-1",
        level: "soft_stale",
        reason: "supports_interrupt expected=true actual=false",
        detectedAt: "2026-04-14T06:00:00.000Z"
      }
    });
    const publisher = new EventPublisher({
      eventLogRepo: {
        append: vi.fn(async () => entry),
        deleteById: vi.fn()
      },
      runHotStateService: {
        apply: vi.fn(async () => undefined)
      } as any,
      sseBroadcaster: {
        broadcast: vi.fn(),
        broadcastEntry: vi.fn(async () => {
          throw new Error("broadcast exploded");
        })
      }
    });

    await expect(
      publisher.publish({
        event_type: entry.event_type,
        entity_type: entry.entity_type,
        entity_id: entry.entity_id,
        workspace_id: entry.workspace_id,
        run_id: entry.run_id,
        caused_by: entry.caused_by,
        revision: entry.revision,
        payload_json: entry.payload_json
      })
    ).rejects.toMatchObject({
      name: "EventPublisherPropagationError",
      entry
    });
  });

  it("keeps append mutate propagate ordering for Phase 0 mutation flows", async () => {
    const recorded: string[] = [];
    const entry = createEventLogEntry({
      event_type: Phase0EventType.RUN_MESSAGE_APPENDED,
      entity_type: "message",
      entity_id: "msg-1",
      workspace_id: "ws-1",
      run_id: "run-1",
      caused_by: "user_action",
      revision: 0,
      payload_json: RunMessageAppendedPayloadSchema.parse({
        run_id: "run-1",
        role: "user",
        content: "hello",
        message_id: "msg-1"
      })
    });
    const publisher = new EventPublisher({
      eventLogRepo: {
        append: vi.fn(async () => {
          recorded.push("append");
          return entry;
        }),
        deleteById: vi.fn()
      },
      runHotStateService: {
        apply: vi.fn(async () => {
          recorded.push("apply");
        })
      } as any,
      sseBroadcaster: {
        broadcast: vi.fn(),
        broadcastEntry: vi.fn(async () => {
          recorded.push("broadcast");
        })
      }
    });

    const result = await publisher.publishWithMutation(
      {
        event_type: entry.event_type,
        entity_type: entry.entity_type,
        entity_id: entry.entity_id,
        workspace_id: entry.workspace_id,
        run_id: entry.run_id,
        caused_by: entry.caused_by,
        revision: entry.revision,
        payload_json: entry.payload_json
      },
      async () => {
        recorded.push("mutate");
        return "ok";
      }
    );

    expect(result).toBe("ok");
    expect(recorded).toEqual(["append", "mutate", "apply", "broadcast"]);
  });

  it("keeps append mutate broadcast ordering for non-Phase-0 mutation flows", async () => {
    const recorded: string[] = [];
    const entry = createEventLogEntry({
      event_type: "worker.state_changed",
      entity_type: "worker_run",
      entity_id: "worker-1",
      workspace_id: "ws-1",
      run_id: "run-1",
      caused_by: "worker_lifecycle",
      revision: 0,
      payload_json: WorkerStateChangedPayloadSchema.parse({
        workerId: "worker-1",
        state: "frozen",
        previousState: "active",
        panicSource: "dirty_state_panic",
        panicSummary: "state divergence"
      })
    });
    const runHotStateService = {
      apply: vi.fn(async () => {
        recorded.push("apply");
      })
    };
    const publisher = new EventPublisher({
      eventLogRepo: {
        append: vi.fn(async () => {
          recorded.push("append");
          return entry;
        }),
        deleteById: vi.fn()
      },
      runHotStateService: runHotStateService as any,
      sseBroadcaster: {
        broadcast: vi.fn(),
        broadcastEntry: vi.fn(async () => {
          recorded.push("broadcast");
        })
      }
    });

    const result = await publisher.publishWithMutation(
      {
        event_type: entry.event_type,
        entity_type: entry.entity_type,
        entity_id: entry.entity_id,
        workspace_id: entry.workspace_id,
        run_id: entry.run_id,
        caused_by: entry.caused_by,
        revision: entry.revision,
        payload_json: entry.payload_json
      },
      async () => {
        recorded.push("mutate");
        return "ok";
      }
    );

    expect(result).toBe("ok");
    expect(recorded).toEqual(["append", "mutate", "broadcast"]);
    expect(runHotStateService.apply).not.toHaveBeenCalled();
  });

  it("deletes an unbroadcast event-log entry when mutation fails", async () => {
    const recorded: string[] = [];
    const entry = createEventLogEntry({
      event_type: "worker.state_changed",
      entity_type: "worker_run",
      entity_id: "worker-1",
      workspace_id: "ws-1",
      run_id: "run-1",
      caused_by: "worker_lifecycle",
      revision: 0,
      payload_json: WorkerStateChangedPayloadSchema.parse({
        workerId: "worker-1",
        state: "aborted",
        previousState: "active",
        abortReason: "timeout",
        rollbackAttempted: true
      })
    });
    const deleteById = vi.fn(async () => {
      recorded.push("delete");
    });
    const runHotStateService = {
      apply: vi.fn(async () => {
        recorded.push("apply");
      })
    };
    const publisher = new EventPublisher({
      eventLogRepo: {
        append: vi.fn(async () => {
          recorded.push("append");
          return entry;
        }),
        deleteById
      },
      runHotStateService: runHotStateService as any,
      sseBroadcaster: {
        broadcast: vi.fn(),
        broadcastEntry: vi.fn(async () => {
          recorded.push("broadcast");
        })
      }
    });

    await expect(
      publisher.publishWithMutation(
        {
          event_type: entry.event_type,
          entity_type: entry.entity_type,
          entity_id: entry.entity_id,
          workspace_id: entry.workspace_id,
          run_id: entry.run_id,
          caused_by: entry.caused_by,
          revision: entry.revision,
          payload_json: entry.payload_json
        },
        async () => {
          recorded.push("mutate");
          throw new Error("write failed");
        }
      )
    ).rejects.toThrow("write failed");

    expect(recorded).toEqual(["append", "mutate", "delete"]);
    expect(deleteById).toHaveBeenCalledWith(entry.event_id);
    expect(runHotStateService.apply).not.toHaveBeenCalled();
  });
});

function createEventLogEntry(
  input: Omit<EventLogEntry, "event_id" | "created_at">
): EventLogEntry {
  return {
    event_id: `evt_${input.entity_id}`,
    created_at: "2026-04-10T00:00:00.000Z",
    ...input
  };
}
