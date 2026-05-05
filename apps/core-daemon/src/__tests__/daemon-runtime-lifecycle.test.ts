import { describe, expect, it, vi } from "vitest";
import {
  createCoreDaemonLifecycleState,
  createDaemonLifecycleControls
} from "../daemon-runtime-lifecycle.js";

describe("daemon lifecycle controls", () => {
  it("starts Garden services once and triggers the startup cleanup pass", () => {
    const gardenBacklogTelemetryService = {
      start: vi.fn(),
      stop: vi.fn(async () => "drained" as const)
    };
    const backgroundManager = {
      start: vi.fn(),
      stop: vi.fn(async () => "drained" as const)
    };
    const runBackgroundPass = vi.fn(async () => undefined);
    const controls = createDaemonLifecycleControls({
      app: {
        fetch: vi.fn()
      } as never,
      lifecycleState: createCoreDaemonLifecycleState(),
      warnLogger: {
        warn: vi.fn()
      },
      gardenBacklogTelemetryService,
      gardenRuntime: {
        backgroundManager,
        setBacklogTelemetryObserver: vi.fn(),
        runBackgroundPass
      },
      securityStatusService: {
        close: vi.fn()
      },
      daemonMcpRuntimeRegistry: {
        close: vi.fn(async () => undefined)
      },
      globalMemoryRecallInvalidationSubscription: null,
      database: {
        close: vi.fn()
      }
    });

    controls.startBackgroundServices();
    controls.startBackgroundServices();

    expect(gardenBacklogTelemetryService.start).toHaveBeenCalledTimes(1);
    expect(backgroundManager.start).toHaveBeenCalledTimes(1);
    expect(runBackgroundPass).toHaveBeenCalledTimes(1);
  });
});
