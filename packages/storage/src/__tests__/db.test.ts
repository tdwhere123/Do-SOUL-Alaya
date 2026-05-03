import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initDatabase } from "../db.js";
import { StorageError } from "../errors.js";

interface TempContext {
  directory: string;
  filename: string;
}

function createTempDatabasePath(): TempContext {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "alaya-db-test-"));
  const filename = path.join(directory, "alaya.db");
  return { directory, filename };
}

function cleanupTempDirectory(directory: string): void {
  fs.rmSync(directory, { recursive: true, force: true });
}

describe("initDatabase PRAGMA hardening", () => {
  let context: TempContext;

  beforeEach(() => {
    context = createTempDatabasePath();
  });

  afterEach(() => {
    cleanupTempDirectory(context.directory);
  });

  it("enables WAL journal mode on file-backed databases", () => {
    const database = initDatabase({ filename: context.filename });
    try {
      const journalMode = database.connection.pragma("journal_mode", { simple: true });
      expect(String(journalMode).toLowerCase()).toBe("wal");
    } finally {
      database.close();
    }
  });

  it("configures the SQLite busy_timeout to 5000ms", () => {
    const database = initDatabase({ filename: context.filename });
    try {
      const busyTimeout = database.connection.pragma("busy_timeout", { simple: true });
      expect(Number(busyTimeout)).toBe(5000);
    } finally {
      database.close();
    }
  });

  it("sets synchronous mode to NORMAL", () => {
    const database = initDatabase({ filename: context.filename });
    try {
      // SQLite returns the integer code for `synchronous`: 1 == NORMAL.
      const synchronous = database.connection.pragma("synchronous", { simple: true });
      expect(Number(synchronous)).toBe(1);
    } finally {
      database.close();
    }
  });

  it("keeps foreign_keys enforcement enabled", () => {
    const database = initDatabase({ filename: context.filename });
    try {
      const foreignKeys = database.connection.pragma("foreign_keys", { simple: true });
      expect(Number(foreignKeys)).toBe(1);
    } finally {
      database.close();
    }
  });
});

describe("initDatabase forward-version guard", () => {
  let context: TempContext;

  beforeEach(() => {
    context = createTempDatabasePath();
  });

  afterEach(() => {
    cleanupTempDirectory(context.directory);
  });

  it("throws STORAGE_VERSION_AHEAD when the on-disk schema_version exceeds the known max", () => {
    // Pre-seed the database with a schema_version row from a hypothetical
    // future Alaya release (version 999), then verify initDatabase refuses
    // to run migrations against it.
    const seed = new BetterSqlite3(context.filename);
    try {
      seed.exec(`
        CREATE TABLE schema_version (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL
        );
        INSERT INTO schema_version (version, applied_at)
        VALUES (999, '2099-01-01T00:00:00.000Z');
      `);
    } finally {
      seed.close();
    }

    let captured: unknown = null;
    try {
      const database = initDatabase({ filename: context.filename });
      database.close();
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(StorageError);
    const storageError = captured as StorageError;
    expect(storageError.code).toBe("STORAGE_VERSION_AHEAD");
    expect(storageError.message).toContain("999");
  });

  it("succeeds when the persisted schema_version is at or below the known max", () => {
    // Migrating fresh (no schema_version row) is the canonical path and must
    // remain allowed; this exercises the MAX(version)=NULL branch.
    const database = initDatabase({ filename: context.filename });
    try {
      const journalMode = database.connection.pragma("journal_mode", { simple: true });
      expect(String(journalMode).toLowerCase()).toBe("wal");
    } finally {
      database.close();
    }
  });
});
