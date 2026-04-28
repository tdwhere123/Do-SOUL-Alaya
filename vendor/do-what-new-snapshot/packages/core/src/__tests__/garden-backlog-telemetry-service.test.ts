import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PhaseCExtensionEventType,
  type EventLogEntry,
  type GardenBacklogSnapshot,
  type HealthJournalRecordInput
} from "@do-what/protocol";
import { GardenBacklogTelemetryService } from "../garden-backlog-telemetry-service.js";

describe("GardenBacklogTelemetryService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("starts and stops periodic snapshot publication idempotently", async () => {
    const harness = createHarness();

    harness.service.start();
    harness.service.start();

    await advanceTimersByTimeAndFlush(1_001);

    expect(harness.eventLogRepo.append).toHaveBeenCalledTimes(1);
    expect(harness.eventLogRepo.append).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: PhaseCExtensionEventType.GARDEN_BACKLOG_TELEMETRY_SNAPSHOT,
        entity_type: "garden_backlog",
        entity_id: "global"
      })
    );

    await harness.service.stop();
    await advanceTimersByTimeAndFlush(5_000);

    expect(harness.eventLogRepo.append).toHaveBeenCalledTimes(1);
  });

  it("emits backlog warnings and records journal context from the pending transition", async () => {
    const warningSnapshot = createSnapshot({
      observed_at: "2026-04-23T08:05:00.000Z",
      queue_depth_total: 12,
      queue_depth_by_tier: {
        tier_0: 3,
        tier_1: 4,
        tier_2: 5
      },
      warning_active: true
    });
    const harness = createHarness({
      transition: {
        transition_id: 1,
        transition: "arm",
        snapshot: warningSnapshot
      }
    });

    await expect(harness.service.capture()).resolves.toBeUndefined();

    expect(harness.eventLogRepo.append).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: PhaseCExtensionEventType.GARDEN_BACKLOG_WARNING,
        workspace_id: "system",
        run_id: null,
        payload_json: {
          ...warningSnapshot,
          workspace_id: "system",
          run_id: null,
          warning_queue_depth: 10,
          warning_rearm_depth: 7,
          transition: "arm"
        }
      })
    );
    expect(harness.scheduler.acknowledgeBacklogWarningTransition).toHaveBeenCalledWith(1);
    expect(harness.healthJournal.record).toHaveBeenCalledWith({
      event_kind: "garden_backlog",
      workspace_id: "system",
      run_id: null,
      summary: "Garden backlog warning arm at depth 12",
      detail_json: {
        workspace_id: "system",
        run_id: null,
        observed_at: "2026-04-23T08:05:00.000Z",
        queue_depth_total: 12,
        queue_depth_by_tier: {
          tier_0: 3,
          tier_1: 4,
          tier_2: 5
        },
        in_flight_total: 0,
        warning_active: true,
        warning_queue_depth: 10,
        warning_rearm_depth: 7,
        transition: "arm"
      }
    });
  });

  it("keeps the pending warning transition and suppresses journal writes when append fails", async () => {
    const warningSnapshot = createSnapshot({
      observed_at: "2026-04-23T08:05:00.000Z",
      queue_depth_total: 12,
      warning_active: true
    });
    let pendingTransition: {
      readonly transition_id: number;
      readonly transition: "arm" | "clear";
      readonly snapshot: GardenBacklogSnapshot;
    } | null = {
      transition_id: 1,
      transition: "arm",
      snapshot: warningSnapshot
    };
    const scheduler = {
      getBacklogSnapshot: vi.fn(() => warningSnapshot),
      peekBacklogWarningTransition: vi.fn(() => pendingTransition),
      peekLastBacklogWarningTransitionId: vi.fn(() => pendingTransition?.transition_id ?? null),
      acknowledgeBacklogWarningTransition: vi.fn((transitionId: number) => {
        if (pendingTransition?.transition_id !== transitionId) {
          return false;
        }

        pendingTransition = null;
        return true;
      })
    };
    const eventLogRepo = {
      append: vi
        .fn<
          (entry: Omit<EventLogEntry, "event_id" | "created_at">) => Promise<EventLogEntry>
        >()
        .mockRejectedValueOnce(new Error("warning event append failed"))
        .mockImplementationOnce(async (entry) => createEventLogEntry(entry)),
      queryByEntity: vi.fn(async () => [])
    };
    const healthJournal = {
      record: vi.fn(async (_entry: HealthJournalRecordInput) => undefined)
    };
    const service = new GardenBacklogTelemetryService({
      scheduler,
      eventLogRepo,
      healthJournal,
      thresholds: {
        warning_queue_depth: 10,
        warning_rearm_depth: 7,
        snapshot_interval_ms: 1_000
      }
    });

    await expect(service.capture()).resolves.toBeUndefined();
    expect(scheduler.acknowledgeBacklogWarningTransition).not.toHaveBeenCalled();
    expect(healthJournal.record).not.toHaveBeenCalled();
    expect(pendingTransition).toEqual({
      transition_id: 1,
      transition: "arm",
      snapshot: warningSnapshot
    });

    await expect(service.capture()).resolves.toBeUndefined();
    expect(scheduler.acknowledgeBacklogWarningTransition).toHaveBeenCalledWith(1);
    expect(healthJournal.record).toHaveBeenCalledTimes(1);
    expect(pendingTransition).toBeNull();
  });

  it("retries a pending warning transition from the periodic loop after an append failure", async () => {
    const warningSnapshot = createSnapshot({
      observed_at: "2026-04-23T08:05:00.000Z",
      queue_depth_total: 12,
      warning_active: true
    });
    let pendingTransition: {
      readonly transition_id: number;
      readonly transition: "arm" | "clear";
      readonly snapshot: GardenBacklogSnapshot;
    } | null = {
      transition_id: 1,
      transition: "arm",
      snapshot: warningSnapshot
    };
    const scheduler = {
      getBacklogSnapshot: vi.fn(() => warningSnapshot),
      peekBacklogWarningTransition: vi.fn(() => pendingTransition),
      peekLastBacklogWarningTransitionId: vi.fn(() => pendingTransition?.transition_id ?? null),
      acknowledgeBacklogWarningTransition: vi.fn((transitionId: number) => {
        if (pendingTransition?.transition_id !== transitionId) {
          return false;
        }

        pendingTransition = null;
        return true;
      })
    };
    const eventLogRepo = {
      append: vi
        .fn<
          (entry: Omit<EventLogEntry, "event_id" | "created_at">) => Promise<EventLogEntry>
        >()
        .mockRejectedValueOnce(new Error("warning event append failed"))
        .mockImplementation(async (entry) => createEventLogEntry(entry)),
      queryByEntity: vi.fn(async () => [])
    };
    const service = new GardenBacklogTelemetryService({
      scheduler,
      eventLogRepo,
      thresholds: {
        warning_queue_depth: 10,
        warning_rearm_depth: 7,
        snapshot_interval_ms: 1_000
      }
    });

    await expect(service.capture()).resolves.toBeUndefined();
    expect(pendingTransition).not.toBeNull();

    service.start();
    await advanceTimersByTimeAndFlush(1_001);
    await service.stop();

    expect(scheduler.acknowledgeBacklogWarningTransition).toHaveBeenCalledWith(1);
    expect(pendingTransition).toBeNull();
    expect(eventLogRepo.append.mock.calls.map(([entry]) => entry.event_type)).toEqual([
      PhaseCExtensionEventType.GARDEN_BACKLOG_WARNING,
      PhaseCExtensionEventType.GARDEN_BACKLOG_WARNING,
      PhaseCExtensionEventType.GARDEN_BACKLOG_TELEMETRY_SNAPSHOT
    ]);
  });

  it("retries a pending warning transition during stop after an append failure", async () => {
    const warningSnapshot = createSnapshot({
      observed_at: "2026-04-23T08:05:00.000Z",
      queue_depth_total: 12,
      warning_active: true
    });
    let pendingTransition: {
      readonly transition_id: number;
      readonly transition: "arm" | "clear";
      readonly snapshot: GardenBacklogSnapshot;
    } | null = {
      transition_id: 1,
      transition: "arm",
      snapshot: warningSnapshot
    };
    const scheduler = {
      getBacklogSnapshot: vi.fn(() => warningSnapshot),
      peekBacklogWarningTransition: vi.fn(() => pendingTransition),
      peekLastBacklogWarningTransitionId: vi.fn(() => pendingTransition?.transition_id ?? null),
      acknowledgeBacklogWarningTransition: vi.fn((transitionId: number) => {
        if (pendingTransition?.transition_id !== transitionId) {
          return false;
        }

        pendingTransition = null;
        return true;
      })
    };
    const eventLogRepo = {
      append: vi
        .fn<
          (entry: Omit<EventLogEntry, "event_id" | "created_at">) => Promise<EventLogEntry>
        >()
        .mockRejectedValueOnce(new Error("warning event append failed"))
        .mockImplementation(async (entry) => createEventLogEntry(entry)),
      queryByEntity: vi.fn(async () => [])
    };
    const service = new GardenBacklogTelemetryService({
      scheduler,
      eventLogRepo,
      thresholds: {
        warning_queue_depth: 10,
        warning_rearm_depth: 7,
        snapshot_interval_ms: 1_000
      }
    });

    await expect(service.capture()).resolves.toBeUndefined();
    expect(pendingTransition).not.toBeNull();

    const stopPromise = service.stop();
    await advanceTimersByTimeAndFlush(1);
    await expect(stopPromise).resolves.toBe("drained");

    expect(scheduler.acknowledgeBacklogWarningTransition).toHaveBeenCalledWith(1);
    expect(pendingTransition).toBeNull();
    expect(eventLogRepo.append.mock.calls.map(([entry]) => entry.event_type)).toEqual([
      PhaseCExtensionEventType.GARDEN_BACKLOG_WARNING,
      PhaseCExtensionEventType.GARDEN_BACKLOG_WARNING
    ]);
  });

  it("retries a stop-start boundary transition when the first shutdown append fails", async () => {
    const warningTransitions = [
      {
        transition_id: 1,
        transition: "arm" as const,
        snapshot: createSnapshot({
          observed_at: "2026-04-23T08:05:00.000Z",
          queue_depth_total: 12,
          warning_active: true
        })
      },
      {
        transition_id: 2,
        transition: "clear" as const,
        snapshot: createSnapshot({
          observed_at: "2026-04-23T08:06:00.000Z",
          queue_depth_total: 0,
          warning_active: false
        })
      }
    ];
    const scheduler = {
      getBacklogSnapshot: vi.fn(() => warningTransitions[0]?.snapshot ?? createSnapshot()),
      peekBacklogWarningTransition: vi.fn(() => warningTransitions[0] ?? null),
      peekLastBacklogWarningTransitionId: vi.fn(
        () => warningTransitions[warningTransitions.length - 1]?.transition_id ?? null
      ),
      acknowledgeBacklogWarningTransition: vi.fn((transitionId: number) => {
        if (warningTransitions[0]?.transition_id !== transitionId) {
          return false;
        }

        warningTransitions.shift();
        return true;
      })
    };
    const eventLogRepo = {
      append: vi
        .fn<
          (entry: Omit<EventLogEntry, "event_id" | "created_at">) => Promise<EventLogEntry>
        >()
        .mockRejectedValueOnce(new Error("warning event append failed during stop"))
        .mockImplementation(async (entry) => createEventLogEntry(entry)),
      queryByEntity: vi.fn(async () => [])
    };
    const healthJournal = {
      record: vi.fn(async (_entry: HealthJournalRecordInput) => undefined)
    };
    const service = new GardenBacklogTelemetryService({
      scheduler,
      eventLogRepo,
      healthJournal,
      thresholds: {
        warning_queue_depth: 10,
        warning_rearm_depth: 7,
        snapshot_interval_ms: 1_000
      }
    });

    const stopPromise = service.stop();
    await advanceTimersByTimeAndFlush(1);
    await expect(stopPromise).resolves.toBe("drained");

    expect(scheduler.acknowledgeBacklogWarningTransition).toHaveBeenNthCalledWith(1, 1);
    expect(scheduler.acknowledgeBacklogWarningTransition).toHaveBeenNthCalledWith(2, 2);
    expect(scheduler.acknowledgeBacklogWarningTransition).toHaveBeenCalledTimes(2);
    expect(warningTransitions).toEqual([]);
    expect(
      eventLogRepo.append.mock.calls.map(
        ([entry]) => (entry.payload_json as { readonly transition: string }).transition
      )
    ).toEqual(["arm", "arm", "clear"]);
    expect(healthJournal.record).toHaveBeenCalledTimes(2);
  });

  it("drains queued backlog warning transitions in order during a single capture pass", async () => {
    const warningTransitions = [
      {
        transition_id: 1,
        transition: "arm" as const,
        snapshot: createSnapshot({
          observed_at: "2026-04-23T08:05:00.000Z",
          queue_depth_total: 12,
          warning_active: true
        })
      },
      {
        transition_id: 2,
        transition: "clear" as const,
        snapshot: createSnapshot({
          observed_at: "2026-04-23T08:06:00.000Z",
          queue_depth_total: 0,
          warning_active: false
        })
      }
    ];
    const scheduler = {
      getBacklogSnapshot: vi.fn(() => warningTransitions[0]?.snapshot ?? createSnapshot()),
      peekBacklogWarningTransition: vi.fn(() => warningTransitions[0] ?? null),
      peekLastBacklogWarningTransitionId: vi.fn(
        () => warningTransitions[warningTransitions.length - 1]?.transition_id ?? null
      ),
      acknowledgeBacklogWarningTransition: vi.fn((transitionId: number) => {
        if (warningTransitions[0]?.transition_id !== transitionId) {
          return false;
        }

        warningTransitions.shift();
        return true;
      })
    };
    const eventLogRepo = {
      append: vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at">) =>
        createEventLogEntry(entry)
      ),
      queryByEntity: vi.fn(async () => [])
    };
    const healthJournal = {
      record: vi.fn(async (_entry: HealthJournalRecordInput) => undefined)
    };
    const service = new GardenBacklogTelemetryService({
      scheduler,
      eventLogRepo,
      healthJournal,
      thresholds: {
        warning_queue_depth: 10,
        warning_rearm_depth: 7,
        snapshot_interval_ms: 1_000
      }
    });

    await expect(service.capture()).resolves.toBeUndefined();

    expect(eventLogRepo.append).toHaveBeenCalledTimes(2);
    expect(eventLogRepo.append.mock.calls.map(([entry]) => entry.event_type)).toEqual([
      PhaseCExtensionEventType.GARDEN_BACKLOG_WARNING,
      PhaseCExtensionEventType.GARDEN_BACKLOG_WARNING
    ]);
    expect(
      eventLogRepo.append.mock.calls.map(
        ([entry]) => (entry.payload_json as { readonly transition: string }).transition
      )
    ).toEqual(["arm", "clear"]);
    expect(scheduler.acknowledgeBacklogWarningTransition).toHaveBeenNthCalledWith(1, 1);
    expect(scheduler.acknowledgeBacklogWarningTransition).toHaveBeenNthCalledWith(2, 2);
    expect(healthJournal.record).toHaveBeenCalledTimes(2);
    expect(warningTransitions).toEqual([]);
  });

  it("drains pre-stop warning transitions before hanging pending snapshots during shutdown", async () => {
    const warningTransitions = [
      {
        transition_id: 1,
        transition: "arm" as const,
        snapshot: createSnapshot({
          observed_at: "2026-04-23T08:05:00.000Z",
          queue_depth_total: 12,
          warning_active: true
        })
      }
    ];
    const scheduler = {
      getBacklogSnapshot: vi.fn(() => warningTransitions[0]?.snapshot ?? createSnapshot()),
      peekBacklogWarningTransition: vi.fn(() => warningTransitions[0] ?? null),
      peekLastBacklogWarningTransitionId: vi.fn(
        () => warningTransitions[warningTransitions.length - 1]?.transition_id ?? null
      ),
      acknowledgeBacklogWarningTransition: vi.fn((transitionId: number) => {
        if (warningTransitions[0]?.transition_id !== transitionId) {
          return false;
        }

        warningTransitions.shift();
        return true;
      })
    };
    const eventLogRepo = {
      append: vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at">) => {
        if (entry.event_type === PhaseCExtensionEventType.GARDEN_BACKLOG_TELEMETRY_SNAPSHOT) {
          return await new Promise<EventLogEntry>(() => undefined);
        }

        return createEventLogEntry(entry);
      }),
      queryByEntity: vi.fn(async () => [])
    };
    const healthJournal = {
      record: vi.fn(async (_entry: HealthJournalRecordInput) => undefined)
    };
    const service = new GardenBacklogTelemetryService({
      scheduler,
      eventLogRepo,
      healthJournal,
      thresholds: {
        warning_queue_depth: 10,
        warning_rearm_depth: 7,
        snapshot_interval_ms: 1_000
      },
      stopTimeoutMs: 25
    });
    const internals = service as unknown as {
      snapshotRequestedVersion: number;
    };
    internals.snapshotRequestedVersion = 1;

    const stopPromise = service.stop();
    await advanceTimersByTimeAndFlush(25);
    await expect(stopPromise).resolves.toBe("timed_out");

    expect(scheduler.acknowledgeBacklogWarningTransition).toHaveBeenCalledWith(1);
    expect(healthJournal.record).toHaveBeenCalledTimes(1);
    expect(warningTransitions).toEqual([]);
    expect(eventLogRepo.append.mock.calls.map(([entry]) => entry.event_type)).toEqual([
      PhaseCExtensionEventType.GARDEN_BACKLOG_WARNING,
      PhaseCExtensionEventType.GARDEN_BACKLOG_TELEMETRY_SNAPSHOT
    ]);
  });

  it("drains a warning transition before a live interval-started snapshot publish can hang shutdown", async () => {
    const warningSnapshot = createSnapshot({
      observed_at: "2026-04-23T08:05:00.000Z",
      queue_depth_total: 12,
      warning_active: true
    });
    const snapshotStarted = createDeferred<void>();
    let pendingTransition: {
      readonly transition_id: number;
      readonly transition: "arm" | "clear";
      readonly snapshot: GardenBacklogSnapshot;
    } | null = {
      transition_id: 1,
      transition: "arm",
      snapshot: warningSnapshot
    };
    const scheduler = {
      getBacklogSnapshot: vi.fn(() => warningSnapshot),
      peekBacklogWarningTransition: vi.fn(() => pendingTransition),
      peekLastBacklogWarningTransitionId: vi.fn(() => pendingTransition?.transition_id ?? null),
      acknowledgeBacklogWarningTransition: vi.fn((transitionId: number) => {
        if (pendingTransition?.transition_id !== transitionId) {
          return false;
        }

        pendingTransition = null;
        return true;
      })
    };
    const eventLogRepo = {
      append: vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at">) => {
        if (entry.event_type === PhaseCExtensionEventType.GARDEN_BACKLOG_TELEMETRY_SNAPSHOT) {
          snapshotStarted.resolve();
          return await new Promise<EventLogEntry>(() => undefined);
        }

        return createEventLogEntry(entry);
      }),
      queryByEntity: vi.fn(async () => [])
    };
    const healthJournal = {
      record: vi.fn(async (_entry: HealthJournalRecordInput) => undefined)
    };
    const service = new GardenBacklogTelemetryService({
      scheduler,
      eventLogRepo,
      healthJournal,
      thresholds: {
        warning_queue_depth: 10,
        warning_rearm_depth: 7,
        snapshot_interval_ms: 1_000
      },
      stopTimeoutMs: 25
    });

    service.start();
    await advanceTimersByTimeAndFlush(1_001);
    await snapshotStarted.promise;

    const stopPromise = service.stop();
    await advanceTimersByTimeAndFlush(25);
    await expect(stopPromise).resolves.toBe("timed_out");

    expect(scheduler.acknowledgeBacklogWarningTransition).toHaveBeenCalledWith(1);
    expect(healthJournal.record).toHaveBeenCalledTimes(1);
    expect(pendingTransition).toBeNull();
    expect(eventLogRepo.append.mock.calls.map(([entry]) => entry.event_type)).toEqual([
      PhaseCExtensionEventType.GARDEN_BACKLOG_WARNING,
      PhaseCExtensionEventType.GARDEN_BACKLOG_TELEMETRY_SNAPSHOT
    ]);
  });

  it("drains all warning transitions that were already queued when stop begins", async () => {
    const warningTransitions = [
      {
        transition_id: 1,
        transition: "arm" as const,
        snapshot: createSnapshot({
          observed_at: "2026-04-23T08:05:00.000Z",
          queue_depth_total: 12,
          warning_active: true
        })
      },
      {
        transition_id: 2,
        transition: "clear" as const,
        snapshot: createSnapshot({
          observed_at: "2026-04-23T08:06:00.000Z",
          queue_depth_total: 0,
          warning_active: false
        })
      }
    ];
    const postStopTransition = {
      transition_id: 3,
      transition: "arm" as const,
      snapshot: createSnapshot({
        observed_at: "2026-04-23T08:07:00.000Z",
        queue_depth_total: 11,
        warning_active: true
      })
    };
    let appendCount = 0;
    const scheduler = {
      getBacklogSnapshot: vi.fn(() => warningTransitions[0]?.snapshot ?? createSnapshot()),
      peekBacklogWarningTransition: vi.fn(() => warningTransitions[0] ?? null),
      peekLastBacklogWarningTransitionId: vi.fn(
        () => warningTransitions[warningTransitions.length - 1]?.transition_id ?? null
      ),
      acknowledgeBacklogWarningTransition: vi.fn((transitionId: number) => {
        if (warningTransitions[0]?.transition_id !== transitionId) {
          return false;
        }

        warningTransitions.shift();
        return true;
      })
    };
    const eventLogRepo = {
      append: vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at">) => {
        appendCount += 1;
        if (appendCount === 1) {
          warningTransitions.push(postStopTransition);
        }
        return createEventLogEntry(entry);
      }),
      queryByEntity: vi.fn(async () => [])
    };
    const healthJournal = {
      record: vi.fn(async (_entry: HealthJournalRecordInput) => undefined)
    };
    const service = new GardenBacklogTelemetryService({
      scheduler,
      eventLogRepo,
      healthJournal,
      thresholds: {
        warning_queue_depth: 10,
        warning_rearm_depth: 7,
        snapshot_interval_ms: 1_000
      }
    });

    await expect(service.stop()).resolves.toBe("drained");

    expect(scheduler.acknowledgeBacklogWarningTransition).toHaveBeenNthCalledWith(1, 1);
    expect(scheduler.acknowledgeBacklogWarningTransition).toHaveBeenNthCalledWith(2, 2);
    expect(scheduler.acknowledgeBacklogWarningTransition).toHaveBeenCalledTimes(2);
    expect(warningTransitions).toEqual([postStopTransition]);
    expect(
      eventLogRepo.append.mock.calls.map(
        ([entry]) => (entry.payload_json as { readonly transition: string }).transition
      )
    ).toEqual(["arm", "clear"]);
  });

  it("does not accept new captures after stop begins and still drains accepted work", async () => {
    const warningSnapshot = createSnapshot({
      observed_at: "2026-04-23T08:05:00.000Z",
      queue_depth_total: 12,
      warning_active: true
    });
    const appendStarted = createDeferred<void>();
    const deferredAppend = createDeferred<EventLogEntry>();
    const acceptedTransition = {
      transition_id: 1,
      transition: "arm" as const,
      snapshot: warningSnapshot
    };
    const skippedTransition = {
      transition_id: 2,
      transition: "clear" as const,
      snapshot: createSnapshot({
        observed_at: "2026-04-23T08:06:00.000Z",
        queue_depth_total: 0,
        warning_active: false
      })
    };
    let pendingTransition:
      | {
          readonly transition_id: number;
          readonly transition: "arm" | "clear";
          readonly snapshot: GardenBacklogSnapshot;
        }
      | null = acceptedTransition;
    const scheduler = {
      getBacklogSnapshot: vi.fn(() => warningSnapshot),
      peekBacklogWarningTransition: vi.fn(() => pendingTransition),
      peekLastBacklogWarningTransitionId: vi.fn(() => pendingTransition?.transition_id ?? null),
      acknowledgeBacklogWarningTransition: vi.fn((transitionId: number) => {
        if (pendingTransition?.transition_id !== transitionId) {
          return false;
        }

        pendingTransition = null;
        return true;
      })
    };
    const eventLogRepo = {
      append: vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at">) => {
        appendStarted.resolve();
        return await deferredAppend.promise.then(() => createEventLogEntry(entry));
      }),
      queryByEntity: vi.fn(async () => [])
    };
    const healthJournal = {
      record: vi.fn(async (_entry: HealthJournalRecordInput) => undefined)
    };
    const service = new GardenBacklogTelemetryService({
      scheduler,
      eventLogRepo,
      healthJournal,
      thresholds: {
        warning_queue_depth: 10,
        warning_rearm_depth: 7,
        snapshot_interval_ms: 1_000
      }
    });

    const acceptedCapture = service.capture();
    await appendStarted.promise;
    expect(eventLogRepo.append).toHaveBeenCalledTimes(1);

    const stopPromise = service.stop();
    pendingTransition = skippedTransition;

    await expect(service.capture()).resolves.toBeUndefined();
    expect(eventLogRepo.append).toHaveBeenCalledTimes(1);

    deferredAppend.resolve(createEventLogEntry({
      event_type: PhaseCExtensionEventType.GARDEN_BACKLOG_WARNING,
      entity_type: "garden_backlog",
      entity_id: "global",
      workspace_id: "system",
      run_id: null,
      caused_by: "system",
      revision: 1,
      payload_json: {}
    }));

    await expect(acceptedCapture).resolves.toBeUndefined();
    await expect(stopPromise).resolves.toBe("drained");

    expect(scheduler.acknowledgeBacklogWarningTransition).toHaveBeenCalledTimes(1);
    expect(scheduler.acknowledgeBacklogWarningTransition).toHaveBeenCalledWith(1);
    expect(pendingTransition).toEqual(skippedTransition);
  });

  it("coalesces repeated captures behind one in-flight publish and times out stop", async () => {
    const appendStarted = createDeferred<void>();
    const scheduler = {
      getBacklogSnapshot: vi.fn(() => createSnapshot({
        observed_at: "2026-04-23T08:05:00.000Z",
        queue_depth_total: 12,
        warning_active: true
      })),
      peekBacklogWarningTransition: vi.fn(() => ({
        transition_id: 1,
        transition: "arm" as const,
        snapshot: createSnapshot({
          observed_at: "2026-04-23T08:05:00.000Z",
          queue_depth_total: 12,
          warning_active: true
        })
      })),
      peekLastBacklogWarningTransitionId: vi.fn(() => 1),
      acknowledgeBacklogWarningTransition: vi.fn(() => true)
    };
    const eventLogRepo = {
      append: vi.fn(async (_entry: Omit<EventLogEntry, "event_id" | "created_at">) => {
        appendStarted.resolve();
        return await new Promise<EventLogEntry>(() => undefined);
      }),
      queryByEntity: vi.fn(async () => [])
    };
    const service = new GardenBacklogTelemetryService({
      scheduler,
      eventLogRepo,
      thresholds: {
        warning_queue_depth: 10,
        warning_rearm_depth: 7,
        snapshot_interval_ms: 1_000
      },
      stopTimeoutMs: 25
    });

    void service.capture();
    void service.capture();
    void service.capture();
    await appendStarted.promise;

    expect(eventLogRepo.append).toHaveBeenCalledTimes(1);

    const stopPromise = service.stop();
    await advanceTimersByTimeAndFlush(25);

    await expect(stopPromise).resolves.toBe("timed_out");
    expect(eventLogRepo.append).toHaveBeenCalledTimes(1);
    expect(scheduler.acknowledgeBacklogWarningTransition).not.toHaveBeenCalled();
  });

  it("marks a timed-out shutdown terminal and fences stale warning completions", async () => {
    const firstAppendStarted = createDeferred<void>();
    const releaseFirstWarningAppend = createDeferred<EventLogEntry>();
    const warningTransitions: Array<{
      readonly transition_id: number;
      readonly transition: "arm" | "clear";
      readonly snapshot: GardenBacklogSnapshot;
    }> = [
      {
        transition_id: 1,
        transition: "arm" as const,
        snapshot: createSnapshot({
          observed_at: "2026-04-23T08:05:00.000Z",
          queue_depth_total: 12,
          warning_active: true
        })
      }
    ];
    let hangFirstWarningAppend = true;
    const scheduler = {
      getBacklogSnapshot: vi.fn(() => warningTransitions[0]?.snapshot ?? createSnapshot()),
      peekBacklogWarningTransition: vi.fn(() => warningTransitions[0] ?? null),
      peekLastBacklogWarningTransitionId: vi.fn(
        () => warningTransitions[warningTransitions.length - 1]?.transition_id ?? null
      ),
      acknowledgeBacklogWarningTransition: vi.fn((transitionId: number) => {
        if (warningTransitions[0]?.transition_id !== transitionId) {
          return false;
        }

        warningTransitions.shift();
        return true;
      })
    };
    const eventLogRepo = {
      append: vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at">) => {
        if (
          hangFirstWarningAppend &&
          entry.event_type === PhaseCExtensionEventType.GARDEN_BACKLOG_WARNING
        ) {
          hangFirstWarningAppend = false;
          firstAppendStarted.resolve();
          return await releaseFirstWarningAppend.promise;
        }

        return createEventLogEntry(entry);
      }),
      queryByEntity: vi.fn(async () => [])
    };
    const healthJournal = {
      record: vi.fn(async (_entry: HealthJournalRecordInput) => undefined)
    };
    const service = new GardenBacklogTelemetryService({
      scheduler,
      eventLogRepo,
      healthJournal,
      thresholds: {
        warning_queue_depth: 10,
        warning_rearm_depth: 7,
        snapshot_interval_ms: 1_000
      },
      stopTimeoutMs: 25
    });

    void service.capture();
    await firstAppendStarted.promise;

    const stopPromise = service.stop();
    await advanceTimersByTimeAndFlush(25);
    await expect(stopPromise).resolves.toBe("timed_out");

    expect(warningTransitions.map((transition) => transition.transition_id)).toEqual([1]);
    expect(() => service.start()).toThrow(
      "garden backlog telemetry service cannot restart after a timed-out stop"
    );

    releaseFirstWarningAppend.resolve(
      createEventLogEntry({
        event_type: PhaseCExtensionEventType.GARDEN_BACKLOG_WARNING,
        entity_type: "garden_backlog",
        entity_id: "global",
        workspace_id: "system",
        run_id: null,
        caused_by: "system",
        revision: 1,
        payload_json: {
          ...warningTransitions[0]!.snapshot,
          workspace_id: "system",
          run_id: null,
          warning_queue_depth: 10,
          warning_rearm_depth: 7,
          transition: "arm"
        }
      })
    );
    await Promise.resolve();

    expect(scheduler.acknowledgeBacklogWarningTransition).not.toHaveBeenCalled();
    expect((service as unknown as { captureRunner: unknown }).captureRunner).toBeNull();
    expect(warningTransitions.map((transition) => transition.transition_id)).toEqual([1]);
    expect(eventLogRepo.append).toHaveBeenCalledTimes(1);
  });

  it("does not keep shutdown open for a warning broadcast already in flight", async () => {
    const warningSnapshot = createSnapshot({
      observed_at: "2026-04-23T08:05:00.000Z",
      queue_depth_total: 12,
      warning_active: true
    });
    const broadcastStarted = createDeferred<void>();
    const releaseBroadcast = createDeferred<void>();
    let pendingTransition: {
      readonly transition_id: number;
      readonly transition: "arm" | "clear";
      readonly snapshot: GardenBacklogSnapshot;
    } | null = {
      transition_id: 1,
      transition: "arm",
      snapshot: warningSnapshot
    };
    const scheduler = {
      getBacklogSnapshot: vi.fn(() => warningSnapshot),
      peekBacklogWarningTransition: vi.fn(() => pendingTransition),
      peekLastBacklogWarningTransitionId: vi.fn(() => pendingTransition?.transition_id ?? null),
      acknowledgeBacklogWarningTransition: vi.fn((transitionId: number) => {
        if (pendingTransition?.transition_id !== transitionId) {
          return false;
        }

        pendingTransition = null;
        return true;
      })
    };
    const eventLogRepo = {
      append: vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at">) =>
        createEventLogEntry(entry)
      ),
      queryByEntity: vi.fn(async () => [])
    };
    const sseBroadcaster = {
      broadcastEntry: vi.fn(async (_entry: EventLogEntry) => {
        broadcastStarted.resolve();
        await releaseBroadcast.promise;
      })
    };
    const healthJournal = {
      record: vi.fn(async (_entry: HealthJournalRecordInput) => undefined)
    };
    const service = new GardenBacklogTelemetryService({
      scheduler,
      eventLogRepo,
      sseBroadcaster,
      healthJournal,
      thresholds: {
        warning_queue_depth: 10,
        warning_rearm_depth: 7,
        snapshot_interval_ms: 1_000
      },
      stopTimeoutMs: 25
    });

    await expect(service.capture()).resolves.toBeUndefined();
    await broadcastStarted.promise;

    await expect(service.stop()).resolves.toBe("drained");

    releaseBroadcast.resolve();
    await Promise.resolve();

    expect(scheduler.acknowledgeBacklogWarningTransition).toHaveBeenCalledWith(1);
    expect(pendingTransition).toBeNull();
  });

  it("does not keep shutdown open for a warning journal write already in flight", async () => {
    const warningSnapshot = createSnapshot({
      observed_at: "2026-04-23T08:05:00.000Z",
      queue_depth_total: 12,
      warning_active: true
    });
    const journalStarted = createDeferred<void>();
    const releaseJournal = createDeferred<void>();
    let pendingTransition: {
      readonly transition_id: number;
      readonly transition: "arm" | "clear";
      readonly snapshot: GardenBacklogSnapshot;
    } | null = {
      transition_id: 1,
      transition: "arm",
      snapshot: warningSnapshot
    };
    const scheduler = {
      getBacklogSnapshot: vi.fn(() => warningSnapshot),
      peekBacklogWarningTransition: vi.fn(() => pendingTransition),
      peekLastBacklogWarningTransitionId: vi.fn(() => pendingTransition?.transition_id ?? null),
      acknowledgeBacklogWarningTransition: vi.fn((transitionId: number) => {
        if (pendingTransition?.transition_id !== transitionId) {
          return false;
        }

        pendingTransition = null;
        return true;
      })
    };
    const eventLogRepo = {
      append: vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at">) =>
        createEventLogEntry(entry)
      ),
      queryByEntity: vi.fn(async () => [])
    };
    const sseBroadcaster = {
      broadcastEntry: vi.fn(async (_entry: EventLogEntry) => undefined)
    };
    const healthJournal = {
      record: vi.fn(async (_entry: HealthJournalRecordInput) => {
        journalStarted.resolve();
        await releaseJournal.promise;
      })
    };
    const service = new GardenBacklogTelemetryService({
      scheduler,
      eventLogRepo,
      sseBroadcaster,
      healthJournal,
      thresholds: {
        warning_queue_depth: 10,
        warning_rearm_depth: 7,
        snapshot_interval_ms: 1_000
      },
      stopTimeoutMs: 25
    });

    await expect(service.capture()).resolves.toBeUndefined();
    await journalStarted.promise;

    await expect(service.stop()).resolves.toBe("drained");

    releaseJournal.resolve();
    await Promise.resolve();

    expect(scheduler.acknowledgeBacklogWarningTransition).toHaveBeenCalledWith(1);
    expect(pendingTransition).toBeNull();
  });

  it("stops retrying failed stop-boundary publishes after shutdown times out", async () => {
    const warningTransitions = [
      {
        transition_id: 1,
        transition: "arm" as const,
        snapshot: createSnapshot({
          observed_at: "2026-04-23T08:05:00.000Z",
          queue_depth_total: 12,
          warning_active: true
        })
      }
    ];
    const scheduler = {
      getBacklogSnapshot: vi.fn(() => warningTransitions[0]?.snapshot ?? createSnapshot()),
      peekBacklogWarningTransition: vi.fn(() => warningTransitions[0] ?? null),
      peekLastBacklogWarningTransitionId: vi.fn(
        () => warningTransitions[warningTransitions.length - 1]?.transition_id ?? null
      ),
      acknowledgeBacklogWarningTransition: vi.fn(() => false)
    };
    const eventLogRepo = {
      append: vi.fn(async (_entry: Omit<EventLogEntry, "event_id" | "created_at">) => {
        throw new Error("warning event append failed during stop");
      }),
      queryByEntity: vi.fn(async () => [])
    };
    const service = new GardenBacklogTelemetryService({
      scheduler,
      eventLogRepo,
      thresholds: {
        warning_queue_depth: 10,
        warning_rearm_depth: 7,
        snapshot_interval_ms: 1_000
      },
      stopTimeoutMs: 25
    });

    const stopPromise = service.stop();
    await advanceTimersByTimeAndFlush(25);
    await expect(stopPromise).resolves.toBe("timed_out");

    const appendCallsAtTimeout = eventLogRepo.append.mock.calls.length;
    expect(appendCallsAtTimeout).toBeGreaterThan(1);

    await advanceTimersByTimeAndFlush(100);
    expect(eventLogRepo.append).toHaveBeenCalledTimes(appendCallsAtTimeout);
    expect((service as unknown as { captureRunner: unknown }).captureRunner).toBeNull();
  });

  it("preserves the first-stop drain boundary across repeated stop calls", async () => {
    const warningTransitions: Array<{
      readonly transition_id: number;
      readonly transition: "arm" | "clear";
      readonly snapshot: GardenBacklogSnapshot;
    }> = [
      {
        transition_id: 1,
        transition: "arm",
        snapshot: createSnapshot({
          observed_at: "2026-04-23T08:05:00.000Z",
          queue_depth_total: 12,
          warning_active: true
        })
      }
    ];
    const scheduler = {
      getBacklogSnapshot: vi.fn(() => warningTransitions[0]?.snapshot ?? createSnapshot()),
      peekBacklogWarningTransition: vi.fn(() => warningTransitions[0] ?? null),
      peekLastBacklogWarningTransitionId: vi.fn(
        () => warningTransitions[warningTransitions.length - 1]?.transition_id ?? null
      ),
      acknowledgeBacklogWarningTransition: vi.fn((transitionId: number) => {
        if (warningTransitions[0]?.transition_id !== transitionId) {
          return false;
        }

        warningTransitions.shift();
        return true;
      })
    };
    const eventLogRepo = {
      append: vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at">) =>
        createEventLogEntry(entry)
      ),
      queryByEntity: vi.fn(async () => [])
    };
    const healthJournal = {
      record: vi.fn(async (_entry: HealthJournalRecordInput) => undefined)
    };
    const service = new GardenBacklogTelemetryService({
      scheduler,
      eventLogRepo,
      healthJournal,
      thresholds: {
        warning_queue_depth: 10,
        warning_rearm_depth: 7,
        snapshot_interval_ms: 1_000
      }
    });

    await expect(service.stop()).resolves.toBe("drained");
    expect(scheduler.acknowledgeBacklogWarningTransition).toHaveBeenCalledTimes(1);
    expect(warningTransitions).toEqual([]);

    warningTransitions.push({
      transition_id: 2,
      transition: "clear",
      snapshot: createSnapshot({
        observed_at: "2026-04-23T08:06:00.000Z",
        queue_depth_total: 0,
        warning_active: false
      })
    });

    await expect(service.stop()).resolves.toBe("drained");

    expect(scheduler.acknowledgeBacklogWarningTransition).toHaveBeenCalledTimes(1);
    expect(warningTransitions.map((transition) => transition.transition_id)).toEqual([2]);
    expect(
      eventLogRepo.append.mock.calls.map(
        ([entry]) => (entry.payload_json as { readonly transition: string }).transition
      )
    ).toEqual(["arm"]);
  });
});

