import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { getSqliteWriteQueuePort, StorageDatabase } from "@do-soul/alaya-storage";
import {
  closeDaemonSqliteWriteQueue,
  openDaemonDatabase
} from "../../../runtime/startup/database.js";

describe("daemon startup database", () => {
  it("uses the storage default busy timeout", async () => {
    const directory = mkdtempSync(join(tmpdir(), "alaya-daemon-database-test-"));
    const database = await openDaemonDatabase(join(directory, "alaya.db"));
    try {
      expect(database.getBusyTimeoutMs()).toBe(5_000);
    } finally {
      database.close();
      await closeDaemonSqliteWriteQueue();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refreshes sqlite planner stats once on open", async () => {
    const previousQueue = process.env.ALAYA_SQLITE_WRITE_QUEUE;
    process.env.ALAYA_SQLITE_WRITE_QUEUE = "0";
    const optimize = vi.spyOn(StorageDatabase.prototype, "optimize");
    const directory = mkdtempSync(join(tmpdir(), "alaya-daemon-database-optimize-test-"));
    try {
      const database = await openDaemonDatabase(join(directory, "alaya.db"));
      try {
        expect(optimize).toHaveBeenCalledTimes(1);
        expect(optimize.mock.instances[0]).toBe(database);
      } finally {
        database.close();
        await closeDaemonSqliteWriteQueue();
      }
    } finally {
      optimize.mockRestore();
      if (previousQueue === undefined) {
        delete process.env.ALAYA_SQLITE_WRITE_QUEUE;
      } else {
        process.env.ALAYA_SQLITE_WRITE_QUEUE = previousQueue;
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("replaces a prior write-queue install on a second open", async () => {
    const directory = mkdtempSync(join(tmpdir(), "alaya-daemon-database-reopen-test-"));
    const first = await openDaemonDatabase(join(directory, "first.db"));
    const firstQueue = getSqliteWriteQueuePort();
    expect(firstQueue).not.toBeNull();
    const second = await openDaemonDatabase(join(directory, "second.db"));
    try {
      const secondQueue = getSqliteWriteQueuePort();
      expect(secondQueue).not.toBeNull();
      expect(secondQueue).not.toBe(firstQueue);
    } finally {
      first.close();
      second.close();
      await closeDaemonSqliteWriteQueue();
      expect(getSqliteWriteQueuePort()).toBeNull();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
