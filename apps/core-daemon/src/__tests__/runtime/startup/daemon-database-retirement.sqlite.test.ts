import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary({
    ownedTemporaryFixtures: true,
    descendantPreload: new URL("../../../../../bench-runner/src/__tests__/support/provider-free-cli-bootstrap.mjs", import.meta.url).href
  });
});
import fs, { mkdtempSync, rmSync } from "node:fs";
import BetterSqlite3 from "better-sqlite3";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSqliteWriteQueuePort, initDatabase, StorageDatabase } from "@do-soul/alaya-storage";
import { createAlayaDaemonRuntime } from "../../../index.js";
import { acquireTemporalRuntimeLease } from "../../../runtime/temporal-cutover/lease.js";
import { closeDaemonSqliteWriteQueue, openDaemonDatabase } from "../../../runtime/startup/database.js";
import { retryDaemonStartupCleanups } from "../../../runtime/startup/cleanup.js";

afterEach(() => {
  expect(isolation.violations).toEqual([]);
  vi.restoreAllMocks();
});
afterAll(() => isolation.restore());

it("retains the actual worker queue after close rejects and retires it on retry", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alaya-queue-retire-"));
  const previous = process.env.ALAYA_SQLITE_WRITE_QUEUE;
  delete process.env.ALAYA_SQLITE_WRITE_QUEUE;
  const database = await openDaemonDatabase(join(directory, "alaya.db"));
  const queue = getSqliteWriteQueuePort();
  expect(queue).not.toBeNull();
  const close = vi.spyOn(queue!, "close").mockRejectedValueOnce(new Error("injected close failure"));
  try {
    await expect(closeDaemonSqliteWriteQueue()).rejects.toThrow("injected close failure");
    expect(getSqliteWriteQueuePort()).toBe(queue);
    await closeDaemonSqliteWriteQueue();
    expect(close).toHaveBeenCalledTimes(2);
    expect(getSqliteWriteQueuePort()).toBeNull();
  } finally {
    close.mockRestore();
    await closeDaemonSqliteWriteQueue();
    database.close();
    if (previous === undefined) delete process.env.ALAYA_SQLITE_WRITE_QUEUE;
    else process.env.ALAYA_SQLITE_WRITE_QUEUE = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

it("retains the lease and native connection when initialization and its close both fail", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alaya-native-open-retire-"));
  const filename = join(directory, "alaya.db");
  const oldConfig = process.env.ALAYA_CONFIG_DIR, oldQueue = process.env.ALAYA_SQLITE_WRITE_QUEUE;
  process.env.ALAYA_CONFIG_DIR = directory;
  process.env.ALAYA_SQLITE_WRITE_QUEUE = "0";
  const originalChmod = fs.chmodSync;
  const chmod = vi.spyOn(fs, "chmodSync").mockImplementation((path, mode) => {
    if (String(path) === filename) throw new Error("injected initialization failure");
    return originalChmod(path, mode);
  });
  const originalClose = BetterSqlite3.prototype.close;
  let failures = 2;
  let native: StorageDatabase["connection"] | undefined;
  const close = vi.spyOn(BetterSqlite3.prototype, "close").mockImplementation(function(this: StorageDatabase["connection"]) {
    if (this.name === filename && failures-- > 0) { native = this; throw new Error("injected native close failure"); }
    return originalClose.call(this);
  });
  try {
    await expect(createAlayaDaemonRuntime()).rejects.toThrow("cleanup remains incomplete");
    expect(native?.open).toBe(true);
    await expect(acquireTemporalRuntimeLease(filename)).rejects.toThrow("must be stopped");
    await retryDaemonStartupCleanups();
    expect(native?.open).toBe(false);
    const successor = await acquireTemporalRuntimeLease(filename);
    await successor.release();
  } finally {
    chmod.mockRestore(); close.mockRestore();
    await retryDaemonStartupCleanups();
    if (oldConfig === undefined) delete process.env.ALAYA_CONFIG_DIR; else process.env.ALAYA_CONFIG_DIR = oldConfig;
    if (oldQueue === undefined) delete process.env.ALAYA_SQLITE_WRITE_QUEUE; else process.env.ALAYA_SQLITE_WRITE_QUEUE = oldQueue;
    rmSync(directory, { recursive: true, force: true });
  }
});

it("retains a failed read-only startup inspection handle and its runtime lease", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alaya-inspection-retire-"));
  const filename = join(directory, "alaya.db");
  initDatabase({ filename }).close();
  const oldConfig = process.env.ALAYA_CONFIG_DIR, oldQueue = process.env.ALAYA_SQLITE_WRITE_QUEUE;
  process.env.ALAYA_CONFIG_DIR = directory; process.env.ALAYA_SQLITE_WRITE_QUEUE = "0";
  const originalClose = BetterSqlite3.prototype.close;
  let failures = 2;
  let native: StorageDatabase["connection"] | undefined;
  const close = vi.spyOn(BetterSqlite3.prototype, "close").mockImplementation(function(this: StorageDatabase["connection"]) {
    if (this.name === filename && this.readonly && failures-- > 0) {
      native = this; throw new Error("injected inspection close failure");
    }
    return originalClose.call(this);
  });
  try {
    await expect(createAlayaDaemonRuntime()).rejects.toThrow("cleanup remains incomplete");
    expect(native?.open).toBe(true);
    await expect(acquireTemporalRuntimeLease(filename)).rejects.toThrow("must be stopped");
    await retryDaemonStartupCleanups();
    expect(native?.open).toBe(false);
    const successor = await acquireTemporalRuntimeLease(filename);
    await successor.release();
  } finally {
    close.mockRestore(); await retryDaemonStartupCleanups();
    if (oldConfig === undefined) delete process.env.ALAYA_CONFIG_DIR; else process.env.ALAYA_CONFIG_DIR = oldConfig;
    if (oldQueue === undefined) delete process.env.ALAYA_SQLITE_WRITE_QUEUE; else process.env.ALAYA_SQLITE_WRITE_QUEUE = oldQueue;
    rmSync(directory, { recursive: true, force: true });
  }
});

