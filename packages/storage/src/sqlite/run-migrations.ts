import fs from "node:fs";
import path from "node:path";
import { initializeObservableMutationGeneration } from "../repos/garden/indexed-recall-projection-schema.js";
import { rebuildSourceIndexLexicalDomains } from "../repos/source-index/lexical-domain.js";
import { StorageError } from "../shared/errors.js";
import type { SqliteConnection } from "./db.js";
import { migrateEmbeddingVectorValidity } from "./embedding-vector-validity-migration.js";
import { openSqliteConnection, SqliteConnectionCleanupError } from "./open-sqlite-connection.js";
import { migrateRetainedSourceChunks } from "./retained-source-migration.js";
import {
  DEFAULT_SQLITE_BUSY_RETRY_LIMIT,
  DEFAULT_SQLITE_BUSY_RETRY_SLEEP_MS,
  isSqliteBusyError,
  withSqliteBusyRetry
} from "./sqlite-busy-retry.js";
import {
  TEMPORAL_OFFLINE_MIGRATION_VERSION,
  computeKnownMaxVersion,
  listMigrationFiles,
  migrateLegacyPathRelationsToTemporalCandidate,
  resolveMigrationsDirectory,
  type TemporalDatabaseMode
} from "./temporal-cutover-gate.js";
import {
  TEMPORAL_VERIFIED_BIND_KEY_MIGRATION_VERSION,
  migrateVerifiedProjectionBindKey
} from "./temporal-verified-bind-key.js";

/** Default 5s constructor timeout would spend openSqliteConnection's 2s budget on one wait. */
const UNINITIALIZED_DATABASE_PROBE_TIMEOUT_MS = 50;
const MEMORY_ENTRY_ENUM_CHECK_MIGRATION_VERSION = 14;
const OBSERVATION_MEMORY_DIMENSION_MIGRATION_VERSION = 17;
const SOURCE_HOST_OCCURRENCE_MIGRATION_VERSION = 24;

interface MigrationStatements {
  readonly isAppliedStatement: {
    get(...args: readonly unknown[]): unknown;
  };
  readonly markAppliedStatement: {
    run(...args: readonly unknown[]): unknown;
  };
}

export function runMigrations(
  database: SqliteConnection,
  temporalMode: TemporalDatabaseMode,
  busyTimeoutMs: number
): void {
  const migrationsDirectory = resolveMigrationsDirectory();
  const migrationFiles = listMigrationFiles(migrationsDirectory);
  assertContiguousMigrationFileVersions(migrationFiles);
  const knownMaxVersion = computeKnownMaxVersion(migrationFiles);
  assertSchemaVersionNotAhead(database, knownMaxVersion);

  const beforeRebuild: string[] = [];
  const rebuild: string[] = [];
  const afterRebuild: string[] = [];
  for (const fileName of migrationFiles) {
    const version = parseMigrationVersion(fileName);
    if (version === TEMPORAL_OFFLINE_MIGRATION_VERSION && temporalMode === "runtime") {
      continue;
    }
    if (version < MEMORY_ENTRY_ENUM_CHECK_MIGRATION_VERSION) {
      beforeRebuild.push(fileName);
    } else if (version === MEMORY_ENTRY_ENUM_CHECK_MIGRATION_VERSION) {
      rebuild.push(fileName);
    } else {
      afterRebuild.push(fileName);
    }
  }

  // Keep 1..13 atomic so a concurrent opener never observes a pre-temporal ledger.
  applyMigrationBatch(database, migrationsDirectory, beforeRebuild, temporalMode, false, busyTimeoutMs);
  applyMigrationBatch(database, migrationsDirectory, rebuild, temporalMode, true, busyTimeoutMs);
  const beforeObservation = afterRebuild.filter((fileName) => parseMigrationVersion(fileName) < OBSERVATION_MEMORY_DIMENSION_MIGRATION_VERSION);
  const observation = afterRebuild.filter((fileName) => parseMigrationVersion(fileName) === OBSERVATION_MEMORY_DIMENSION_MIGRATION_VERSION);
  const later = afterRebuild.filter((fileName) => parseMigrationVersion(fileName) > OBSERVATION_MEMORY_DIMENSION_MIGRATION_VERSION);
  applyMigrationBatch(database, migrationsDirectory, beforeObservation, temporalMode, false, busyTimeoutMs);
  applyMigrationBatch(database, migrationsDirectory, observation, temporalMode, true, busyTimeoutMs);
  const beforeHost = later.filter(fileName => parseMigrationVersion(fileName) < SOURCE_HOST_OCCURRENCE_MIGRATION_VERSION);
  const host = later.filter(fileName => parseMigrationVersion(fileName) === SOURCE_HOST_OCCURRENCE_MIGRATION_VERSION);
  const afterHost = later.filter(fileName => parseMigrationVersion(fileName) > SOURCE_HOST_OCCURRENCE_MIGRATION_VERSION);
  applyMigrationBatch(database, migrationsDirectory, beforeHost, temporalMode, false, busyTimeoutMs);
  applyMigrationBatch(database, migrationsDirectory, host, temporalMode, true, busyTimeoutMs);
  applyMigrationBatch(database, migrationsDirectory, afterHost, temporalMode, false, busyTimeoutMs, true);
}

