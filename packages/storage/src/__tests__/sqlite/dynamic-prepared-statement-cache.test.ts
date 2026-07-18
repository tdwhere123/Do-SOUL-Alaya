import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initDatabase } from "../../sqlite/db.js";
import { DynamicPreparedStatementCache } from "../../sqlite/dynamic-prepared-statement-cache.js";
import { removeTempDirectorySync } from "../temp-directory.js";

const tempDirs: string[] = [];
const databases: ReturnType<typeof initDatabase>[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      removeTempDirectorySync(dir, databases);
    }
  }
  databases.length = 0;
});

describe("DynamicPreparedStatementCache", () => {
  it("returns the same prepared statement for repeated SQL on one connection", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "alaya-dynamic-prepared-"));
    tempDirs.push(tempDir);
    const db = initDatabase({ filename: path.join(tempDir, "dynamic-prepared.db") });
    databases.push(db);
    let prepareCount = 0;
    const connection = db.connection;
    const originalPrepare = connection.prepare.bind(connection);
    connection.prepare = ((sql: string) => {
      prepareCount += 1;
      return originalPrepare(sql);
    }) as typeof connection.prepare;

    const cache = new DynamicPreparedStatementCache(db, () => db.reopenIfClosed());
    const sql = "SELECT 1 AS value";
    const first = cache.prepare(sql);
    const second = cache.prepare(sql);

    expect(first).toBe(second);
    expect(first.all()[0]).toEqual({ value: 1 });
    expect(prepareCount).toBe(1);
  });

  it("invalidates cached statements after close and reopenIfClosed", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "alaya-dynamic-prepared-"));
    tempDirs.push(tempDir);
    const db = initDatabase({ filename: path.join(tempDir, "dynamic-prepared-reopen.db") });
    databases.push(db);
    let prepareCount = 0;
    const trackPrepare = (): void => {
      const connection = db.connection;
      const originalPrepare = connection.prepare.bind(connection);
      connection.prepare = ((sql: string) => {
        prepareCount += 1;
        return originalPrepare(sql);
      }) as typeof connection.prepare;
    };
    trackPrepare();

    const cache = new DynamicPreparedStatementCache(db, () => db.reopenIfClosed());
    const sql = "SELECT 2 AS value";
    const beforeClose = cache.prepare(sql);
    expect(prepareCount).toBe(1);

    db.close();
    db.reopenIfClosed();
    trackPrepare();
    const afterReopen = cache.prepare(sql);

    expect(prepareCount).toBe(2);
    expect(afterReopen).not.toBe(beforeClose);
    expect(afterReopen.all()[0]).toEqual({ value: 2 });
  });

  it("evicts the least recently used statement when the cache reaches its bound", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "alaya-dynamic-prepared-"));
    tempDirs.push(tempDir);
    const db = initDatabase({ filename: path.join(tempDir, "dynamic-prepared-bounded.db") });
    databases.push(db);
    let prepareCount = 0;
    const originalPrepare = db.connection.prepare.bind(db.connection);
    db.connection.prepare = ((sql: string) => {
      prepareCount += 1;
      return originalPrepare(sql);
    }) as typeof db.connection.prepare;

    const cache = new DynamicPreparedStatementCache(db, () => db.reopenIfClosed(), 2);
    cache.prepare("SELECT 1 AS value");
    cache.prepare("SELECT 2 AS value");
    cache.prepare("SELECT 1 AS value");
    cache.prepare("SELECT 3 AS value");
    cache.prepare("SELECT 2 AS value");

    expect(prepareCount).toBe(4);
  });
});
