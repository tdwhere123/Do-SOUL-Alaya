import fs from "node:fs";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { StorageError } from "../shared/errors.js";
import { LruCache } from "./lru-cache.js";
import { applySqliteWritePragmas } from "./apply-sqlite-write-pragmas.js";
import {
  DEFAULT_SQLITE_BUSY_RETRY_LIMIT,
  DEFAULT_SQLITE_BUSY_RETRY_SLEEP_MS,
  withSqliteBusyRetry
} from "./sqlite-busy-retry.js";
import {
  assertCanonicalSchemaVersionTable,
  assertOrderedSafeMigrationVersions,
  assertRuntimeTemporalDatabaseReady,
  resolveTemporalDatabaseMode,
  type TemporalDatabaseMode
} from "./temporal-cutover-gate.js";
import { bindEmbeddingOverlayIfPresent } from "./embedding-overlay-bind.js";
import { restrictSqliteFileModes } from "./sqlite-file-modes.js";
import { openReadOnlySqliteConnection, openSqliteConnection, SqliteConnectionCleanupError } from "./open-sqlite-connection.js";
import type { SqliteWriteQueuePort } from "./write-queue/port.js";
import { registerRetainedSourceChunkDigest } from "./retained-source-chunk-digest.js";
import { registerUtcInstantComparison } from "./utc-instant-comparison.js";
import { isUninitializedDatabaseFile, knownMigrationMaxVersion, runMigrations } from "./run-migrations.js";
import { diagnosticWarn } from "@do-soul/alaya-protocol";

export { TEMPORAL_OFFLINE_MIGRATION_VERSION, type TemporalDatabaseMode } from "./temporal-cutover-gate.js";
export { isUninitializedDatabaseFile } from "./run-migrations.js";
export { selectRows } from "../repos/shared/select-rows.js";

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

const databaseCache = new LruCache<string, StorageDatabase>(MAX_DATABASE_CACHE_ENTRIES);

let sqliteWriteQueuePort: SqliteWriteQueuePort | null = null;

// Process-global for install/wiring convenience; prefer ctor/db-scoped injection on next seam touch.
export function configureSqliteWriteQueuePort(port: SqliteWriteQueuePort | null): void {
  sqliteWriteQueuePort = port;
}

export function getSqliteWriteQueuePort(): SqliteWriteQueuePort | null {
  return sqliteWriteQueuePort;
}
export class StorageDatabase {
  public readonly filename: string;
  public connection: SqliteConnection;
  readonly #accessMode: "readonly" | "readwrite";
  private closed = false;
  private failedReopenCleanup: SqliteConnectionCleanupError | null = null;
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
    this.#accessMode = connection.readonly ? "readonly" : "readwrite";
    registerRetainedSourceChunkDigest(connection);
    registerUtcInstantComparison(connection);
    this.reopenTemporalMode = reopenTemporalMode;
  }

  /** True only after both the active handle and any failed-reopen handle are retired. */
  public isClosed(): boolean {
    return this.closed && this.failedReopenCleanup === null;
  }

  public getConnectionVersion(): number {
    return this.connectionVersion;
  }

  public get accessMode(): "readonly" | "readwrite" {
    return this.#accessMode;
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
    this.closeFailedReopen();
    let database: SqliteConnection | undefined;
    try {
      if (this.#accessMode === "readonly") {
        database = openReadOnlySqliteConnection(this.filename);
      } else {
        if (this.filename !== ":memory:" && this.reopenTemporalMode === "runtime") {
          assertRuntimeTemporalDatabaseReady(this.filename, knownMigrationMaxVersion());
        }
        database = openDatabase(this.filename);
        configureDatabaseConnection(database, this.reopenBusyTimeoutMs);
        restrictSqliteFileModes(this.filename);
        bindEmbeddingOverlayIfPresent(database, this.filename);
      }
      registerRetainedSourceChunkDigest(database);
      registerUtcInstantComparison(database);
    } catch (error) {
      if (error instanceof SqliteConnectionCleanupError) this.failedReopenCleanup = error;
      else if (database !== undefined) {
        try { database.close(); }
        catch (closeError) {
          this.failedReopenCleanup = new SqliteConnectionCleanupError(database, error, closeError);
          throw this.failedReopenCleanup;
        }
      }
      throw error;
    }
    this.connection = database;
    this.connectionVersion += 1;
    this.closed = false;
    if (this.#accessMode === "readwrite" && this.filename !== ":memory:") {
      evictDatabaseCacheIfNeeded(this.filename);
      databaseCache.set(this.filename, this, {
        blocksEviction: (filename) => sqliteWriteQueuePort?.blocksEviction(filename) === true
      });
    }
  }

  private closeFailedReopen(): void {
    const pending = this.failedReopenCleanup;
    if (pending === null) return;
    pending.retryDatabaseOpenCleanup();
    this.failedReopenCleanup = null;
  }

  // Refresh query-planner statistics. Without stats SQLite mis-picks a
  // low-selectivity index (e.g. storage_tier) over workspace_id and near-full-
  // scans growing tables, so recall latency degrades O(total rows). analysis_limit
  // (set at init) caps sampling so this stays in the millisecond range even on a
  // multi-GB database; callers run it periodically as the database grows.
  public optimize(): void {
    if (this.closed || this.#accessMode === "readonly") {
      return;
    }
    this.connection.pragma("optimize");
  }

  public close(options?: Readonly<{ readonly optimize?: boolean }>): void {
    this.closeFailedReopen();
    if (this.closed) {
      return;
    }

    // Final stats refresh on close (SQLite-recommended) so a reopened DB starts
    // with a healthy plan. Slice snapshot sealing skips this so hashed bytes
    // cannot change after the last intentional write.
    if (this.#accessMode === "readwrite" && options?.optimize !== false) {
      try {
        this.connection.pragma("optimize");
      } catch {
        // best-effort; never block close on optimize
      }
    }
    this.connection.close();
    this.closed = true;

    // Independently wrapped connections must not evict the live cached owner.
    if (this.filename !== ":memory:" && databaseCache.get(this.filename) === this) {
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
    try { database.close(); }
    catch (closeError) { throw new SqliteConnectionCleanupError(database, undefined, closeError); }
  }
}

