import { afterEach, describe, expect, it, vi } from "vitest";
import { closeDaemonStartupResourcesAfterFailure } from "../../../runtime/startup/cleanup.js";
import * as daemonDatabase from "../../../runtime/startup/database.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("daemon startup cleanup", () => {
  it("closes the recall worker then write-queue before the database and temporal lease", async () => {
    const order: string[] = [];
    const startupError = new Error("garden startup failed");
    vi.spyOn(daemonDatabase, "closeDaemonSqliteWriteQueue").mockImplementation(async () => {
      order.push("write-queue");
    });

    await expect(closeDaemonStartupResourcesAfterFailure({
      recallReadWorkerClient: { close: vi.fn(async () => { order.push("worker"); }) },
      database: { close: vi.fn(() => { order.push("database"); }) },
      temporalRuntimeLease: { release: vi.fn(async () => { order.push("lease"); }) },
      warn: vi.fn(),
      error: startupError
    })).rejects.toBe(startupError);

    expect(order).toEqual(["worker", "write-queue", "database", "lease"]);
  });

  it("continues cleanup and preserves the startup error when cleanup fails", async () => {
    const startupError = new Error("core startup failed");
    const release = vi.fn(async () => undefined);
    const warn = vi.fn();

    await expect(closeDaemonStartupResourcesAfterFailure({
      recallReadWorkerClient: { close: vi.fn(async () => { throw new Error("worker close failed"); }) },
      database: { close: vi.fn(() => { throw new Error("database close failed"); }) },
      temporalRuntimeLease: { release },
      warn,
      error: startupError
    })).rejects.toBe(startupError);

    expect(release).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
