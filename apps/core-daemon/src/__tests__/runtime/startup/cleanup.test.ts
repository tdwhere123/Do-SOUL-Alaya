import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../../scripts/test-support/provider-free/provider-free-boundary.js");
  return installProviderFreeBoundary({ descendantPreload: new URL("../../../../../../scripts/test-support/provider-free/provider-free-cli-bootstrap.mjs", import.meta.url).href });
});
import { closeDaemonStartupResourcesAfterFailure, retryDaemonStartupCleanups } from "../../../runtime/startup/cleanup.js";
import * as daemonDatabase from "../../../runtime/startup/database.js";

afterEach(() => {
  expect(isolation.violations).toEqual([]);
  vi.restoreAllMocks();
});
afterAll(() => isolation.restore());

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

  it("retains the runtime lease when startup database close fails", async () => {
    const startupError = new Error("core startup failed");
    const release = vi.fn(async () => undefined);
    const warn = vi.fn();
    let workerFails = true;
    let databaseFails = true;
    const worker = { close: vi.fn(async () => { if (workerFails) throw new Error("worker close failed"); }) };
    const database = { close: vi.fn(() => { if (databaseFails) throw new Error("database close failed"); }) };

    await expect(closeDaemonStartupResourcesAfterFailure({
      recallReadWorkerClient: worker, database,
      temporalRuntimeLease: { release }, warn, error: startupError
    })).rejects.toThrow("worker close failed");
    expect(release).not.toHaveBeenCalled();
    workerFails = false;
    await expect(retryDaemonStartupCleanups()).rejects.toThrow("database close failed");
    expect(release).not.toHaveBeenCalled();
    databaseFails = false;
    await retryDaemonStartupCleanups();
    expect(worker.close).toHaveBeenCalledTimes(2);
    expect(database.close).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