it("retains the real runtime lease and database after startup cleanup fails until cleanup succeeds", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alaya-startup-retire-"));
  const oldConfig = process.env.ALAYA_CONFIG_DIR;
  const oldQueue = process.env.ALAYA_SQLITE_WRITE_QUEUE;
  process.env.ALAYA_CONFIG_DIR = directory;
  process.env.ALAYA_SQLITE_WRITE_QUEUE = "0";
  const optimize = vi.spyOn(StorageDatabase.prototype, "optimize").mockImplementationOnce(() => { throw new Error("injected open failure"); });
  const close = vi.spyOn(StorageDatabase.prototype, "close").mockImplementationOnce(() => { throw new Error("injected database close failure"); });
  const filename = join(directory, "alaya.db");
  try {
    await expect(createAlayaDaemonRuntime()).rejects.toThrow("cleanup remains incomplete");
    const database = optimize.mock.instances[0] as StorageDatabase;
    expect(database.isClosed()).toBe(false);
    await expect(acquireTemporalRuntimeLease(filename)).rejects.toThrow("must be stopped");
    await retryDaemonStartupCleanups();
    expect(database.isClosed()).toBe(true);
    const successor = await acquireTemporalRuntimeLease(filename);
    await successor.release();
  } finally {
    optimize.mockRestore();
    close.mockRestore();
    await retryDaemonStartupCleanups();
    if (oldConfig === undefined) delete process.env.ALAYA_CONFIG_DIR;
    else process.env.ALAYA_CONFIG_DIR = oldConfig;
    if (oldQueue === undefined) delete process.env.ALAYA_SQLITE_WRITE_QUEUE;
    else process.env.ALAYA_SQLITE_WRITE_QUEUE = oldQueue;
    rmSync(directory, { recursive: true, force: true });
  }
});
