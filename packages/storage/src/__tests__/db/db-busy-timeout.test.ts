import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StorageError } from "../../shared/errors.js";
import { initDatabase } from "../../sqlite/db.js";

describe("initDatabase busy timeout policy", () => {
  let directory: string;
  let filename: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "alaya-db-timeout-test-"));
    filename = path.join(directory, "alaya.db");
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("defaults to 5000ms", () => {
    const database = initDatabase({ filename });
    try {
      expect(Number(database.connection.pragma("busy_timeout", { simple: true }))).toBe(5_000);
    } finally {
      database.close();
    }
  });

  it("preserves an explicit timeout across close and reopen", () => {
    const database = initDatabase({ filename, busyTimeoutMs: 250 });
    try {
      expect(Number(database.connection.pragma("busy_timeout", { simple: true }))).toBe(250);
      database.close();
      database.reopenIfClosed();
      expect(Number(database.connection.pragma("busy_timeout", { simple: true }))).toBe(250);
    } finally {
      database.close();
    }
  });

  it("rejects invalid timeout values before opening SQLite", () => {
    expect(() => initDatabase({ filename, busyTimeoutMs: -1 })).toThrow(StorageError);
    expect(() => initDatabase({ filename, busyTimeoutMs: Number.MAX_SAFE_INTEGER })).toThrow(
      StorageError
    );
  });

  it("keeps a cached policy unless an explicit caller conflicts", () => {
    const database = initDatabase({ filename, busyTimeoutMs: 250 });
    try {
      expect(initDatabase({ filename })).toBe(database);
      expect(() => initDatabase({ filename, busyTimeoutMs: 5_000 })).toThrow(StorageError);
    } finally {
      database.close();
    }
  });

  it("bounds a real competing-writer wait to the configured interval", () => {
    const database = initDatabase({ filename, busyTimeoutMs: 250 });
    const blocker = new BetterSqlite3(filename);
    try {
      database.connection.exec("CREATE TABLE timeout_probe (id INTEGER PRIMARY KEY)");
      blocker.exec("BEGIN IMMEDIATE");
      const startedAt = performance.now();
      expect(() => database.connection.exec("INSERT INTO timeout_probe (id) VALUES (1)"))
        .toThrow();
      const elapsedMs = performance.now() - startedAt;
      expect(elapsedMs).toBeGreaterThanOrEqual(150);
      expect(elapsedMs).toBeLessThan(1_000);
    } finally {
      if (blocker.inTransaction) blocker.exec("ROLLBACK");
      blocker.close();
      database.close();
    }
  });
});
