import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initDatabase } from "../../sqlite/db.js";
import { RefreshableStatementHolder } from "../../sqlite/refreshable-statement-holder.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("RefreshableStatementHolder", () => {
  it("reprepares statements after the database connection is closed and reopened", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "alaya-refreshable-"));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, "refreshable.db");

    const db = initDatabase({ filename: dbPath });
    let prepareCount = 0;
    const holder = new RefreshableStatementHolder(db, (database) => {
      prepareCount += 1;
      return {
        ping: database.connection.prepare("SELECT 1 AS value")
      };
    });

    expect(holder.active().ping.get()).toEqual({ value: 1 });
    expect(prepareCount).toBe(1);

    db.close();
    expect(holder.active().ping.get()).toEqual({ value: 1 });
    expect(prepareCount).toBe(2);
  });

  it("reprepares statements when a shared database is reopened by another holder", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "alaya-refreshable-"));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, "refreshable.db");

    const db = initDatabase({ filename: dbPath });
    let firstPrepareCount = 0;
    let secondPrepareCount = 0;
    const firstHolder = new RefreshableStatementHolder(db, (database) => {
      firstPrepareCount += 1;
      return {
        ping: database.connection.prepare("SELECT 1 AS value")
      };
    });
    const secondHolder = new RefreshableStatementHolder(db, (database) => {
      secondPrepareCount += 1;
      return {
        ping: database.connection.prepare("SELECT 2 AS value")
      };
    });

    expect(firstHolder.active().ping.get()).toEqual({ value: 1 });
    expect(secondHolder.active().ping.get()).toEqual({ value: 2 });

    db.close();
    expect(firstHolder.active().ping.get()).toEqual({ value: 1 });
    expect(db.isClosed()).toBe(false);
    expect(secondHolder.active().ping.get()).toEqual({ value: 2 });
    expect(firstPrepareCount).toBe(2);
    expect(secondPrepareCount).toBe(2);
  });
});
