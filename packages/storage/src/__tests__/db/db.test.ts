import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getCurrentSchemaSummary, initDatabase } from "../../sqlite/db.js";
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

describe("StorageDatabase reopen cache handling", () => {
  const directories: string[] = [];
  const databases: ReturnType<typeof initDatabase>[] = [];

  afterEach(() => {
    while (databases.length > 0) {
      databases.pop()?.close();
    }
    while (directories.length > 0) {
      const directory = directories.pop();
      if (directory !== undefined) {
        cleanupTempDirectory(directory);
      }
    }
  });

  it("closes a cache-evicted database when reopening into a full file-backed cache", () => {
    const closedContext = createTempDatabasePath();
    directories.push(closedContext.directory);
    const closedDatabase = initDatabase({ filename: closedContext.filename });
    databases.push(closedDatabase);
    closedDatabase.close();

    const cachedDatabases = Array.from({ length: 32 }, () => {
      const context = createTempDatabasePath();
      directories.push(context.directory);
      const database = initDatabase({ filename: context.filename });
      databases.push(database);
      return database;
    });
    const oldestCachedDatabase = cachedDatabases[0];

    closedDatabase.reopenIfClosed();

    expect(closedDatabase.isClosed()).toBe(false);
    expect(oldestCachedDatabase.isClosed()).toBe(true);
  }, 20_000);
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

describe("initDatabase migration runner", () => {
  let context: TempContext;

  beforeEach(() => {
    context = createTempDatabasePath();
  });

  afterEach(() => {
    cleanupTempDirectory(context.directory);
  });

  it("resumes a partially migrated file database and finishes with the full ordered schema ledger", () => {
    const migrationFiles = readMigrationInventory().files;
    const partialCutoff = migrationFiles.length - 3;
    expect(partialCutoff).toBeGreaterThan(0);
    const seed = new BetterSqlite3(context.filename);
    try {
      seed.pragma("foreign_keys = ON");
      seed.exec(`
        CREATE TABLE schema_version (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL
        )
      `);
      const markApplied = seed.prepare(
        "INSERT INTO schema_version (version, applied_at) VALUES (?, ?)"
      );

      for (const file of migrationFiles.slice(0, partialCutoff)) {
        seed.transaction(() => {
          seed.exec(file.sql);
          markApplied.run(file.version, `2026-06-14T00:00:${String(file.version).padStart(2, "0")}.000Z`);
        })();
      }
    } finally {
      seed.close();
    }

    const database = initDatabase({ filename: context.filename });
    try {
      const appliedVersions = (
        database.connection.prepare("SELECT version FROM schema_version ORDER BY version ASC").all() as ReadonlyArray<{
          readonly version: number;
        }>
      ).map((row) => row.version);
      expect(appliedVersions).toEqual(migrationFiles.map((file) => file.version));
      expect(getCurrentSchemaSummary(database)).toEqual({
        persistedMaxVersion: migrationFiles.at(-1)?.version ?? null,
        knownMaxVersion: migrationFiles.at(-1)?.version ?? 0,
        schemaOk: true
      });
    } finally {
      database.close();
    }
  });

  it("repairs duplicate pending strict-governance proposals before adding the dedupe index", () => {
    const migrationFiles = readMigrationInventory().files;
    const seedFiles = migrationFiles.filter((file) => file.version < 100);
    expect(seedFiles.length).toBeGreaterThan(0);
    const seed = new BetterSqlite3(context.filename);
    try {
      seed.pragma("foreign_keys = ON");
      seed.exec(`
        CREATE TABLE schema_version (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL
        )
      `);
      const markApplied = seed.prepare(
        "INSERT INTO schema_version (version, applied_at) VALUES (?, ?)"
      );
      for (const file of seedFiles) {
        seed.transaction(() => {
          seed.exec(file.sql);
          markApplied.run(file.version, `2026-06-14T00:00:${String(file.version).padStart(2, "0")}.000Z`);
        })();
      }

      const insertProposal = seed.prepare(`
        INSERT INTO proposals (
          runtime_id,
          object_kind,
          proposal_id,
          derived_from,
          retention_policy,
          dossier_ref,
          recommended_option_id,
          proposal_options,
          resolution_state,
          last_updated_at,
          workspace_id,
          run_id,
          target_object_kind,
          proposed_change_summary,
          created_at
        ) VALUES (?, 'proposal', ?, ?, 'session_only', ?, 'option-1', '[]', ?, ?, ?, 'run-1', ?, '', ?)
      `);
      insertProposal.run(
        "runtime-oldest",
        "proposal-oldest",
        "memory-1",
        "inspector.strict_governance_promotion",
        "pending",
        "2026-03-21T00:00:00.000Z",
        "workspace-1",
        "path_relation",
        "2026-03-21T00:00:00.000Z"
      );
      insertProposal.run(
        "runtime-duplicate",
        "proposal-duplicate",
        "memory-1",
        "inspector.strict_governance_promotion",
        "pending",
        "2026-03-21T00:01:00.000Z",
        "workspace-1",
        "path_relation",
        "2026-03-21T00:01:00.000Z"
      );
      insertProposal.run(
        "runtime-other-memory",
        "proposal-other-memory",
        "memory-2",
        "inspector.strict_governance_promotion",
        "pending",
        "2026-03-21T00:02:00.000Z",
        "workspace-1",
        "path_relation",
        "2026-03-21T00:02:00.000Z"
      );
    } finally {
      seed.close();
    }

    const database = initDatabase({ filename: context.filename });
    try {
      const rows = database.connection.prepare(`
        SELECT proposal_id, resolution_state, reviewer_identity
        FROM proposals
        WHERE workspace_id = 'workspace-1'
          AND dossier_ref = 'inspector.strict_governance_promotion'
          AND target_object_kind = 'path_relation'
        ORDER BY proposal_id ASC
      `).all() as ReadonlyArray<{
        readonly proposal_id: string;
        readonly resolution_state: string;
        readonly reviewer_identity: string | null;
      }>;
      const pendingCount = database.connection.prepare(`
        SELECT COUNT(*) AS count
        FROM proposals
        WHERE workspace_id = 'workspace-1'
          AND derived_from = 'memory-1'
          AND dossier_ref = 'inspector.strict_governance_promotion'
          AND target_object_kind = 'path_relation'
          AND resolution_state = 'pending'
      `).get() as { readonly count: number };
      const indexRow = database.connection.prepare(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'index'
          AND name = 'idx_proposals_pending_strict_governance_unique'
      `).get() as { readonly name: string } | undefined;

      expect(rows).toEqual([
        {
          proposal_id: "proposal-duplicate",
          resolution_state: "rejected",
          reviewer_identity: "migration.strict_governance_dedupe"
        },
        {
          proposal_id: "proposal-oldest",
          resolution_state: "pending",
          reviewer_identity: null
        },
        {
          proposal_id: "proposal-other-memory",
          resolution_state: "pending",
          reviewer_identity: null
        }
      ]);
      expect(pendingCount.count).toBe(1);
      expect(indexRow?.name).toBe("idx_proposals_pending_strict_governance_unique");
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
