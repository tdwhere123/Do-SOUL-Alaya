import fs from "node:fs";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { StorageError } from "../shared/errors.js";
import { LruCache } from "./lru-cache.js";
import { applySqliteWritePragmas } from "./apply-sqlite-write-pragmas.js";
import {
  TEMPORAL_OFFLINE_MIGRATION_VERSION,
  assertCanonicalSchemaVersionTable,
  assertOrderedSafeMigrationVersions,
  assertRuntimeTemporalDatabaseReady,
  computeKnownMaxVersion,
  listMigrationFiles,
  migrateLegacyPathRelationsToTemporalCandidate,
  resolveMigrationsDirectory,
  resolveTemporalDatabaseMode,
  type TemporalDatabaseMode
} from "./temporal-cutover-gate.js";
import {
  TEMPORAL_VERIFIED_BIND_KEY_MIGRATION_VERSION,
  migrateVerifiedProjectionBindKey
} from "./temporal-verified-bind-key.js";
import { bindEmbeddingOverlayIfPresent } from "./embedding-overlay-bind.js";
import { restrictSqliteFileModes } from "./sqlite-file-modes.js";
import { openSqliteConnection } from "./open-sqlite-connection.js";
import type { SqliteWriteQueuePort } from "./write-queue/port.js";
import { registerRetainedSourceChunkDigest } from "./retained-source-chunk-digest.js";
import { migrateRetainedSourceChunks } from "./retained-source-migration.js";
import { migrateEmbeddingVectorValidity } from "./embedding-vector-validity-migration.js";
import { parseRows, type RowParser } from "../repos/shared/parse-row.js";

export { TEMPORAL_OFFLINE_MIGRATION_VERSION, type TemporalDatabaseMode } from "./temporal-cutover-gate.js";

export type SqliteConnection = InstanceType<typeof BetterSqlite3>;

export interface InitDatabaseOptions {
  readonly filename?: string;
  /** Runtime only opens a verified temporal schema; offline migration is explicit. */
  readonly temporalMode?: TemporalDatabaseMode;
  /** Maximum SQLite lock wait for this connection. Defaults to 5 seconds. */
  readonly busyTimeoutMs?: number;
}

const MAX_DATABASE_CACHE_ENTRIES = 32;
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const MAX_SQLITE_BUSY_TIMEOUT_MS = 2_147_483_647;
const MEMORY_ENTRY_ENUM_CHECK_MIGRATION_VERSION = 14;
const EMBEDDING_VECTOR_VALIDITY_MIGRATION_VERSION = 15;

const databaseCache = new LruCache<string, StorageDatabase>(MAX_DATABASE_CACHE_ENTRIES);

let sqliteWriteQueuePort: SqliteWriteQueuePort | null = null;

// Process-global for install/wiring convenience; prefer ctor/db-scoped injection on next seam touch.
export function configureSqliteWriteQueuePort(port: SqliteWriteQueuePort | null): void {
  sqliteWriteQueuePort = port;
}

export function getSqliteWriteQueuePort(): SqliteWriteQueuePort | null {
  return sqliteWriteQueuePort;
}

interface MigrationStatements {
  readonly isAppliedStatement: {
    get(...args: readonly unknown[]): unknown;
  };
  readonly markAppliedStatement: {
    run(...args: readonly unknown[]): unknown;
  };
}

export class StorageDatabase {
  public readonly filename: string;
  public connection: SqliteConnection;
  private closed = false;
  private connectionVersion = 0;
  private reopenTemporalMode: TemporalDatabaseMode;

  public constructor(
    filename: string,
    connection: SqliteConnection,
    reopenTemporalMode: TemporalDatabaseMode = "runtime",
    private readonly reopenBusyTimeoutMs = DEFAULT_BUSY_TIMEOUT_MS
  ) {
    this.filename = filename;
    this.connection = connection;
    registerRetainedSourceChunkDigest(connection);
    this.reopenTemporalMode = reopenTemporalMode;
  }

  public isClosed(): boolean {
    return this.closed;
  }

  public getConnectionVersion(): number {
    return this.connectionVersion;
  }

  public getBusyTimeoutMs(): number {
    return this.reopenBusyTimeoutMs;
  }