function ensureSchemaVersionTable(database: SqliteConnection): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);
}

function assertSchemaVersionNotAhead(database: SqliteConnection, knownMaxVersion: number): void {
  const persistedMaxVersion = readPersistedMaxVersionForMigration(database);
  if (persistedMaxVersion !== null && persistedMaxVersion > knownMaxVersion) {
    throw new StorageError(
      "STORAGE_VERSION_AHEAD",
      `Database schema version ${persistedMaxVersion} is ahead of this binary's known max ${knownMaxVersion}. ` +
        "Upgrade Alaya or restore a database matching this version."
    );
  }
}

function readPersistedMaxVersionForMigration(database: SqliteConnection): number | null {
  try {
    const row = database
      .prepare("SELECT MAX(version) AS max_version FROM schema_version")
      .get() as Readonly<{ max_version: number | null }> | undefined;
    return row?.max_version ?? null;
  } catch (error) {
    if (isSqliteNoSuchTableError(error)) {
      return null;
    }
    throw new StorageError(
      "DATABASE_OPEN_FAILED",
      "Failed to read schema_version during database initialization.",
      error
    );
  }
}

function isSqliteNoSuchTableError(error: unknown): boolean {
  return error instanceof Error && /no such table/i.test(error.message);
}

export function knownMigrationMaxVersion(): number {
  return computeKnownMaxVersion(listMigrationFiles(resolveMigrationsDirectory()));
}

function prepareMigrationStatements(database: SqliteConnection): MigrationStatements {
  return {
    isAppliedStatement: database.prepare("SELECT 1 FROM schema_version WHERE version = ? LIMIT 1"),
    markAppliedStatement: database.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)")
  };
}

function applyMigrationBatch(
  database: SqliteConnection,
  migrationsDirectory: string,
  fileNames: readonly string[],
  temporalMode: TemporalDatabaseMode,
  rebuildsReferencedTable: boolean,
  busyTimeoutMs: number,
  finalBatch = false
): void {
  if (fileNames.length === 0) return;
  if (rebuildsReferencedTable) {
    // PRAGMA foreign_keys is a no-op inside a transaction; DROP/rename of
    // referenced tables needs incoming FKs disabled for the official rebuild.
    // Existing rows still pass each rebuilt table's CHECK constraints.
    database.pragma("foreign_keys = OFF");
  }
  try {
    withSqliteBusyRetry(() => {
      database.transaction(() => {
        ensureSchemaVersionTable(database);
        const statements = prepareMigrationStatements(database);
        for (const fileName of fileNames) {
          applyMigrationIfPending(database, migrationsDirectory, statements, fileName, temporalMode);
        }
        // Current observers depend on the complete schema, including tables added
        // or rebuilt after their original migration. Refresh even on a no-op reopen.
        if (finalBatch && database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='garden_projection_cursor'").get() !== undefined) {
          initializeObservableMutationGeneration(database);
        }
      }).immediate();
    }, {
      retryLimit: DEFAULT_SQLITE_BUSY_RETRY_LIMIT,
      budgetMs: busyTimeoutMs,
      sleepMs: DEFAULT_SQLITE_BUSY_RETRY_SLEEP_MS
    });
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw new StorageError(
      "MIGRATION_FAILED",
      `Failed to apply migration ${fileNames[0]}`,
      error
    );
  } finally {
    if (rebuildsReferencedTable) {
      database.pragma("foreign_keys = ON");
    }
  }
}

