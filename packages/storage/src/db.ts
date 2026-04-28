import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import BetterSqlite3 from "better-sqlite3";
import { StorageError } from "./errors.js";

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

function resolveMigrationsDirectory(): string {
  const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
  // Prefer the compiled output path first, then fall back to source for ts/vitest execution.
  const candidates = [
    path.join(currentDirectory, "migrations"),
    path.join(currentDirectory, "../src/migrations")
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new StorageError("MIGRATION_NOT_FOUND", "Unable to locate SQLite migration files.");
}