export function initDatabase(options: InitDatabaseOptions = {}): StorageDatabase {
  const filename = options.filename ?? ":memory:";
  const busyTimeoutMs = normalizeBusyTimeoutMs(options.busyTimeoutMs);

  if (filename !== ":memory:") {
    const cached = databaseCache.get(filename);
    if (cached !== undefined) {
      assertCachedBusyTimeoutCompatible(cached, options.busyTimeoutMs);
      const cachedMode = resolveTemporalDatabaseMode(filename, options.temporalMode);
      if (cachedMode === "runtime") {
        assertRuntimeTemporalDatabaseReady(filename, knownMigrationMaxVersion());
      }
      bindEmbeddingOverlayIfPresent(cached.connection, filename);
      return cached;
    }
  }

  return initializeUncachedDatabase(filename, options, busyTimeoutMs);
}

function initializeUncachedDatabase(
  filename: string,
  options: InitDatabaseOptions,
  busyTimeoutMs: number
): StorageDatabase {
  let temporalMode = resolveTemporalDatabaseMode(filename, options.temporalMode);
  // A peer still creating this file looks like "exists" to existsSync, but it
  // is not a legacy source. Empty/unledgers stay on the fresh-bootstrap path.
  if (options.temporalMode === undefined && filename !== ":memory:" && temporalMode === "runtime") {
    const uninitialized = withSqliteBusyRetry(
      () => isUninitializedDatabaseFile(filename),
      {
        retryLimit: DEFAULT_SQLITE_BUSY_RETRY_LIMIT,
        budgetMs: busyTimeoutMs,
        sleepMs: DEFAULT_SQLITE_BUSY_RETRY_SLEEP_MS
      }
    );
    if (uninitialized) {
      temporalMode = "fresh-bootstrap";
    }
  }

  if (filename !== ":memory:" && temporalMode === "runtime") {
    // This readonly gate must happen before openDatabase() or any PRAGMA can
    // mutate a legacy source database. Candidate conversion is offline-only.
    withSqliteBusyRetry(
      () => assertRuntimeTemporalDatabaseReady(filename, knownMigrationMaxVersion()),
      {
        retryLimit: DEFAULT_SQLITE_BUSY_RETRY_LIMIT,
        budgetMs: busyTimeoutMs,
        sleepMs: DEFAULT_SQLITE_BUSY_RETRY_SLEEP_MS
      }
    );
  }

  const database = openDatabase(filename);

  try {
    configureDatabaseConnection(database, busyTimeoutMs);
    registerRetainedSourceChunkDigest(database);
    registerUtcInstantComparison(database);
    restrictSqliteFileModes(filename);
    runMigrations(database, temporalMode, busyTimeoutMs);
    bindEmbeddingOverlayIfPresent(database, filename);
  } catch (error) {
    try { database.close(); }
    catch (closeError) { throw new SqliteConnectionCleanupError(database, error, closeError); }
    throw error;
  }

  let storageDatabase: StorageDatabase;
  try { storageDatabase = new StorageDatabase(filename, database, temporalMode, busyTimeoutMs); }
  catch (error) {
    try { database.close(); }
    catch (closeError) { throw new SqliteConnectionCleanupError(database, error, closeError); }
    throw error;
  }

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
  let database: SqliteConnection | undefined;
  try {
    if (filename !== ":memory:") {
      const directory = path.dirname(filename);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    }

    database = openSqliteConnection(filename);
    restrictSqliteFileModes(filename);
    return database;
  } catch (error) {
    if (database !== undefined) {
      try { database.close(); }
      catch (closeError) { throw new SqliteConnectionCleanupError(database, error, closeError); }
    }
    if (error instanceof StorageError) throw error;
    throw new StorageError("DATABASE_OPEN_FAILED", `Failed to open database: ${filename}`, error);
  }
}

function readPersistedMaxVersion(database: SqliteConnection): number | null {
  try {
    const row = database
      .prepare("SELECT MAX(version) AS max_version FROM schema_version")
      .get() as Readonly<{ max_version: number | null }> | undefined;
    return row?.max_version ?? null;
  } catch (error) {
    diagnosticWarn("sqlite/db: failed to read schema_version max; treating as unknown", { error: String(error) });
    return null;
  }
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
  const knownMaxVersion = knownMigrationMaxVersion();
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
