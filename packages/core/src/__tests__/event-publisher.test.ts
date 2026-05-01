import { describe, expect, it, vi } from "vitest";
import {
  Phase0EventType,
  RunCreatedPayloadSchema,
  RunMessageAppendedPayloadSchema,
  WorkerStateChangedPayloadSchema,
  type EventLogEntry
} from "@do-soul/alaya-protocol";
import { EventPublisher, EventPublisherPropagationError } from "../event-publisher.js";

describe("EventPublisher", () => {
  it("publishes A1 worker lifecycle events without requiring Phase 0 parsing", async () => {
    const recorded: string[] = [];
    const runHotStateService = {
      apply: vi.fn(async () => {
        recorded.push("apply");
      })
    };
    const runtimeNotifier = {
      notify: vi.fn(),
      notifyEntry: vi.fn(async () => {
        recorded.push("notify");
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
      runtimeNotifier: runtimeNotifier
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

    expect(recorded).toEqual(["append", "notify"]);
    expect(runHotStateService.apply).not.toHaveBeenCalled();
    expect(runtimeNotifier.notifyEntry).toHaveBeenCalledWith(entry);
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
    const runtimeNotifier = {
      notify: vi.fn(),
      notifyEntry: vi.fn(async () => {
        recorded.push("notify");
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
      runtimeNotifier: runtimeNotifier
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

    expect(recorded).toEqual(["append", "apply", "notify"]);
    expect(runHotStateService.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: Phase0EventType.RUN_CREATED,
        run_id: "run-1"
      })
    );
    expect(runtimeNotifier.notifyEntry).toHaveBeenCalledWith(entry);
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
      runtimeNotifier: {
        notify: vi.fn(),
        notifyEntry: vi.fn(async () => {
          throw new Error("notify exploded");
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
      runtimeNotifier: {
        notify: vi.fn(),
        notifyEntry: vi.fn(async () => {
          recorded.push("notify");
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
    expect(recorded).toEqual(["append", "mutate", "apply", "notify"]);
  });

  it("keeps append mutate notify ordering for non-Phase-0 mutation flows", async () => {
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
    const runtimeNotifier = {
      notify: vi.fn(),
      notifyEntry: vi.fn(async () => {
        recorded.push("notify");
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
      runtimeNotifier
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
    expect(recorded).toEqual(["append", "mutate", "notify"]);
    expect(runHotStateService.apply).not.toHaveBeenCalled();
  });

  it("passes the appended EventLog entry to mutation callbacks", async () => {
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
        previousState: "active"
      })
    });
    const mutate = vi.fn(async (auditEntry: EventLogEntry) => auditEntry.event_id);
    const publisher = new EventPublisher({
      eventLogRepo: {
        append: vi.fn(async () => entry),
        deleteById: vi.fn()
      },
      runHotStateService: { apply: vi.fn() } as any,
      runtimeNotifier: {
        notify: vi.fn(),
        notifyEntry: vi.fn()
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
        mutate
      )
    ).resolves.toBe(entry.event_id);

    expect(mutate).toHaveBeenCalledWith(entry);
  });

  it("deletes an unnotified event-log entry when mutation fails", async () => {
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
    const runtimeNotifier = {
      notify: vi.fn(),
      notifyEntry: vi.fn(async () => {
        recorded.push("notify");
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
      runtimeNotifier
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
    expect(runtimeNotifier.notifyEntry).not.toHaveBeenCalled();
  });

  it("deletes every unnotified batch entry when publishManyWithMutation mutation fails", async () => {
    const recorded: string[] = [];
    const entries = [
      createEventLogEntry({
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
          previousState: "active"
        })
      }),
      createEventLogEntry({
        event_type: "worker.state_changed",
        entity_type: "worker_run",
        entity_id: "worker-2",
        workspace_id: "ws-1",
        run_id: "run-1",
        caused_by: "worker_lifecycle",
        revision: 0,
        payload_json: WorkerStateChangedPayloadSchema.parse({
          workerId: "worker-2",
          state: "aborted",
          previousState: "active",
          abortReason: "timeout"
        })
      })
    ];
    let nextEntry = 0;
    const deleteById = vi.fn(async (eventId: string) => {
      recorded.push(`delete:${eventId}`);
    });
    const notifyEntry = vi.fn(async () => {
      recorded.push("notify");
    });
    const publisher = new EventPublisher({
      eventLogRepo: {
        append: vi.fn(async () => {
          const entry = entries[nextEntry];
          if (entry === undefined) {
            throw new Error("unexpected append");
          }
          nextEntry += 1;
          recorded.push(`append:${entry.event_id}`);
          return entry;
        }),
        deleteById
      },
      runHotStateService: { apply: vi.fn(async () => undefined) } as any,
      runtimeNotifier: {
        notify: vi.fn(),
        notifyEntry
      }
    });

    await expect(
      publisher.publishManyWithMutation(entries.map(toEventInput), async () => {
        recorded.push("mutate");
        throw new Error("mutation failed");
      })
    ).rejects.toThrow("mutation failed");

    expect(recorded).toEqual([
      "append:evt_worker-1",
      "append:evt_worker-2",
      "mutate",
      "delete:evt_worker-1",
      "delete:evt_worker-2"
    ]);
    expect(deleteById).toHaveBeenCalledTimes(2);
    expect(notifyEntry).not.toHaveBeenCalled();
  });

  it("rolls back already appended batch entries when a later append fails", async () => {
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
        previousState: "active"
      })
    });
    const secondInput = {
      ...toEventInput(entry),
      entity_id: "worker-2",
      payload_json: WorkerStateChangedPayloadSchema.parse({
        workerId: "worker-2",
        state: "aborted",
        previousState: "active"
      })
    };
    const deleteById = vi.fn(async (eventId: string) => {
      recorded.push(`delete:${eventId}`);
    });
    const mutate = vi.fn(async () => {
      recorded.push("mutate");
      return "ok";
    });
    const notifyEntry = vi.fn(async () => {
      recorded.push("notify");
    });
    let appendCount = 0;
    const publisher = new EventPublisher({
      eventLogRepo: {
        append: vi.fn(async () => {
          appendCount += 1;
          if (appendCount === 1) {
            recorded.push(`append:${entry.event_id}`);
            return entry;
          }

          recorded.push("append:failed");
          throw new Error("append failed");
        }),
        deleteById
      },
      runHotStateService: { apply: vi.fn(async () => undefined) } as any,
      runtimeNotifier: {
        notify: vi.fn(),
        notifyEntry
      }
    });

    await expect(publisher.publishManyWithMutation([toEventInput(entry), secondInput], mutate)).rejects.toThrow(
      "append failed"
    );

    expect(recorded).toEqual(["append:evt_worker-1", "append:failed", "delete:evt_worker-1"]);
    expect(deleteById).toHaveBeenCalledWith(entry.event_id);
    expect(mutate).not.toHaveBeenCalled();
    expect(notifyEntry).not.toHaveBeenCalled();
  });

  it("exposes the full durable batch when publishManyWithMutation propagation fails", async () => {
    const recorded: string[] = [];
    const entries = [
      createEventLogEntry({
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
          previousState: "active"
        })
      }),
      createEventLogEntry({
        event_type: "worker.state_changed",
        entity_type: "worker_run",
        entity_id: "worker-2",
        workspace_id: "ws-1",
        run_id: "run-1",
        caused_by: "worker_lifecycle",
        revision: 0,
        payload_json: WorkerStateChangedPayloadSchema.parse({
          workerId: "worker-2",
          state: "aborted",
          previousState: "active",
          abortReason: "timeout"
        })
      })
    ];
    let nextEntry = 0;
    const deleteById = vi.fn(async (eventId: string) => {
      recorded.push(`delete:${eventId}`);
    });
    const publisher = new EventPublisher({
      eventLogRepo: {
        append: vi.fn(async () => {
          const entry = entries[nextEntry];
          if (entry === undefined) {
            throw new Error("unexpected append");
          }
          nextEntry += 1;
          recorded.push(`append:${entry.event_id}`);
          return entry;
        }),
        deleteById
      },
      runHotStateService: { apply: vi.fn(async () => undefined) } as any,
      runtimeNotifier: {
        notify: vi.fn(),
        notifyEntry: vi.fn(async (entry: EventLogEntry) => {
          recorded.push(`notify:${entry.event_id}`);
          if (entry.event_id === entries[1].event_id) {
            throw new Error("notify failed");
          }
        })
      }
    });

    const rejection = await publisher
      .publishManyWithMutation(entries.map(toEventInput), async () => {
        recorded.push("mutate");
        return "ok";
      })
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(EventPublisherPropagationError);
    expect(rejection).toMatchObject({
      name: "EventPublisherPropagationError",
      entry: entries[1],
      entries
    });
    expect(recorded).toEqual([
      "append:evt_worker-1",
      "append:evt_worker-2",
      "mutate",
      "notify:evt_worker-1",
      "notify:evt_worker-2"
    ]);
    expect(deleteById).not.toHaveBeenCalled();
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

function toEventInput(entry: EventLogEntry): Omit<EventLogEntry, "event_id" | "created_at"> {
  return {
    event_type: entry.event_type,
    entity_type: entry.entity_type,
    entity_id: entry.entity_id,
    workspace_id: entry.workspace_id,
    run_id: entry.run_id,
    caused_by: entry.caused_by,
    revision: entry.revision,
    payload_json: entry.payload_json
  };
}
