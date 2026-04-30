import { describe, expect, it, vi } from "vitest";
import { BackgroundServiceManager } from "../background/bootstrap.js";

describe("BackgroundServiceManager", () => {
  it("starts idempotently and drains in-flight tasks on stop", async () => {
    vi.useFakeTimers();
    const task = vi.fn(async () => undefined);
    const manager = new BackgroundServiceManager([
      {
        name: "test-service",
        intervalMs: 100,
        task
      }
    ]);

    manager.start();
    manager.start();
    await vi.advanceTimersByTimeAsync(100);
    await manager.stop({ timeoutMs: null });

    expect(task).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