  /** Selection promotes an offline/candidate handle to normal runtime reopen checks. */
  public markRuntimeTemporalMode(): void {
    this.reopenTemporalMode = "runtime";
  }

  public reopenIfClosed(): void {
    if (!this.closed) {
      return;
    }
    if (this.filename !== ":memory:" && this.reopenTemporalMode === "runtime") {
      assertRuntimeTemporalDatabaseReady(this.filename, knownMigrationMaxVersion());
    }
    const database = openDatabase(this.filename);
    applySqliteWritePragmas(database, {
      busyTimeoutMs: this.reopenBusyTimeoutMs,
      analysisLimit: 400
    });
    restrictSqliteFileModes(this.filename);
    bindEmbeddingOverlayIfPresent(database, this.filename);
    this.connection = database;
    registerRetainedSourceChunkDigest(database);
    this.connectionVersion += 1;
    this.closed = false;
    if (this.filename !== ":memory:") {
      evictDatabaseCacheIfNeeded(this.filename);
      databaseCache.set(this.filename, this, {
        blocksEviction: (filename) => sqliteWriteQueuePort?.blocksEviction(filename) === true
      });
    }
  }

  // Refresh query-planner statistics. Without stats SQLite mis-picks a
  // low-selectivity index (e.g. storage_tier) over workspace_id and near-full-
  // scans growing tables, so recall latency degrades O(total rows). analysis_limit
  // (set at init) caps sampling so this stays in the millisecond range even on a
  // multi-GB database; callers run it periodically as the database grows.
  public optimize(): void {
    if (this.closed) {
      return;
    }
    this.connection.pragma("optimize");
  }

  public close(options?: Readonly<{ readonly optimize?: boolean }>): void {
    if (this.closed) {
      return;
    }

    // Final stats refresh on close (SQLite-recommended) so a reopened DB starts
    // with a healthy plan. Slice snapshot sealing skips this so hashed bytes
    // cannot change after the last intentional write.
    if (options?.optimize !== false) {
      try {
        this.connection.pragma("optimize");
      } catch {
        // best-effort; never block close on optimize
      }
    }
    this.connection.close();
    this.closed = true;

    if (this.filename !== ":memory:") {
      databaseCache.delete(this.filename);
    }
  }
}

/** Close a cached DB handle if present. Never opens or migrates a path. */
export function closeCachedDatabase(filename: string): void {
  if (filename === ":memory:") {
    return;
  }
  const cached = databaseCache.get(filename);
  if (cached === undefined) {
    return;
  }
  cached.close();
}

export function readSchemaMigrationLedger(
  filename: string
): readonly number[] {
  const database = new BetterSqlite3(filename, {
    readonly: true,
    fileMustExist: true
  });
  try {
    assertCanonicalSchemaVersionTable(database);
    const rows = database.prepare(
      "SELECT version FROM schema_version ORDER BY version ASC"
    ).all() as ReadonlyArray<Readonly<{ version: unknown }>>;
    if (rows.length === 0) throw new Error("schema_version ledger is empty");
    const versions = rows.map((row) => row.version);
    assertOrderedSafeMigrationVersions(versions);
    return Object.freeze(versions as number[]);
  } finally {
    database.close();
  }
}

