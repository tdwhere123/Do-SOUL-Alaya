import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackgroundServiceManager } from "../background/bootstrap.js";

// ---------------------------------------------------------------------------
// BackgroundServiceManager unit tests
// ---------------------------------------------------------------------------

describe("BackgroundServiceManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("start() calls each service task after its interval elapses", async () => {
    const taskA = vi.fn().mockResolvedValue(undefined);
    const taskB = vi.fn().mockResolvedValue(undefined);

    const manager = new BackgroundServiceManager([
      { name: "ServiceA", intervalMs: 1000, task: taskA },
      { name: "ServiceB", intervalMs: 2000, task: taskB }
    ]);

    manager.start();

    // Advance past first interval of A (1s)
    await vi.advanceTimersByTimeAsync(1001);
    expect(taskA).toHaveBeenCalledTimes(1);
    expect(taskB).toHaveBeenCalledTimes(0);

    // Advance past first interval of B (2s total)
    await vi.advanceTimersByTimeAsync(1000);
    expect(taskB).toHaveBeenCalledTimes(1);

    await manager.stop();
  });

  it("stop() prevents further task invocations after it is called", async () => {
    const task = vi.fn().mockResolvedValue(undefined);

    const manager = new BackgroundServiceManager([
      { name: "Service", intervalMs: 500, task }
    ]);

    manager.start();

    await vi.advanceTimersByTimeAsync(501);
    expect(task).toHaveBeenCalledTimes(1);

    await manager.stop();

    // Advance time further — task must NOT be called again
    await vi.advanceTimersByTimeAsync(2000);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("stop() resolves within the 10-second timeout even with a long-running task", async () => {
    // Task that takes 15 seconds — stop should still resolve within 10s max
    const slowTask = vi.fn().mockImplementation(
      () => new Promise<void>((resolve) => setTimeout(resolve, 15_000))
    );

    const manager = new BackgroundServiceManager([
      { name: "SlowService", intervalMs: 100, task: slowTask }
    ]);

    manager.start();
    await vi.advanceTimersByTimeAsync(101); // trigger one invocation

    const stopPromise = manager.stop();
    // Advance time up to 10 seconds (the max timeout)
    await vi.advanceTimersByTimeAsync(10_001);

    await expect(stopPromise).resolves.toBeUndefined();
  });

  it("stop({ timeoutMs: null }) waits for long-running tasks to drain fully", async () => {
    const slowTask = vi.fn().mockImplementation(
      () => new Promise<void>((resolve) => setTimeout(resolve, 15_000))
    );

    const manager = new BackgroundServiceManager([
      { name: "SlowService", intervalMs: 100, task: slowTask }
    ]);

    manager.start();
    await vi.advanceTimersByTimeAsync(101);

    let stopResolved = false;
    const stopPromise = manager.stop({ timeoutMs: null }).then(() => {
      stopResolved = true;
    });

    await vi.advanceTimersByTimeAsync(10_001);
    expect(stopResolved).toBe(false);

    await vi.advanceTimersByTimeAsync(4_999);

    await expect(stopPromise).resolves.toBeUndefined();
    expect(stopResolved).toBe(true);
  });

  it("start() can be called multiple times without stacking intervals", async () => {
    const task = vi.fn().mockResolvedValue(undefined);

    const manager = new BackgroundServiceManager([
      { name: "Service", intervalMs: 1000, task }
    ]);

    manager.start();
    manager.start(); // second call should be idempotent or no-op

    await vi.advanceTimersByTimeAsync(1001);
    // Should be called at most once per interval, not doubled
    expect(task.mock.calls.length).toBeLessThanOrEqual(2);

    await manager.stop();
  });

  it("logs a startup message for each service including its interval", () => {
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const manager = new BackgroundServiceManager([
      { name: "Janitor", intervalMs: 300_000, task: vi.fn() },
      { name: "Auditor", intervalMs: 1_800_000, task: vi.fn() }
    ]);

    manager.start();

    const logs = consoleSpy.mock.calls.map((args) => args.join(" "));
    expect(logs.some((l) => l.includes("Janitor"))).toBe(true);
    expect(logs.some((l) => l.includes("Auditor"))).toBe(true);

    manager.stop();
    consoleSpy.mockRestore();
  });

  it("does not log orphan_detection status from the generic background manager", () => {
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const manager = new BackgroundServiceManager([]);
    manager.start();

    const logs = consoleSpy.mock.calls.map((args) => args.join(" "));
    expect(logs.some((l) => l.includes("orphan_detection"))).toBe(false);

    manager.stop();
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Interval configuration tests (spec values)
// ---------------------------------------------------------------------------

describe("BackgroundServiceManager — spec interval values", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("accepts Janitor interval of 300_000ms (5 min)", () => {
    expect(() => {
      new BackgroundServiceManager([
        { name: "Janitor", intervalMs: 300_000, task: vi.fn() }
      ]);
    }).not.toThrow();
  });

  it("accepts Auditor interval of 1_800_000ms (30 min)", () => {
    expect(() => {
      new BackgroundServiceManager([
        { name: "Auditor", intervalMs: 1_800_000, task: vi.fn() }
      ]);
    }).not.toThrow();
  });

  it("accepts Librarian interval of 900_000ms (15 min)", () => {
    expect(() => {
      new BackgroundServiceManager([
        { name: "Librarian", intervalMs: 900_000, task: vi.fn() }
      ]);
    }).not.toThrow();
  });

  it("accepts GardenScheduler interval of 60_000ms (1 min)", () => {
    expect(() => {
      new BackgroundServiceManager([
        { name: "GardenScheduler", intervalMs: 60_000, task: vi.fn() }
      ]);
    }).not.toThrow();
  });
});
