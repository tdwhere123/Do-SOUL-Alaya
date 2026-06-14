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
});
