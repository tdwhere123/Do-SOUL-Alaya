import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configureSqliteWriteQueuePort, initDatabase } from "../../sqlite/db.js";
import { createInMemorySqliteWriteQueuePort } from "../../sqlite/write-queue-port.js";
import { removeTempDirectorySync } from "../temp-directory.js";

interface TempContext {
  directory: string;
  filename: string;
}

function createTempDatabasePath(): TempContext {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "alaya-db-eviction-test-"));
  const filename = path.join(directory, "alaya.db");
  return { directory, filename };
}

describe("StorageDatabase write-queue eviction guard", () => {
  const directories: string[] = [];
  const databases: ReturnType<typeof initDatabase>[] = [];

  afterEach(() => {
    configureSqliteWriteQueuePort(null);
    while (databases.length > 0) {
      databases.pop()?.close();
    }
    while (directories.length > 0) {
      const directory = directories.pop();
      if (directory !== undefined) {
        removeTempDirectorySync(directory, databases);
      }
    }
  }, 30_000);

  it("does not close cached databases while the write queue blocks eviction", async () => {
    const blockedContext = createTempDatabasePath();
    directories.push(blockedContext.directory);
    const blockedDatabase = initDatabase({ filename: blockedContext.filename });
    databases.push(blockedDatabase);

    const queue = createInMemorySqliteWriteQueuePort();
    configureSqliteWriteQueuePort(queue);
    let releaseSlowJob: (() => void) | undefined;
    const slowJobGate = new Promise<void>((resolve) => {
      releaseSlowJob = resolve;
    });
    const pendingJob = queue.enqueue({
      jobId: "block-eviction",
      kind: "event_log_transaction",
      filename: blockedContext.filename,
      execute: async () => {
        await slowJobGate;
      }
    });

    expect(queue.blocksEviction(blockedContext.filename)).toBe(true);

    for (let index = 0; index < 32; index += 1) {
      const context = createTempDatabasePath();
      directories.push(context.directory);
      databases.push(initDatabase({ filename: context.filename }));
    }

    expect(blockedDatabase.isClosed()).toBe(false);
    releaseSlowJob?.();
    await pendingJob;
  }, 20_000);
});