export function initDatabase(options: InitDatabaseOptions = {}): StorageDatabase {
  const filename = options.filename ?? ":memory:";
  const busyTimeoutMs = normalizeBusyTimeoutMs(options.busyTimeoutMs);
  let temporalMode = resolveTemporalDatabaseMode(filename, options.temporalMode);
  // A peer still creating this file looks like "exists" to existsSync, but it
  // is not a legacy source. Empty/unledgers stay on the fresh-bootstrap path.
  if (
    options.temporalMode === undefined &&
    filename !== ":memory:" &&
    temporalMode === "runtime" &&
    isUninitializedDatabaseFile(filename)
  ) {
    temporalMode = "fresh-bootstrap";
  }

  if (filename !== ":memory:") {
    const cached = databaseCache.get(filename);
    if (cached !== undefined) {
      assertCachedBusyTimeoutCompatible(cached, options.busyTimeoutMs);
      if (temporalMode === "runtime") {
        assertRuntimeTemporalDatabaseReady(filename, knownMigrationMaxVersion());
      }
      bindEmbeddingOverlayIfPresent(cached.connection, filename);
      return cached;
    }
    if (temporalMode === "runtime") {
      // This readonly gate must happen before openDatabase() or any PRAGMA can
      // mutate a legacy source database. Candidate conversion is offline-only.
      assertRuntimeTemporalDatabaseReady(filename, knownMigrationMaxVersion());
    }
  }

  const database = openDatabase(filename);

  try {
    configureDatabaseConnection(database, busyTimeoutMs);
    registerRetainedSourceChunkDigest(database);
    restrictSqliteFileModes(filename);
    runMigrations(database, temporalMode);
    bindEmbeddingOverlayIfPresent(database, filename);
  } catch (error) {
    database.close();
    throw error;
  }

  const storageDatabase = new StorageDatabase(filename, database, temporalMode, busyTimeoutMs);

  if (filename !== ":memory:") {
    evictDatabaseCacheIfNeeded(filename);
    databaseCache.set(filename, storageDatabase, {
      blocksEviction: (cachedFilename) =>
        sqliteWriteQueuePort?.blocksEviction(cachedFilename) === true
    });
  }

  return storageDatabase;
}

function configureDatabaseConnection(
  database: SqliteConnection,
  busyTimeoutMs: number
): void {
  applySqliteWritePragmas(database, {
    busyTimeoutMs,
    analysisLimit: 400
  });
}

function normalizeBusyTimeoutMs(value: number | undefined): number {
  if (value === undefined) return DEFAULT_BUSY_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_SQLITE_BUSY_TIMEOUT_MS) {
    throw new StorageError(
      "VALIDATION_FAILED",
      "SQLite busy timeout must be a non-negative safe integer."
    );
  }
  return value;
}

function assertCachedBusyTimeoutCompatible(
  cached: StorageDatabase,
  requested: number | undefined
): void {
  if (requested === undefined || cached.getBusyTimeoutMs() === requested) return;
  throw new StorageError(
    "CONFLICT",
    "Cached SQLite connection uses a different busy timeout."
  );
}

function openDatabase(filename: string): SqliteConnection {
  try {
    if (filename !== ":memory:") {
      const directory = path.dirname(filename);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    }

    const database = openSqliteConnection(filename);
    restrictSqliteFileModes(filename);
    return database;
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw new StorageError("DATABASE_OPEN_FAILED", `Failed to open database: ${filename}`, error);
  }
}