function applyMigrationIfPending(
  database: SqliteConnection,
  migrationsDirectory: string,
  statements: MigrationStatements,
  fileName: string,
  temporalMode: TemporalDatabaseMode
): void {
  const version = parseMigrationVersion(fileName);
  if (
    version === TEMPORAL_VERIFIED_BIND_KEY_MIGRATION_VERSION &&
    statements.isAppliedStatement.get(TEMPORAL_OFFLINE_MIGRATION_VERSION) === undefined
  ) {
    return;
  }
  if (statements.isAppliedStatement.get(version) !== undefined) {
    return;
  }
  const migrationSql = fs.readFileSync(path.join(migrationsDirectory, fileName), "utf8");
  try {
    database.exec(migrationSql);
    switch (version) {
      case TEMPORAL_OFFLINE_MIGRATION_VERSION:
        migrateLegacyPathRelationsToTemporalCandidate(database, { selectionRequired: temporalMode === "candidate" });
        break;
      case TEMPORAL_VERIFIED_BIND_KEY_MIGRATION_VERSION:
        migrateVerifiedProjectionBindKey(database);
        break;
      case 13:
        migrateRetainedSourceChunks(database);
        break;
      case 15:
        migrateEmbeddingVectorValidity(database);
        break;
      case 28:
        rebuildSourceIndexLexicalDomains(database);
        break;
    }
    statements.markAppliedStatement.run(version, new Date().toISOString());
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw new StorageError("MIGRATION_FAILED", `Failed to apply migration ${fileName}`, error);
  }
}

export function isUninitializedDatabaseFile(filename: string): boolean {
  if (!fs.existsSync(filename)) {
    return true;
  }
  let database: SqliteConnection | undefined;
  try {
    database = openSqliteConnection(filename, {
      readonly: true,
      fileMustExist: true,
      timeout: UNINITIALIZED_DATABASE_PROBE_TIMEOUT_MS
    });
    const table = database.prepare(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'"
    ).get() as { readonly count: number };
    if (table.count === 0) {
      return true;
    }
    const ledger = database.prepare("SELECT COUNT(*) AS count FROM schema_version").get() as {
      readonly count: number;
    };
    return ledger.count === 0;
  } catch (error) {
    if (isSqliteNoSuchTableError(error)) {
      return true;
    }
    // Do not treat a lock as "initialized" and fail-close the runtime gate.
    if (isSqliteBusyError(error)) {
      throw error;
    }
    // Open/query failure is not proof the ledger is empty. Keep runtime so
    // assertRuntimeTemporalDatabaseReady fail-closes instead of applying v7.
    return false;
  } finally {
    if (database !== undefined) {
      try { database.close(); }
      catch (closeError) { throw new SqliteConnectionCleanupError(database, undefined, closeError); }
    }
  }
}

function parseMigrationVersion(fileName: string): number {
  const versionMatch = /^(\d+)-.+\.sql$/.exec(fileName);
  if (versionMatch === null) {
    throw new StorageError("MIGRATION_FAILED", `Invalid migration filename: ${fileName}`);
  }
  return Number(versionMatch[1]);
}

function assertContiguousMigrationFileVersions(fileNames: readonly string[]): void {
  const versions = fileNames.map(parseMigrationVersion);
  if (versions.length === 0) {
    throw new StorageError("MIGRATION_FAILED", "No SQLite migration files found.");
  }
  const unique = [...new Set(versions)].sort((left, right) => left - right);
  if (unique.length !== versions.length) {
    throw new StorageError("MIGRATION_FAILED", "Duplicate SQLite migration versions.");
  }
  if (unique[0] !== 1) {
    throw new StorageError("MIGRATION_FAILED", "SQLite migration versions must start at 1.");
  }
  for (let index = 1; index < unique.length; index += 1) {
    const expected = unique[index - 1]! + 1;
    if (unique[index] !== expected) {
      throw new StorageError(
        "MIGRATION_FAILED",
        `SQLite migration versions are not contiguous: missing ${expected}.`
      );
    }
  }
}
