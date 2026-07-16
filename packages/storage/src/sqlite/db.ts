import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import BetterSqlite3 from "better-sqlite3";
import { StorageError } from "../shared/errors.js";
import { migrateEngineBindingApiKeysToCiphertext } from "../repos/shared/api-key-cipher.js";
import { migrateEmbeddingVectorValidity } from "./embedding-vector-validity-migration.js";
import { LruCache } from "./lru-cache.js";
import type { SqliteWriteQueuePort } from "./write-queue-port.js";

export type SqliteConnection = InstanceType<typeof BetterSqlite3>;

export interface InitDatabaseOptions {
  readonly filename?: string;
}

const MAX_DATABASE_CACHE_ENTRIES = 32;

const databaseCache = new LruCache<string, StorageDatabase>(MAX_DATABASE_CACHE_ENTRIES);

let sqliteWriteQueuePort: SqliteWriteQueuePort | null = null;

export function configureSqliteWriteQueuePort(port: SqliteWriteQueuePort | null): void {
  sqliteWriteQueuePort = port;
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

  public constructor(filename: string, connection: SqliteConnection) {
    this.filename = filename;
    this.connection = connection;
  }

  public isClosed(): boolean {
    return this.closed;
  }

  public getConnectionVersion(): number {
    return this.connectionVersion;
  }

  public reopenIfClosed(): void {
    if (!this.closed) {
      return;
    }
    const database = openDatabase(this.filename);
    database.pragma("foreign_keys = ON");
    database.pragma("journal_mode = WAL");
    database.pragma("busy_timeout = 5000");
    database.pragma("synchronous = NORMAL");
    database.pragma("analysis_limit = 400");
    this.connection = database;
    this.connectionVersion += 1;
    this.closed = false;
    if (this.filename !== ":memory:") {
      evictDatabaseCacheIfNeeded(this.filename);
      databaseCache.set(this.filename, this);
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

  public close(): void {
    if (this.closed) {
      return;
    }

    // Final stats refresh on close (SQLite-recommended) so a reopened DB starts
    // with a healthy plan.
    try {
      this.connection.pragma("optimize");
    } catch {
      // best-effort; never block close on optimize
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

function assertCanonicalSchemaVersionTable(database: SqliteConnection): void {
  const columns = database.prepare("PRAGMA table_info(schema_version)").all() as
    ReadonlyArray<Readonly<{
      cid: number;
      name: string;
      type: string;
      notnull: number;
      dflt_value: unknown;
      pk: number;
    }>>;
  const actual = columns.map(({ cid, name, type, notnull, dflt_value, pk }) => ({
    cid, name, type: type.toUpperCase(), notnull, dflt_value, pk
  }));
  const expected = [
    { cid: 0, name: "version", type: "INTEGER", notnull: 0, dflt_value: null, pk: 1 },
    { cid: 1, name: "applied_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 }
  ];
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("schema_version table is not canonical");
  }
}

function assertOrderedSafeMigrationVersions(versions: readonly unknown[]): asserts versions is number[] {
  let previous = 0;
  for (const version of versions) {
    if (!Number.isSafeInteger(version) || (version as number) <= 0) {
      throw new Error("schema_version ledger contains an unsafe migration version");
    }
    if ((version as number) <= previous) {
      throw new Error("schema_version ledger is not strictly ordered and unique");
    }
    previous = version as number;
  }
}

export function initDatabase(options: InitDatabaseOptions = {}): StorageDatabase {
  const filename = options.filename ?? ":memory:";

  if (filename !== ":memory:") {
    const cached = databaseCache.get(filename);
    if (cached !== undefined) {
      return cached;
    }
  }

  const database = openDatabase(filename);

  try {
    database.pragma("foreign_keys = ON");
    // SQLite hardening for concurrent + crash-safe local-first usage.
    // WAL is silently ignored on :memory: databases, so no branch is needed.
    // - journal_mode=WAL: readers no longer block writers.
    // - busy_timeout=5000: 5s wait window before SQLITE_BUSY surfaces, reducing
    //   spurious failures when a daemon write coincides with a CLI read.
    // - synchronous=NORMAL: durable enough for WAL while halving fsync cost.
    database.pragma("journal_mode = WAL");
    database.pragma("busy_timeout = 5000");
    database.pragma("synchronous = NORMAL");
    // Cap PRAGMA optimize/ANALYZE sampling so a stats refresh stays fast (ms)
    // on a large DB instead of a multi-second full scan. Persists per connection.
    database.pragma("analysis_limit = 400");
    runMigrations(database);
  } catch (error) {
    database.close();
    throw error;
  }

  const storageDatabase = new StorageDatabase(filename, database);

  if (filename !== ":memory:") {
    evictDatabaseCacheIfNeeded(filename);
    databaseCache.set(filename, storageDatabase);
  }

  return storageDatabase;
}

function openDatabase(filename: string): SqliteConnection {
  try {
    if (filename !== ":memory:") {
      const directory = path.dirname(filename);
      fs.mkdirSync(directory, { recursive: true });
    }

    return new BetterSqlite3(filename);
  } catch (error) {
    throw new StorageError("DATABASE_OPEN_FAILED", `Failed to open database: ${filename}`, error);
  }
}

function runMigrations(database: SqliteConnection): void {
  const migrationsDirectory = resolveMigrationsDirectory();
  const migrationFiles = listMigrationFiles(migrationsDirectory);
  ensureSchemaVersionTable(database);
  const knownMaxVersion = computeKnownMaxVersion(migrationFiles);
  assertSchemaVersionNotAhead(database, knownMaxVersion);
  const statements = prepareMigrationStatements(database);

  for (const fileName of migrationFiles) {
    applyMigrationIfPending(database, migrationsDirectory, statements, fileName);
  }
}

function listMigrationFiles(migrationsDirectory: string): readonly string[] {
  return fs
    .readdirSync(migrationsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();
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

function prepareMigrationStatements(database: SqliteConnection): MigrationStatements {
  return {
    isAppliedStatement: database.prepare("SELECT 1 FROM schema_version WHERE version = ? LIMIT 1"),
    markAppliedStatement: database.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)")
  };
}

function applyMigrationIfPending(
  database: SqliteConnection,
  migrationsDirectory: string,
  statements: MigrationStatements,
  fileName: string
): void {
  const version = parseMigrationVersion(fileName);
  if (statements.isAppliedStatement.get(version) !== undefined) {
    return;
  }
  const migrationSql = fs.readFileSync(path.join(migrationsDirectory, fileName), "utf8");
  try {
    database.transaction(() => {
      database.exec(migrationSql);
      runDataMigrationIfPresent(database, version);
      statements.markAppliedStatement.run(version, new Date().toISOString());
    })();
  } catch (error) {
    throw new StorageError("MIGRATION_FAILED", `Failed to apply migration ${fileName}`, error);
  }
}

const DATA_MIGRATIONS: Readonly<Partial<Record<number, (database: SqliteConnection) => void>>> = {
  104: migrateEngineBindingApiKeysToCiphertext,
  107: migrateEmbeddingVectorValidity
};

function runDataMigrationIfPresent(database: SqliteConnection, version: number): void {
  const migrate = DATA_MIGRATIONS[version];
  if (migrate !== undefined) {
    migrate(database);
  }
}

function parseMigrationVersion(fileName: string): number {
  const versionMatch = /^(\d+)-.+\.sql$/.exec(fileName);
  if (versionMatch === null) {
    throw new StorageError("MIGRATION_FAILED", `Invalid migration filename: ${fileName}`);
  }
  return Number(versionMatch[1]);
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
  const migrationFiles = fs
    .readdirSync(migrationsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name);
  const knownMaxVersion = computeKnownMaxVersion(migrationFiles);
  const persistedMaxVersion = readPersistedMaxVersion(database.connection);
  return {
    persistedMaxVersion,
    knownMaxVersion,
    schemaOk: persistedMaxVersion === knownMaxVersion && knownMaxVersion > 0
  };
}

function computeKnownMaxVersion(migrationFiles: readonly string[]): number {
  let maxVersion = 0;
  for (const fileName of migrationFiles) {
    const versionMatch = /^(\d+)-.+\.sql$/.exec(fileName);
    if (versionMatch === null) {
      continue;
    }
    const version = Number(versionMatch[1]);
    if (Number.isFinite(version) && version > maxVersion) {
      maxVersion = version;
    }
  }
  return maxVersion;
}

function resolveMigrationsDirectory(): string {
  const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
  // Source and compiled layouts both place migrations next to sqlite/.
  const candidates = [
    path.join(currentDirectory, "../migrations"),
    path.join(currentDirectory, "../../src/migrations")
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new StorageError("MIGRATION_NOT_FOUND", "Unable to locate SQLite migration files.");
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
