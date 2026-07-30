import { afterEach, describe, expect, it } from "vitest";
import { configureSqliteWriteQueuePort, getSqliteWriteQueuePort } from "../../sqlite/db.js";
import {
  ALAYA_SQLITE_WRITE_QUEUE_ENV,
  installDefaultSqliteWriteQueue,
  isSqliteWriteQueueDisabled
} from "../../sqlite/write-queue/install.js";
import { resolveSqliteWriteQueueWorkerUrl } from "../../sqlite/write-queue/worker-port.js";

describe("installDefaultSqliteWriteQueue", () => {
  afterEach(async () => {
    const port = getSqliteWriteQueuePort();
    configureSqliteWriteQueuePort(null);
    await port?.close?.();
  });

  it("treats ALAYA_SQLITE_WRITE_QUEUE opt-out values as disabled", () => {
    expect(isSqliteWriteQueueDisabled({ [ALAYA_SQLITE_WRITE_QUEUE_ENV]: "0" })).toBe(true);
    expect(isSqliteWriteQueueDisabled({ [ALAYA_SQLITE_WRITE_QUEUE_ENV]: "false" })).toBe(true);
    expect(isSqliteWriteQueueDisabled({ [ALAYA_SQLITE_WRITE_QUEUE_ENV]: "off" })).toBe(true);
    expect(isSqliteWriteQueueDisabled({ [ALAYA_SQLITE_WRITE_QUEUE_ENV]: "disabled" })).toBe(true);
    expect(isSqliteWriteQueueDisabled({})).toBe(false);
  });

  it("installs the worker queue by default when the worker script is built", async () => {
    expect(resolveSqliteWriteQueueWorkerUrl()).not.toBeNull();
    const port = await installDefaultSqliteWriteQueue({});
    expect(port).not.toBeNull();
    expect(port?.kind).toBe("worker-thread-sqlite-write-queue");
    expect(getSqliteWriteQueuePort()).toBe(port);
  }, 60_000);

  it("closes the prior port before replacing on reinstall", async () => {
    const first = await installDefaultSqliteWriteQueue({});
    expect(first).not.toBeNull();

    const second = await installDefaultSqliteWriteQueue({});
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expect(getSqliteWriteQueuePort()).toBe(second);
    await expect(
      first!.enqueue({
        jobId: "after-replace",
        kind: "maintenance",
        filename: "/tmp/alaya/after-replace.db",
        execute: async () => undefined
      })
    ).rejects.toThrow(/closed/);
  }, 60_000);

  it("leaves the queue unconfigured when opted out", async () => {
    const port = await installDefaultSqliteWriteQueue({ [ALAYA_SQLITE_WRITE_QUEUE_ENV]: "0" });
    expect(port).toBeNull();
    expect(getSqliteWriteQueuePort()).toBeNull();
  });
});
