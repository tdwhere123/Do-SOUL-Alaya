import { describe, expect, it, vi } from "vitest";
import { BackgroundServiceManager } from "../../background/bootstrap.js";

describe("BackgroundServiceManager", () => {
  it("starts idempotently and drains in-flight tasks on stop", async () => {
    vi.useFakeTimers();
    const task = vi.fn(async () => undefined);
    const logger = { warn: vi.fn() };
    const manager = new BackgroundServiceManager([
      {
        name: "test-service",
        intervalMs: 100,
        task
      }
    ], { logger });

    manager.start();
    manager.start();
    await vi.advanceTimersByTimeAsync(100);
    await manager.stop({ timeoutMs: null });

    expect(task).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("clears the stop timeout when in-flight tasks drain first", async () => {
    vi.useFakeTimers();
    const task = vi.fn(async () => undefined);
    const logger = { warn: vi.fn() };
    const manager = new BackgroundServiceManager([
      {
        name: "test-service",
        intervalMs: 100,
        task
      }
    ], { logger });

    try {
      manager.start();
      await vi.advanceTimersByTimeAsync(100);

      await manager.stop({ timeoutMs: 10_000 });

      expect(task).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for in-flight tasks after stop timeout instead of abandoning them", async () => {
    vi.useFakeTimers();
    let releaseTask!: () => void;
    const task = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseTask = resolve;
        })
    );
    const logger = { warn: vi.fn() };
    const manager = new BackgroundServiceManager(
      [
        {
          name: "test-service",
          intervalMs: 100,
          task
        }
      ],
      { logger }
    );

    try {
      manager.start();
      await vi.advanceTimersByTimeAsync(100);
      const stopPromise = manager.stop({ timeoutMs: 50 });
      await vi.advanceTimersByTimeAsync(50);
      expect(logger.warn).toHaveBeenCalledWith(
        "background service stop draining timed out; waiting for in-flight tasks",
        { inFlight: 1 }
      );
      releaseTask();
      await stopPromise;
      expect(task).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("routes start, overlap, and task-failure warnings through the injected logger", async () => {
    vi.useFakeTimers();
    let releaseTask!: () => void;
    const task = vi
      .fn()
      .mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => {
          releaseTask = resolve;
        });
      })
      .mockImplementationOnce(async () => {
        throw new Error("token abcd1234");
      });
    const logger = { warn: vi.fn() };
    const manager = new BackgroundServiceManager([
      {
        name: "test-service",
        intervalMs: 100,
        task
      }
    ], { logger });

    manager.start();
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);
    releaseTask();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(100);
    await manager.stop({ timeoutMs: null });

    expect(logger.warn).toHaveBeenCalledWith("background service started", {
      service: "test-service",
      intervalMs: 100
    });
    expect(logger.warn).toHaveBeenCalledWith(
      "background service skipped because previous execution is still running",
      { service: "test-service" }
    );
    expect(logger.warn).toHaveBeenCalledWith("background service task failed", {
      service: "test-service",
      errorName: "Error",
      errorMessageRedacted: true
    });
    const failureMeta = logger.warn.mock.calls.find((call) => call[0] === "background service task failed")?.[1];
    expect(JSON.stringify(failureMeta)).not.toContain("abcd1234");
    vi.useRealTimers();
  });

  it("falls back to the structured warn logger when no logger is injected", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const warn = vi.fn();
    vi.doMock("../../runtime/daemon-runtime-helpers.js", async () => {
      const actual = await vi.importActual<typeof import("../../runtime/daemon-runtime-helpers.js")>(
        "../../runtime/daemon-runtime-helpers.js"
      );
      return {
        ...actual,
        createWarnLogger: () => ({
          trace: vi.fn(),
          debug: vi.fn(),
          info: vi.fn(),
          warn,
          error: vi.fn(),
          fatal: vi.fn()
        })
      };
    });
    const { BackgroundServiceManager: IsolatedBackgroundServiceManager } = await import(
      "../../background/bootstrap.js"
    );
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const manager = new IsolatedBackgroundServiceManager([
      {
        name: "default-logger-service",
        intervalMs: 100,
        task: async () => {
          throw new Error("token abcd1234");
        }
      }
    ]);

    try {
      manager.start();
      await vi.advanceTimersByTimeAsync(100);
      await manager.stop({ timeoutMs: null });

      expect(consoleWarnSpy).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith("background service task failed", {
        service: "default-logger-service",
        errorName: "Error",
        errorMessageRedacted: true
      });
      expect(warn).toHaveBeenCalledWith("background service started", {
        service: "default-logger-service",
        intervalMs: 100
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain("abcd1234");
    } finally {
      consoleWarnSpy.mockRestore();
      vi.doUnmock("../../runtime/daemon-runtime-helpers.js");
      vi.resetModules();
      vi.useRealTimers();
    }
  });
});