function runMigrations(database: SqliteConnection, temporalMode: TemporalDatabaseMode): void {
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
  applyMigrationBatch(database, migrationsDirectory, beforeRebuild, temporalMode, false);
  applyMigrationBatch(database, migrationsDirectory, rebuild, temporalMode, true);
  applyMigrationBatch(database, migrationsDirectory, afterRebuild, temporalMode, false);
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

function readPersistedMaxVersion(database: SqliteConnection): number | null {
  try {
    const row = database
      .prepare("SELECT MAX(version) AS max_version FROM schema_version")
      .get() as Readonly<{ max_version: number | null }> | undefined;
    return row?.max_version ?? null;
  } catch (error) {
    console.warn("sqlite/db: failed to read schema_version max; treating as unknown", error);
    return null;
  }
}

function isSqliteNoSuchTableError(error: unknown): boolean {
  return error instanceof Error && /no such table/i.test(error.message);
}

function knownMigrationMaxVersion(): number {
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
  rebuildsMemoryEntries: boolean
): void {
  if (fileNames.length === 0) {
    return;
  }
  if (rebuildsMemoryEntries) {
    // PRAGMA foreign_keys is a no-op inside a transaction; DROP/rename of
    // memory_entries needs incoming FKs disabled for the official rebuild.
    database.pragma("foreign_keys = OFF");
  }
  try {
    database.transaction(() => {
      ensureSchemaVersionTable(database);
      const statements = prepareMigrationStatements(database);
      for (const fileName of fileNames) {
        applyMigrationIfPending(database, migrationsDirectory, statements, fileName, temporalMode);
      }
    }).immediate();
    if (rebuildsMemoryEntries) {
      const violations = database.pragma("foreign_key_check") as readonly unknown[];
      if (violations.length > 0) {
        throw new StorageError(
          "MIGRATION_FAILED",
          `Failed to apply memory entry enum CHECKs: foreign key check found ${violations.length} violation(s).`
        );
      }
    }
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw new StorageError(
      "MIGRATION_FAILED",
      `Failed to apply migration ${fileNames[0]}`,
      error
    );
  } finally {
    if (rebuildsMemoryEntries) {
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
    runDataMigrationIfPresent(database, version, temporalMode);
    statements.markAppliedStatement.run(version, new Date().toISOString());
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw new StorageError("MIGRATION_FAILED", `Failed to apply migration ${fileName}`, error);
  }
}

function isUninitializedDatabaseFile(filename: string): boolean {
  if (!fs.existsSync(filename)) {
    return true;
  }
  let database: SqliteConnection | undefined;
  try {
    database = new BetterSqlite3(filename, { readonly: true, fileMustExist: true });
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
  } catch {
    return true;
  } finally {
    database?.close();
  }
}

const DATA_MIGRATIONS: Readonly<Partial<Record<
  number,
  (database: SqliteConnection, temporalMode: TemporalDatabaseMode) => void
>>> = {
  [TEMPORAL_OFFLINE_MIGRATION_VERSION]: (database, temporalMode) => {
    migrateLegacyPathRelationsToTemporalCandidate(database, {
      selectionRequired: temporalMode === "candidate"
    });
  },
  [TEMPORAL_VERIFIED_BIND_KEY_MIGRATION_VERSION]: (database) => {
    migrateVerifiedProjectionBindKey(database);
  },
  13: migrateRetainedSourceChunks,
  [EMBEDDING_VECTOR_VALIDITY_MIGRATION_VERSION]: migrateEmbeddingVectorValidity
};

function runDataMigrationIfPresent(
  database: SqliteConnection,
  version: number,
  temporalMode: TemporalDatabaseMode
): void {
  if (version === TEMPORAL_OFFLINE_MIGRATION_VERSION && temporalMode === "runtime") {
    throw new StorageError(
      "CONFLICT",
      "Temporal relation migration is offline-only and cannot run in runtime mode."
    );
  }
  const migrate = DATA_MIGRATIONS[version];
  if (migrate !== undefined) {
    migrate(database, temporalMode);
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

export function selectRows<T>(
  database: SqliteConnection,
  sql: string,
  args: readonly unknown[] | Record<string, unknown>,
  parser: RowParser<T>,
  label: string
): readonly T[] {
  const statement = database.prepare(sql);
  const values = Array.isArray(args) ? statement.all(...args) : statement.all(args);
  return parseRows(values, parser, label);
}

/**
 * Read-only schema-version probe for diagnostic surfaces (alaya doctor).
 * Returns the persisted max migration version vs the binary's known max,
 * so doctor can report `schema_ok: true` only when the running binary's
 * migration set fully matches the database. Does not run migrations or
 * mutate state.
 */
export function getCurrentSchemaSummary(
  database: StorageDatabase
): Readonly<{
  readonly persistedMaxVersion: number | null;
  readonly knownMaxVersion: number;
  readonly schemaOk: boolean;
}> {
  const migrationsDirectory = resolveMigrationsDirectory();
  const migrationFiles = listMigrationFiles(migrationsDirectory);
  const knownMaxVersion = computeKnownMaxVersion(migrationFiles);
  const persistedMaxVersion = readPersistedMaxVersion(database.connection);
  return {
    persistedMaxVersion,
    knownMaxVersion,
    schemaOk: persistedMaxVersion === knownMaxVersion && knownMaxVersion > 0
  };
}

function evictDatabaseCacheIfNeeded(incomingFilename: string): void {
  if (databaseCache.has(incomingFilename)) {
    return;
  }
  const queue = sqliteWriteQueuePort;
  let spin = 0;
  const maxSpin = databaseCache.size + 1;
  while (databaseCache.size >= MAX_DATABASE_CACHE_ENTRIES && spin < maxSpin) {
    spin += 1;
    const oldestKey = databaseCache.oldestKey();
    if (oldestKey === undefined) {
      break;
    }
    if (queue?.blocksEviction(oldestKey) === true) {
      databaseCache.get(oldestKey);
      continue;
    }
    databaseCache.deleteOldest();
    break;
  }
}