function createHarness(options: {
  readonly snapshot?: GardenBacklogSnapshot;
  readonly transition?: {
    readonly transition_id: number;
    readonly transition: "arm" | "clear";
    readonly snapshot: GardenBacklogSnapshot;
  } | null;
} = {}) {
  const snapshot = options.snapshot ?? createSnapshot();
  let pendingTransition = options.transition ?? null;
  const scheduler = {
    getBacklogSnapshot: vi.fn(() => snapshot),
    peekBacklogWarningTransition: vi.fn(() => pendingTransition),
    peekLastBacklogWarningTransitionId: vi.fn(() => pendingTransition?.transition_id ?? null),
    acknowledgeBacklogWarningTransition: vi.fn((transitionId: number) => {
      if (pendingTransition?.transition_id !== transitionId) {
        return false;
      }

      pendingTransition = null;
      return true;
    })
  };
  const eventLogRepo = {
    append: vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at">) =>
      createEventLogEntry(entry)
    ),
    queryByEntity: vi.fn(async () => [])
  };
  const healthJournal = {
    record: vi.fn(async (_entry: HealthJournalRecordInput) => undefined)
  };
  const service = new GardenBacklogTelemetryService({
    scheduler,
    eventLogRepo,
    healthJournal,
    thresholds: {
      warning_queue_depth: 10,
      warning_rearm_depth: 7,
      snapshot_interval_ms: 1_000
    }
  });

  return {
    scheduler,
    eventLogRepo,
    healthJournal,
    service
  };
}

function createSnapshot(
  overrides: Partial<GardenBacklogSnapshot> = {}
): GardenBacklogSnapshot {
  return {
    workspace_id: null,
    observed_at: "2026-04-23T08:00:00.000Z",
    queue_depth_total: 4,
    queue_depth_by_tier: {
      tier_0: 1,
      tier_1: 1,
      tier_2: 2
    },
    in_flight_total: 0,
    warning_active: false,
    ...overrides
  };
}

function createEventLogEntry(event: Omit<EventLogEntry, "event_id" | "created_at">): EventLogEntry {
  return {
    event_id: `event:${event.entity_type}:${event.entity_id}:${event.revision}`,
    created_at: "2026-04-23T08:00:00.000Z",
    ...event
  };
}

async function advanceTimersByTimeAndFlush(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return { promise, resolve, reject };
}
