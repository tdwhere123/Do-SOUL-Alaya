import { describe, expect, it, vi } from "vitest";
import {
  RunCreatedPayloadSchema,
  RunMessageAppendedPayloadSchema,
  WorkerStateChangedPayloadSchema,
  WorkspaceRunEventType,
  type EventLogEntry
} from "@do-soul/alaya-protocol";
import {
  EventPublisher,
  type EventPublisherEventLogRepoPort,
  type EventPublisherInput
} from "../../runtime/event-publisher.js";
import { firstDefined, requireAt } from "../helpers/defined.js";

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
      payload_json: WorkerStateChangedPayloadSchema.parse({
        workerId: "worker-1",
        state: "active",
        previousState: "init"
      })
    });
    const publisher = new EventPublisher({
      eventLogRepo: createSingleEntryRepo(entry, recorded),
      runHotStateService,
      runtimeNotifier
    });

    await expect(publisher.publish(toEventInput(entry))).resolves.toEqual(entry);

    expect(recorded).toEqual(["append", "notify"]);
    expect(runHotStateService.apply).not.toHaveBeenCalled();
    expect(runtimeNotifier.notifyEntry).toHaveBeenCalledWith(entry);
  });

  it("still applies Phase 0 run hot state updates for legacy events", async () => {
    const recorded: string[] = [];
    const entry = createEventLogEntry({
      event_type: WorkspaceRunEventType.RUN_CREATED,
      entity_type: "run",
      entity_id: "run-1",
      workspace_id: "ws-1",
      run_id: "run-1",
      caused_by: "user_action",
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
      eventLogRepo: createSingleEntryRepo(entry, recorded),
      runHotStateService,
      runtimeNotifier
    });

    await publisher.publish(toEventInput(entry));

    expect(recorded).toEqual(["append", "apply", "notify"]);
    expect(runHotStateService.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: WorkspaceRunEventType.RUN_CREATED,
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
      payload_json: {
        workerRunId: "worker-1",
        level: "soft_stale",
        reason: "supports_interrupt expected=true actual=false",
        detectedAt: "2026-04-14T06:00:00.000Z"
      }
    });
    const publisher = new EventPublisher({
      eventLogRepo: createSingleEntryRepo(entry),
      runHotStateService: {
        apply: vi.fn(async () => undefined)
      },
      runtimeNotifier: {
        notify: vi.fn(),
        notifyEntry: vi.fn(async () => {
          throw new Error("notify exploded");
        })
      }
    });

    await expect(publisher.publish(toEventInput(entry))).rejects.toMatchObject({
      name: "EventPublisherPropagationError",
      entry
    });
  });

  it("keeps append mutate propagate ordering for Phase 0 mutation flows", async () => {
    const recorded: string[] = [];
    const entry = createEventLogEntry({
      event_type: WorkspaceRunEventType.RUN_MESSAGE_APPENDED,
      entity_type: "message",
      entity_id: "msg-1",
      workspace_id: "ws-1",
      run_id: "run-1",
      caused_by: "user_action",
      payload_json: RunMessageAppendedPayloadSchema.parse({
        run_id: "run-1",
        role: "user",
        content: "hello",
        message_id: "msg-1"
      })
    });
    const publisher = new EventPublisher({
      eventLogRepo: createSingleEntryRepo(entry, recorded),
      runHotStateService: {
        apply: vi.fn(async () => {
          recorded.push("apply");
        })
      },
      runtimeNotifier: {
        notify: vi.fn(),
        notifyEntry: vi.fn(async () => {
          recorded.push("notify");
        })
      }
    });

    const result = await publisher.appendManyWithMutation([toEventInput(entry)], () => {
      recorded.push("mutate");
      return "ok";
    });

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
      eventLogRepo: createSingleEntryRepo(entry, recorded),
      runHotStateService,
      runtimeNotifier
    });

    const result = await publisher.appendManyWithMutation([toEventInput(entry)], () => {
      recorded.push("mutate");
      return "ok";
    });

    expect(result).toBe("ok");
    expect(recorded).toEqual(["append", "mutate", "notify"]);
    expect(runHotStateService.apply).not.toHaveBeenCalled();
  });

  it("passes the appended EventLog entries to mutation callbacks", async () => {
    const entry = createEventLogEntry({
      event_type: "worker.state_changed",
      entity_type: "worker_run",
      entity_id: "worker-1",
      workspace_id: "ws-1",
      run_id: "run-1",
      caused_by: "worker_lifecycle",
      payload_json: WorkerStateChangedPayloadSchema.parse({
        workerId: "worker-1",
        state: "frozen",
        previousState: "active"
      })
    });
    const mutate = vi.fn((entries: readonly EventLogEntry[]) => firstDefined(entries)?.event_id);
    const publisher = new EventPublisher({
      eventLogRepo: createSingleEntryRepo(entry),
      runHotStateService: { apply: vi.fn() },
      runtimeNotifier: {
        notify: vi.fn(),
        notifyEntry: vi.fn()
      }
    });

    await expect(publisher.appendManyWithMutation([toEventInput(entry)], mutate)).resolves.toBe(entry.event_id);

    expect(mutate).toHaveBeenCalledWith([entry]);
  });

  it("reports propagation failure for the full durable batch without failing mutation callers", async () => {
    const recorded: string[] = [];
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const entries = [
      createEventLogEntry({
        event_type: "worker.state_changed",
        entity_type: "worker_run",
        entity_id: "worker-1",
        workspace_id: "ws-1",
        run_id: "run-1",
        caused_by: "worker_lifecycle",
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
        payload_json: WorkerStateChangedPayloadSchema.parse({
          workerId: "worker-2",
          state: "aborted",
          previousState: "active",
          abortReason: "timeout"
        })
      })
    ];
    const publisher = new EventPublisher({
      eventLogRepo: createQueuedRepo(entries, recorded),
      runHotStateService: { apply: vi.fn(async () => undefined) },
      runtimeNotifier: {
        notify: vi.fn(),
        notifyEntry: vi.fn(async (entry: EventLogEntry) => {
          recorded.push(`notify:${entry.event_id}`);
          if (entry.event_id === requireAt(entries, 1).event_id) {
            throw new Error("notify failed");
          }
        })
      }
    });

    const result = await publisher.appendManyWithMutation(entries.map(toEventInput), () => {
      recorded.push("mutate");
      return "ok";
    });

    expect(result).toBe("ok");
    expect(recorded).toEqual([
      "append:evt_worker-1",
      "append:evt_worker-2",
      "mutate",
      "notify:evt_worker-1",
      "notify:evt_worker-2"
    ]);
    expect(emitWarning).toHaveBeenCalledWith(
      "[EventPublisher] Propagation failed after commit",
      expect.objectContaining({
        code: "ALAYA_EVENT_PROPAGATION_FAILED_AFTER_COMMIT"
      })
    );
    emitWarning.mockRestore();
  });

  it("keeps append-then-apply ordering in mutateThenAppendMany with apply callback", async () => {
    const recorded: string[] = [];
    const entry = createEventLogEntry({
      event_type: "worker.state_changed",
      entity_type: "worker_run",
      entity_id: "worker-1",
      workspace_id: "ws-1",
      run_id: "run-1",
      caused_by: "system",
      payload_json: {}
    });
    const publisher = new EventPublisher({
      eventLogRepo: createSingleEntryRepo(entry, recorded),
      runHotStateService: { apply: vi.fn() },
      runtimeNotifier: {
        notify: vi.fn(),
        notifyEntry: vi.fn(async () => {
          recorded.push("notify");
        })
      }
    });

    const result = await publisher.mutateThenAppendMany(() => {
      recorded.push("compute");
      return {
        events: [toEventInput(entry)],
        result: "ok",
        apply: () => {
          recorded.push("apply");
        }
      };
    });

    expect(result.result).toBe("ok");
    expect(recorded).toEqual(["compute", "append", "apply", "notify"]);
  });
});

