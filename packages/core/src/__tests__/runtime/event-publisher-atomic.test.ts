import { describe, expect, it, vi } from "vitest";
import {
  WorkerStateChangedPayloadSchema,
  WorkspaceRunEventType,
  type EventLogEntry
} from "@do-soul/alaya-protocol";
import { EventPublisher, type EventPublisherEventLogRepoPort } from "../../runtime/event-publisher.js";
import { firstDefined, requireAt } from "../helpers/defined.js";

/**
 * In-memory fake repo that simulates better-sqlite3 transaction semantics:
 * - `transactional(fn)` runs `fn` synchronously; if `fn` throws, all rows
 *   appended via `append` since BEGIN are removed.
 * - `append` allocates a new event_id and persists the row immediately.
 * - `deleteById` removes a row.
 *
 * This mirrors the storage-layer semantics tested separately in
 * `packages/storage/src/__tests__/event-log-repo.test.ts`.
 */
function buildFakeRepo(): EventPublisherEventLogRepoPort & {
  rows: EventLogEntry[];
} {
  const rows: EventLogEntry[] = [];
  let nextId = 0;
  let savepointStart: number | null = null;

  const buildEntry = (input: Omit<EventLogEntry, "event_id" | "created_at" | "revision">): EventLogEntry => {
    const revision = rows.filter(
      (row) => row.entity_type === input.entity_type && row.entity_id === input.entity_id
    ).length;
    return {
      ...input,
      revision,
      event_id: `evt-${nextId++}`,
      created_at: new Date(2026, 0, 1, 0, 0, nextId).toISOString()
    };
  };

  return {
    rows,
    append(input) {
      const entry = buildEntry(input);
      rows.push(entry);
      return entry;
    },
    deleteById(eventId) {
      const index = rows.findIndex((row) => row.event_id === eventId);
      if (index !== -1) {
        rows.splice(index, 1);
      }
    },
    transactional<T>(fn: () => T): T {
      // Snapshot the row count at BEGIN; if `fn` throws, truncate back to it.
      savepointStart = rows.length;
      try {
        const result = fn();
        savepointStart = null;
        return result;
      } catch (error) {
        if (savepointStart !== null) {
          rows.splice(savepointStart);
          savepointStart = null;
        }
        throw error;
      }
    }
  };
}

