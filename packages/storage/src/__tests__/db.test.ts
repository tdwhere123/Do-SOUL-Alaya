import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initDatabase } from "../db.js";

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
