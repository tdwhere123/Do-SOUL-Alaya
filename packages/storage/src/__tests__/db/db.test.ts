import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initDatabase } from "../../sqlite/db.js";
import { StorageError } from "../../shared/errors.js";

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

describe("SQLite migration inventory guardrail", () => {
  it("keeps migration versions unique and gaps explicitly documented", () => {
    const inventory = readMigrationInventory();
    const duplicateVersions = [...inventory.versionCounts.entries()]
      .filter(([, count]) => count > 1)
      .map(([version]) => version);
    const zeroByteFiles = inventory.files
      .filter((file) => file.sql.trim().length === 0)
      .map((file) => file.name);
    const unallowlistedGaps = inventory.gaps.filter(
      (version) => !INTENTIONAL_MIGRATION_GAPS.has(version)
    );

    expect(duplicateVersions).toEqual([]);
    expect(zeroByteFiles).toEqual([]);
    expect(unallowlistedGaps).toEqual([]);
  });

  it("keeps comment-only migrations rare and explicitly marked", () => {
    const commentOnlyFiles = readMigrationInventory().files
      .filter((file) => stripSqlComments(file.sql).trim().length === 0)
      .map((file) => file.name);
    const unexpectedCommentOnly = commentOnlyFiles.filter(
      (fileName) => !INTENTIONAL_NOOP_MIGRATIONS.has(fileName)
    );
    const missingMarker = commentOnlyFiles.filter((fileName) => {
      const marker = "INTENTIONAL_NOOP_MIGRATION";
      const file = readMigrationInventory().files.find((item) => item.name === fileName);
      return file === undefined || !file.sql.includes(marker);
    });

    expect(unexpectedCommentOnly).toEqual([]);
    expect(missingMarker).toEqual([]);
  });

  it("keeps migration SQL comments free of task-history narrative", () => {
    const forbiddenPatterns = [
      /#BL-\d+/u,
      /\bvendor snapshot\b/iu,
      /\bpre-A1\b/iu,
      /\bfix-loop\b/iu,
      /\bv0\.\d+(?:\.\d+)?\b/iu,
      /\bv0\.3\.9\s+Cat-/iu,
      /\bCat-[A-Z0-9.]+\b/u
    ];
    const hits = readMigrationInventory().files.flatMap((file) =>
      file.sql
        .split(/\r?\n/u)
        .map((line, index) => ({ line, index: index + 1 }))
        .filter(({ line }) => line.trimStart().startsWith("--"))
        .filter(({ line }) => forbiddenPatterns.some((pattern) => pattern.test(line)))
        .map(({ line, index }) => `${file.name}:${index}:${line.trim()}`)
    );

    expect(hits).toEqual([]);
  });
});

const INTENTIONAL_MIGRATION_GAPS = new Set([70, 75]);
const INTENTIONAL_NOOP_MIGRATIONS = new Set(["074-claim-kind-expanded.sql"]);

function readMigrationInventory(): {
  readonly files: readonly { readonly name: string; readonly version: number; readonly sql: string }[];
  readonly versionCounts: ReadonlyMap<number, number>;
  readonly gaps: readonly number[];
} {
  const migrationsDirectory = fileURLToPath(new URL("../../migrations", import.meta.url));
  const files = fs
    .readdirSync(migrationsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => {
      const match = /^(\d+)-.+\.sql$/u.exec(entry.name);
      expect(match, `invalid migration filename: ${entry.name}`).not.toBeNull();
      const version = Number(match?.[1] ?? Number.NaN);
      return {
        name: entry.name,
        version,
        sql: fs.readFileSync(path.join(migrationsDirectory, entry.name), "utf8")
      };
    })
    .sort((left, right) => left.version - right.version);
  const versionCounts = new Map<number, number>();
  for (const file of files) {
    versionCounts.set(file.version, (versionCounts.get(file.version) ?? 0) + 1);
  }
  const versions = new Set(files.map((file) => file.version));
  const maxVersion = Math.max(...versions);
  const gaps: number[] = [];
  for (let version = 1; version <= maxVersion; version += 1) {
    if (!versions.has(version)) {
      gaps.push(version);
    }
  }
  return { files, versionCounts, gaps };
}

function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .split(/\r?\n/u)
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
}