function createEventLogEntry(input: EventPublisherInput, revision = 0): EventLogEntry {
  return {
    ...input,
    revision,
    event_id: `evt_${input.entity_id}`,
    created_at: "2026-04-10T00:00:00.000Z"
  };
}

function toEventInput(entry: EventLogEntry): EventPublisherInput {
  return {
    event_type: entry.event_type,
    entity_type: entry.entity_type,
    entity_id: entry.entity_id,
    workspace_id: entry.workspace_id,
    run_id: entry.run_id,
    caused_by: entry.caused_by,
    payload_json: entry.payload_json
  };
}

function createSingleEntryRepo(entry: EventLogEntry, recorded: string[] = []): EventPublisherEventLogRepoPort {
  return {
    append: vi.fn(() => {
      recorded.push("append");
      return entry;
    }),
    deleteById: vi.fn(),
    transactional: <T>(fn: () => T): T => fn()
  };
}

function createQueuedRepo(
  entries: readonly EventLogEntry[],
  recorded: string[] = []
): EventPublisherEventLogRepoPort {
  let nextEntry = 0;
  return {
    append: vi.fn(() => {
      const entry = entries[nextEntry];
      if (entry === undefined) {
        throw new Error("unexpected append");
      }
      nextEntry += 1;
      recorded.push(`append:${entry.event_id}`);
      return entry;
    }),
    deleteById: vi.fn(),
    transactional: <T>(fn: () => T): T => fn()
  };
}
