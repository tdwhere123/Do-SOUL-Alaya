import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getSqliteWriteQueuePort } from "@do-soul/alaya-storage";
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
