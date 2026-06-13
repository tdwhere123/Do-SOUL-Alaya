import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import BetterSqlite3 from "better-sqlite3";
import { StorageError, type StorageErrorCode } from "../shared/errors.js";

export type SqliteConnection = InstanceType<typeof BetterSqlite3>;

export interface InitDatabaseOptions {
  readonly filename?: string;
}

const databaseCache = new Map<string, StorageDatabase>();

export class StorageDatabase {
  public readonly filename: string;
  public readonly connection: SqliteConnection;
  private closed = false;

  public constructor(filename: string, connection: SqliteConnection) {
    this.filename = filename;
    this.connection = connection;
  }

  public close(): void {
    if (this.closed) {
      return;
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
    runMigrations(database);
  } catch (error) {
    database.close();
    throw error;
  }

  const storageDatabase = new StorageDatabase(filename, database);

  if (filename !== ":memory:") {
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
  const migrationFiles = fs
    .readdirSync(migrationsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();

  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  // Forward-compatibility guard: if the database was previously written by a
  // newer Alaya release whose migration set extends past what this binary
  // ships, refuse to open it. Running missing-but-newer migrations would be
  // impossible (we don't have the SQL), and continuing as if nothing happened
  // would let an older binary mutate a newer schema. Best to fail loudly so
  // the operator either upgrades the binary or restores a matching backup.
  const knownMaxVersion = computeKnownMaxVersion(migrationFiles);
  const persistedMaxVersionRow = database
    .prepare("SELECT MAX(version) AS max_version FROM schema_version")
    .get() as Readonly<{ max_version: number | null }> | undefined;
  const persistedMaxVersion = persistedMaxVersionRow?.max_version ?? null;

  if (persistedMaxVersion !== null && persistedMaxVersion > knownMaxVersion) {
    throw new StorageError(
      "STORAGE_VERSION_AHEAD" as StorageErrorCode,
      `Database schema version ${persistedMaxVersion} is ahead of this binary's known max ${knownMaxVersion}. ` +
        "Upgrade Alaya or restore a database matching this version."
    );
  }

  const isAppliedStatement = database.prepare(
    "SELECT 1 FROM schema_version WHERE version = ? LIMIT 1"
  );
  const markAppliedStatement = database.prepare(
    "INSERT INTO schema_version (version, applied_at) VALUES (?, ?)"
  );

  for (const fileName of migrationFiles) {
    const versionMatch = /^(\d+)-.+\.sql$/.exec(fileName);

    if (versionMatch === null) {
      throw new StorageError("MIGRATION_FAILED", `Invalid migration filename: ${fileName}`);
    }

    const version = Number(versionMatch[1]);
    const alreadyApplied = isAppliedStatement.get(version);

    if (alreadyApplied !== undefined) {
      continue;
    }

    const migrationSql = fs.readFileSync(path.join(migrationsDirectory, fileName), "utf8");

    try {
      database.transaction(() => {
        database.exec(migrationSql);
        markAppliedStatement.run(version, new Date().toISOString());
      })();
    } catch (error) {
      throw new StorageError("MIGRATION_FAILED", `Failed to apply migration ${fileName}`, error);
    }
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
