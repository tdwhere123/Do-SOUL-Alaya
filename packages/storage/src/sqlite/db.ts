import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import BetterSqlite3 from "better-sqlite3";
import { StorageError } from "../shared/errors.js";
import { LruCache } from "./lru-cache.js";

export type SqliteConnection = InstanceType<typeof BetterSqlite3>;

export interface InitDatabaseOptions {
  readonly filename?: string;
}

const MAX_DATABASE_CACHE_ENTRIES = 32;

const databaseCache = new LruCache<string, StorageDatabase>(MAX_DATABASE_CACHE_ENTRIES);

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
  const persistedMaxVersion = readPersistedMaxVersion(database);
  if (persistedMaxVersion !== null && persistedMaxVersion > knownMaxVersion) {
    throw new StorageError(
      "STORAGE_VERSION_AHEAD",
      `Database schema version ${persistedMaxVersion} is ahead of this binary's known max ${knownMaxVersion}. ` +
        "Upgrade Alaya or restore a database matching this version."
    );
  }
}

function readPersistedMaxVersion(database: SqliteConnection): number | null {
  const row = database
    .prepare("SELECT MAX(version) AS max_version FROM schema_version")
    .get() as Readonly<{ max_version: number | null }> | undefined;
  return row?.max_version ?? null;
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
      statements.markAppliedStatement.run(version, new Date().toISOString());
    })();
  } catch (error) {
    throw new StorageError("MIGRATION_FAILED", `Failed to apply migration ${fileName}`, error);
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
  let persistedMaxVersion: number | null = null;
  try {
    const row = database.connection
      .prepare("SELECT MAX(version) AS max_version FROM schema_version")
      .get() as { max_version: number | null } | undefined;
    persistedMaxVersion = row?.max_version ?? null;
  } catch {
    persistedMaxVersion = null;
  }
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
  while (databaseCache.size >= MAX_DATABASE_CACHE_ENTRIES) {
    databaseCache.deleteOldest()?.close();
  }
}
