import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it } from "vitest";
import { StorageError } from "../../shared/errors.js";
import { initDatabase } from "../../sqlite/db.js";
import {
  READ_ONLY_BUSY_TIMEOUT_MS,
  openReadOnlyDatabase,
  withSqliteBusyRetry
} from "../../sqlite/open-readonly.js";
import { removeTempDirectorySync } from "../temp-directory.js";

const directories: string[] = [];
const databases: Array<ReturnType<typeof initDatabase>> = [];

afterEach(() => {
  while (databases.length > 0) {
    databases.pop()?.close();
  }
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) {
      removeTempDirectorySync(directory);
    }
  }
});

function createFilename(): string {
  const directory = mkdtempSync(join(tmpdir(), "alaya-readonly-busy-"));
  directories.push(directory);
  return join(directory, "alaya.db");
}

describe("openReadOnlyDatabase busy timeout", () => {
  it("sets busy_timeout on the read-only connection", () => {
    const filename = createFilename();
    const writable = initDatabase({ filename });
    databases.push(writable);
    writable.close();
    const readonly = openReadOnlyDatabase(filename);
    try {
      expect(Number(readonly.connection.pragma("busy_timeout", { simple: true })))
        .toBe(READ_ONLY_BUSY_TIMEOUT_MS);
      expect(String(readonly.connection.pragma("query_only", { simple: true }))).toMatch(/on|1/i);
    } finally {
      readonly.close();
    }
  });

  it("absorbs checkpoint-time reads while a writer is appending", () => {
    const filename = createFilename();
    const writable = initDatabase({ filename });
    databases.push(writable);
    writable.connection.exec("CREATE TABLE busy_probe (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)");
    const insert = writable.connection.prepare("INSERT INTO busy_probe (payload) VALUES (?)");
    const readonly = openReadOnlyDatabase(filename);
    try {
      const select = readonly.connection.prepare("SELECT COUNT(*) AS count FROM busy_probe");
      expect(() => {
        for (let index = 0; index < 40; index += 1) {
          insert.run(`row-${index}`);
          withSqliteBusyRetry(() => select.get());
          if (index % 8 === 0) {
            writable.connection.pragma("wal_checkpoint(RESTART)");
          }
        }
      }).not.toThrow();
    } finally {
      readonly.close();
    }
  });

  it("retries SQLITE_BUSY a bounded number of times", () => {
    let attempts = 0;
    const started = performance.now();
    expect(() => withSqliteBusyRetry(() => {
      attempts += 1;
      const error = new Error("SQLITE_BUSY: database is locked") as Error & { errcode?: number };
      error.errcode = 5;
      throw error;
    })).toThrow(/SQLITE_BUSY/);
    expect(attempts).toBe(5);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("retries a wrapped database-is-locked cause", () => {
    let attempts = 0;
    expect(withSqliteBusyRetry(() => {
      attempts += 1;
      if (attempts < 3) {
        throw new StorageError(
          "MIGRATION_FAILED",
          "Failed to apply migration 001-init.sql",
          Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY", errcode: 5 })
        );
      }
      return "ready";
    })).toBe("ready");
    expect(attempts).toBe(3);
  });
});

describe("openReadOnlyDatabase open retry", () => {
  it("opens an existing migrated file", () => {
    const filename = createFilename();
    const writable = initDatabase({ filename });
    databases.push(writable);
    const readonly = openReadOnlyDatabase(filename);
    try {
      expect(readonly.connection.prepare("SELECT 1 AS value").get()).toEqual({ value: 1 });
    } finally {
      readonly.close();
    }
  });
});
