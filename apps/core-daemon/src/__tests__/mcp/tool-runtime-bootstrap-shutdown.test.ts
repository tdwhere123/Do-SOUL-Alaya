import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ComputeRecallGardenEventType,
  type EventLogEntry,
  type GardenBacklogSnapshot,
  type HealthJournalRecordInput
} from "@do-soul/alaya-protocol";
import {
  createDeferred,
  getToolRuntimeWiringFixture,
  resetToolRuntimeWiringState
} from "./tool-runtime-wiring-fixture.js";
import type { AlayaDaemonRuntime } from "../../runtime/daemon-runtime-types.js";

const hoisted = getToolRuntimeWiringFixture();
const activeRuntimes: Array<AlayaDaemonRuntime> = [];
const isolatedConfigDirs: string[] = [];

describe("daemon tool runtime bootstrap shutdown", () => {
  beforeEach(async () => {
    const configDir = await mkdtemp(path.join(tmpdir(), "alaya-daemon-config-isolated-"));
    isolatedConfigDirs.push(configDir);
    process.env.ALAYA_CONFIG_DIR = configDir;
  });

  afterEach(async () => {
    for (const runtime of activeRuntimes.splice(0)) {
      await runtime.shutdown().catch(() => undefined);
    }
    vi.useRealTimers();
    resetToolRuntimeWiringState();
    delete process.env.ALAYA_INGEST_RECONCILIATION_ENABLED;
    for (const configDir of isolatedConfigDirs.splice(0)) {
      await rm(configDir, { force: true, recursive: true }).catch(() => undefined);
    }
  });

  it(
    "awaits runtime-registry close before closing the daemon server on shutdown",
    async () => {
      const stopGate = createDeferred<void>();
      const closeGate = createDeferred<void>();
      const signalHandlers = new Map<"SIGINT" | "SIGTERM", () => void>();
      const originalOn = process.on.bind(process);
      const processOnSpy = vi.spyOn(process, "on");
      processOnSpy.mockImplementation(((event: string, handler: () => void) => {
        if (event === "SIGINT" || event === "SIGTERM") {
          signalHandlers.set(event, handler);
          return process;
        }
        return originalOn(event as never, handler as never);
      }) as typeof process.on);
      hoisted.backgroundManagerStop.mockImplementationOnce(async () => {
        await stopGate.promise;
      });
      hoisted.mcpRuntimeClose.mockImplementationOnce(async () => {
        await closeGate.promise;
      });

      try {
        await bootStartedDaemonRuntime();
        const backlogTelemetryService = hoisted.gardenBacklogTelemetryServices[0];

        expect(backlogTelemetryService).toMatchObject({ stop: expect.any(Function), start: expect.any(Function) });

        signalHandlers.get("SIGTERM")?.();
        await Promise.resolve();

        expect(hoisted.backgroundManagerStop).toHaveBeenCalledTimes(1);
        expect(hoisted.backgroundManagerStop).toHaveBeenCalledWith({ timeoutMs: 30_000 });
        expect(backlogTelemetryService!.stop).not.toHaveBeenCalled();
        expect(hoisted.mcpRuntimeClose).not.toHaveBeenCalled();
        expect(hoisted.serverClose).not.toHaveBeenCalled();

        stopGate.resolve();

        await vi.waitFor(() => {
          expect(backlogTelemetryService!.stop).toHaveBeenCalledTimes(1);
          expect(hoisted.mcpRuntimeClose).toHaveBeenCalledTimes(1);
        });
        expect(hoisted.serverClose).not.toHaveBeenCalled();

        closeGate.resolve();

        await vi.waitFor(() => {
          expect(hoisted.serverClose).toHaveBeenCalledTimes(1);
        });
      } finally {
        processOnSpy.mockRestore();
      }
    },
    10_000
  );

  it(
    "drains background work before stopping backlog telemetry on shutdown",
    async () => {
      const stopGate = createDeferred<void>();
      const signalHandlers = new Map<"SIGINT" | "SIGTERM", () => void>();
      const originalOn = process.on.bind(process);
      const processOnSpy = vi.spyOn(process, "on");
      processOnSpy.mockImplementation(((event: string, handler: () => void) => {
        if (event === "SIGINT" || event === "SIGTERM") {
          signalHandlers.set(event, handler);
          return process;
        }
        return originalOn(event as never, handler as never);
      }) as typeof process.on);
      hoisted.backgroundManagerStop.mockImplementationOnce(async () => {
        await stopGate.promise;
      });

      try {
        await bootStartedDaemonRuntime();

        const backlogTelemetryService = hoisted.gardenBacklogTelemetryServices[0];
        expect(backlogTelemetryService).toMatchObject({ stop: expect.any(Function), start: expect.any(Function) });

        signalHandlers.get("SIGTERM")?.();
        await Promise.resolve();

        expect(hoisted.backgroundManagerStop).toHaveBeenCalledTimes(1);
        expect(hoisted.backgroundManagerStop).toHaveBeenCalledWith({ timeoutMs: 30_000 });
        expect(backlogTelemetryService!.stop).not.toHaveBeenCalled();

        stopGate.resolve();

        await vi.waitFor(() => {
          expect(backlogTelemetryService!.stop).toHaveBeenCalledTimes(1);
        });
      } finally {
        processOnSpy.mockRestore();
      }
    },
    10_000
  );

  it(
    "keeps shutdown open for backlog telemetry captures emitted after the generic stop timeout window",
    async () => {
      vi.useFakeTimers();
      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const [{ BackgroundServiceManager }, coreActual] = await Promise.all([
        vi.importActual<typeof import("../../background/bootstrap.js")>("../../background/bootstrap.js"),
        vi.importActual<typeof import("@do-soul/alaya-core")>("@do-soul/alaya-core")
      ]);
      const { GardenBacklogTelemetryService } = coreActual;
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
        append: vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) =>
          createEventLogEntry(entry)
        ),
        queryByEntity: vi.fn(async () => [])
      };
      const healthJournal = {
        record: vi.fn(async (_entry: HealthJournalRecordInput) => undefined)
      };
      const telemetryService = new GardenBacklogTelemetryService({
        scheduler,
        eventLogRepo,
        healthJournal,
        thresholds: {
          warning_queue_depth: 10,
          warning_rearm_depth: 7,
          snapshot_interval_ms: 1_000
        }
      });
      let backlogTelemetryObserver: { capture(): Promise<void> } | null = telemetryService;
      const requestBacklogTelemetryCapture = (): void => {
        const observer = backlogTelemetryObserver;
        if (observer === null) {
          return;
        }

        void observer.capture().catch(() => undefined);
      };
      const backgroundManager = new BackgroundServiceManager([
        {
          name: "GardenScheduler",
          intervalMs: 100,
          task: async () => {
            await new Promise<void>((resolve) => setTimeout(resolve, 15_000));
            requestBacklogTelemetryCapture();
          }
        }
      ]);
      const shutdown = async (): Promise<void> => {
        await backgroundManager.stop({ timeoutMs: 30_000 });
        backlogTelemetryObserver = null;
        await telemetryService.stop();
      };

      try {
        backgroundManager.start();
        await vi.advanceTimersByTimeAsync(101);

        let shutdownResolved = false;
        const shutdownPromise = shutdown().then(() => {
          shutdownResolved = true;
        });

        await vi.advanceTimersByTimeAsync(10_001);
        await Promise.resolve();

        expect(shutdownResolved).toBe(false);
        expect(eventLogRepo.append).not.toHaveBeenCalled();
        expect(healthJournal.record).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(4_999);
        await vi.waitFor(() => {
          expect(eventLogRepo.append).toHaveBeenCalledTimes(1);
          expect(healthJournal.record).toHaveBeenCalledTimes(1);
        });

        await expect(shutdownPromise).resolves.toBeUndefined();
        expect(shutdownResolved).toBe(true);
        expect(scheduler.acknowledgeBacklogWarningTransition).toHaveBeenCalledWith(1);
        expect(pendingTransition).toBeNull();
        expect(eventLogRepo.append).toHaveBeenCalledWith(
          expect.objectContaining({
            event_type: ComputeRecallGardenEventType.GARDEN_BACKLOG_WARNING
          })
        );
      } finally {
        consoleSpy.mockRestore();
      }
    },
    20_000
  );
});

function createEventLogEntry(
  entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">
): EventLogEntry {
  return {
    ...entry,
    event_id: crypto.randomUUID(),
    created_at: "2026-04-23T08:05:00.000Z",
    revision: 0
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

async function bootDaemonRuntime(): Promise<AlayaDaemonRuntime> {
  const { createAlayaDaemonRuntime } = await import("../../index.js");
  const runtime = await createAlayaDaemonRuntime();
  activeRuntimes.push(runtime);
  return runtime;
}

async function bootStartedDaemonRuntime(): Promise<AlayaDaemonRuntime> {
  const runtime = await bootDaemonRuntime();
  await runtime.startHttpServer({ port: 0, allowEphemeralRequestToken: true });
  return runtime;
}