describe("EventPublisher.appendManyWithMutation (atomic)", () => {
  it("decides idempotency in the transaction before appending its EventLog row", async () => {
    const repo = buildFakeRepo();
    const publisher = new EventPublisher({
      eventLogRepo: repo,
      runHotStateService: { apply: vi.fn() },
      runtimeNotifier: { notify: vi.fn(), notifyEntry: vi.fn() }
    });
    let existing = false;
    const appendInput = {
      event_type: "worker.state_changed",
      entity_type: "worker_run",
      entity_id: "worker-decision-1",
      workspace_id: "ws-1",
      run_id: "run-1",
      caused_by: "worker_lifecycle",
      payload_json: WorkerStateChangedPayloadSchema.parse({
        workerId: "worker-decision-1",
        state: "active",
        previousState: "init"
      })
    } as const;

    const first = await publisher.decideAppendThenApply(() => {
      if (existing) {
        return { eventInputs: [], apply: () => "existing" };
      }
      return {
        eventInputs: [appendInput],
        apply: (entries) => {
          existing = true;
          return firstDefined(entries)?.event_id ?? "<missing>";
        }
      };
    });
    const replay = await publisher.decideAppendThenApply(() => ({
      eventInputs: [],
      apply: () => "existing"
    }));

    expect(first).toBe("evt-0");
    expect(replay).toBe("existing");
    expect(repo.rows).toHaveLength(1);
  });

  it("rolls back a decision append when its state application fails", async () => {
    const repo = buildFakeRepo();
    const publisher = new EventPublisher({
      eventLogRepo: repo,
      runHotStateService: { apply: vi.fn() },
      runtimeNotifier: { notify: vi.fn(), notifyEntry: vi.fn() }
    });

    await expect(
      publisher.decideAppendThenApply(() => ({
        eventInputs: [
          {
            event_type: "worker.state_changed",
            entity_type: "worker_run",
            entity_id: "worker-decision-rollback-1",
            workspace_id: "ws-1",
            run_id: "run-1",
            caused_by: "worker_lifecycle",
            payload_json: WorkerStateChangedPayloadSchema.parse({
              workerId: "worker-decision-rollback-1",
              state: "active",
              previousState: "init"
            })
          }
        ],
        apply: () => {
          throw new Error("decision application failed");
        }
      }))
    ).rejects.toThrow("decision application failed");

    expect(repo.rows).toEqual([]);
  });

  it("rolls back the EventLog row when the synchronous mutate throws (#BL-022)", async () => {
    const repo = buildFakeRepo();
    const publisher = new EventPublisher({
      eventLogRepo: repo,
      runHotStateService: { apply: vi.fn() },
      runtimeNotifier: { notify: vi.fn(), notifyEntry: vi.fn() }
    });

    const eventInput = {
      event_type: "worker.state_changed",
      entity_type: "worker_run",
      entity_id: "worker-rollback-1",
      workspace_id: "ws-1",
      run_id: "run-1",
      caused_by: "worker_lifecycle",
      payload_json: WorkerStateChangedPayloadSchema.parse({
        workerId: "worker-rollback-1",
        state: "frozen",
        previousState: "active"
      })
    } as const;

    await expect(
      publisher.appendManyWithMutation([eventInput], () => {
        throw new Error("synthetic mutate failure");
      })
    ).rejects.toThrow("synthetic mutate failure");

    // Without the transaction the row would survive if a crash landed between
    // INSERT and compensation.
    expect(repo.rows).toEqual([]);
  });

  it("delivers the persisted entries to mutate so audit_event_id is exact (#BL-021)", async () => {
    const repo = buildFakeRepo();
    const publisher = new EventPublisher({
      eventLogRepo: repo,
      runHotStateService: { apply: vi.fn() },
      runtimeNotifier: { notify: vi.fn(), notifyEntry: vi.fn() }
    });

    let captured: readonly EventLogEntry[] | null = null;
    const result = await publisher.appendManyWithMutation(
      [
        {
          event_type: WorkspaceRunEventType.RUN_CREATED,
          entity_type: "run",
          entity_id: "run-audit-1",
          workspace_id: "ws-1",
          run_id: "run-audit-1",
          caused_by: "user_action",
          payload_json: {
            run_id: "run-audit-1",
            workspace_id: "ws-1",
            run_mode: "chat",
            title: "audit"
          }
        }
      ],
      (entries) => {
        captured = entries;
        return firstDefined(entries)?.event_id ?? "<missing>";
      }
    );

    expect(captured).not.toBeNull();
    expect(captured!).toHaveLength(1);
    // The mutate's `firstDefined(entries).event_id` is the SAME id as the persisted row.
    // This is the proof that #BL-021's audit_event_id divergence is gone.
    expect(firstDefined(captured!).event_id).toBe(firstDefined(repo.rows).event_id);
    expect(result).toBe(firstDefined(repo.rows).event_id);
  });

  it("reports propagation failure after commit without failing the durable mutation", async () => {
    const repo = buildFakeRepo();
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const publisher = new EventPublisher({
      eventLogRepo: repo,
      runHotStateService: { apply: vi.fn() },
      runtimeNotifier: {
        notify: vi.fn(),
        notifyEntry: vi.fn(async () => {
          throw new Error("notify exploded");
        })
      }
    });

    await expect(
      publisher.appendManyWithMutation(
        [
          {
            event_type: "worker.state_changed",
            entity_type: "worker_run",
            entity_id: "worker-propagate-1",
            workspace_id: "ws-1",
            run_id: "run-1",
            caused_by: "worker_lifecycle",
            payload_json: WorkerStateChangedPayloadSchema.parse({
              workerId: "worker-propagate-1",
              state: "active",
              previousState: "init"
            })
          }
        ],
        () => "ok"
      )
    ).resolves.toBe("ok");

    // Transaction committed before propagation, so the row is durable.
    expect(firstDefined(repo.rows)?.event_id).toBe("evt-0");
    expect(emitWarning).toHaveBeenCalledWith(
      "[EventPublisher] Propagation failed after commit",
      expect.objectContaining({
        code: "ALAYA_EVENT_PROPAGATION_FAILED_AFTER_COMMIT"
      })
    );

    emitWarning.mockRestore();
  });

  it("committed/detached mutation returns after commit when propagation never settles", async () => {
    const repo = buildFakeRepo();
    const notifyEntry = vi.fn(() => new Promise<void>(() => undefined));
    const publisher = new EventPublisher({
      eventLogRepo: repo,
      runHotStateService: { apply: vi.fn() },
      runtimeNotifier: {
        notify: vi.fn(),
        notifyEntry
      }
    });

    const result = publisher.appendManyWithMutationAndDetachPropagation(
      [
        {
          event_type: "worker.state_changed",
          entity_type: "worker_run",
          entity_id: "worker-detached-1",
          workspace_id: "ws-1",
          run_id: "run-1",
          caused_by: "worker_lifecycle",
          payload_json: WorkerStateChangedPayloadSchema.parse({
            workerId: "worker-detached-1",
            state: "active",
            previousState: "init"
          })
        }
      ],
      () => "committed"
    );

    expect(result).toBe("committed");
    expect(repo.rows).toHaveLength(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(notifyEntry).toHaveBeenCalledTimes(1);
  });

  it("emits an operator-visible warning when detached propagation rejects", async () => {
    const repo = buildFakeRepo();
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const publisher = new EventPublisher({
      eventLogRepo: repo,
      runHotStateService: { apply: vi.fn() },
      runtimeNotifier: {
        notify: vi.fn(),
        notifyEntry: vi.fn(async () => {
          throw new Error("detached notify exploded");
        })
      }
    });

    publisher.appendManyWithMutationAndDetachPropagation(
      [
        {
          event_type: "worker.state_changed",
          entity_type: "worker_run",
          entity_id: "worker-detached-fail-1",
          workspace_id: "ws-1",
          run_id: "run-1",
          caused_by: "worker_lifecycle",
          payload_json: WorkerStateChangedPayloadSchema.parse({
            workerId: "worker-detached-fail-1",
            state: "active",
            previousState: "init"
          })
        }
      ],
      () => "committed"
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(emitWarning).toHaveBeenCalledWith(
      "[EventPublisher] Detached propagation failed after commit",
      expect.objectContaining({
        code: "ALAYA_EVENT_PROPAGATION_DETACHED_FAILED"
      })
    );

    emitWarning.mockRestore();
  });

  it("committed/detached mutation still rolls back when the synchronous mutate throws", () => {
    const repo = buildFakeRepo();
    const publisher = new EventPublisher({
      eventLogRepo: repo,
      runHotStateService: { apply: vi.fn() },
      runtimeNotifier: { notify: vi.fn(), notifyEntry: vi.fn() }
    });

    expect(() =>
      publisher.appendManyWithMutationAndDetachPropagation(
        [
          {
            event_type: "worker.state_changed",
            entity_type: "worker_run",
            entity_id: "worker-detached-rollback-1",
            workspace_id: "ws-1",
            run_id: "run-1",
            caused_by: "worker_lifecycle",
            payload_json: WorkerStateChangedPayloadSchema.parse({
              workerId: "worker-detached-rollback-1",
              state: "active",
              previousState: "init"
            })
          }
        ],
        () => {
          throw new Error("synthetic detached mutate failure");
        }
      )
    ).toThrow("synthetic detached mutate failure");

    expect(repo.rows).toEqual([]);
  });

  it("rejects an accidentally-async mutate callback so atomicity cannot silently break", async () => {
    const repo = buildFakeRepo();
    const publisher = new EventPublisher({
      eventLogRepo: repo,
      runHotStateService: { apply: vi.fn() },
      runtimeNotifier: { notify: vi.fn(), notifyEntry: vi.fn() }
    });

    await expect(
      publisher.appendManyWithMutation(
        [
          {
            event_type: "worker.state_changed",
            entity_type: "worker_run",
            entity_id: "worker-async-bad",
            workspace_id: "ws-1",
            run_id: "run-1",
            caused_by: "worker_lifecycle",
            payload_json: WorkerStateChangedPayloadSchema.parse({
              workerId: "worker-async-bad",
              state: "active",
              previousState: "init"
            })
          }
        ],
        // Intentionally async — must throw and roll back.
        (async () => {
          return "should-not-commit";
        }) as unknown as () => string
      )
    ).rejects.toThrow(/must be synchronous/);

    expect(repo.rows).toEqual([]);
  });

  it("appends multiple events atomically and revisions are sequential per entity", async () => {
    const repo = buildFakeRepo();
    const publisher = new EventPublisher({
      eventLogRepo: repo,
      runHotStateService: { apply: vi.fn() },
      runtimeNotifier: { notify: vi.fn(), notifyEntry: vi.fn() }
    });

    const buildInput = (entityId: string) =>
      ({
        event_type: "worker.state_changed",
        entity_type: "worker_run",
        entity_id: entityId,
        workspace_id: "ws-1",
        run_id: "run-1",
        caused_by: "worker_lifecycle",
        payload_json: WorkerStateChangedPayloadSchema.parse({
          workerId: entityId,
          state: "active",
          previousState: "init"
        })
      }) as const;

    await publisher.appendManyWithMutation(
      [buildInput("w1"), buildInput("w1"), buildInput("w2")],
      (entries) => {
        expect(entries).toHaveLength(3);
        expect(requireAt(entries, 0).revision).toBe(0);
        expect(requireAt(entries, 1).revision).toBe(1);
        expect(requireAt(entries, 2).revision).toBe(0);
      }
    );
    expect(repo.rows).toHaveLength(3);
  });

  it("treats an empty event list as a passthrough mutate call", async () => {
    const repo = buildFakeRepo();
    const publisher = new EventPublisher({
      eventLogRepo: repo,
      runHotStateService: { apply: vi.fn() },
      runtimeNotifier: { notify: vi.fn(), notifyEntry: vi.fn() }
    });

    const result = await publisher.appendManyWithMutation([], (entries) => {
      expect(entries).toEqual([]);
      return "no-op";
    });
    expect(result).toBe("no-op");
    expect(repo.rows).toEqual([]);
  });

  it("rejects an accidentally-async empty-batch mutate callback", async () => {
    const repo = buildFakeRepo();
    const publisher = new EventPublisher({
      eventLogRepo: repo,
      runHotStateService: { apply: vi.fn() },
      runtimeNotifier: { notify: vi.fn(), notifyEntry: vi.fn() }
    });

    await expect(
      publisher.appendManyWithMutation(
        [],
        (async () => "should-not-commit") as unknown as () => string
      )
    ).rejects.toThrow(/must be synchronous/);
    expect(repo.rows).toEqual([]);
  });
});
