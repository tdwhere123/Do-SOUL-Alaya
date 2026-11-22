import { existsSync } from "node:fs";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { StorageError } from "../shared/errors.js";
import { withSqliteBusyRetry } from "./sqlite-busy-retry.js";

type SqliteConnection = InstanceType<typeof BetterSqlite3>;
type OpenOptions = ConstructorParameters<typeof BetterSqlite3>[1];

/** Retains an opened native handle when cleanup itself fails. */
export class SqliteConnectionCleanupError extends StorageError {
  public constructor(private readonly database: SqliteConnection, operationError: unknown, closeError: unknown) {
    super("DATABASE_OPEN_FAILED", "SQLite connection could not be closed.",
      new AggregateError([operationError, closeError], "Database operation and cleanup did not both complete."));
  }

  public retryDatabaseOpenCleanup(): void {
    if (this.database.open) this.database.close();
  }
}

const OPEN_RETRY_BUDGET_MS = 2_000;
const OPEN_RETRY_SLEEP_MS = 50;
const SQLITE_JOURNAL_RESERVE = "-journal".length;
export const READ_ONLY_BUSY_TIMEOUT_MS = 5_000;

export function openReadOnlySqliteConnection(filename: string): SqliteConnection {
  if (filename === ":memory:" || filename.trim().length === 0) {
    throw new StorageError(
      "DATABASE_OPEN_FAILED",
      "Read-only SQLite open requires an existing on-disk database file."
    );
  }
  let connection: SqliteConnection;
  try {
    connection = openSqliteConnection(filename, { readonly: true, fileMustExist: true });
  } catch (error) {
    throw new StorageError("DATABASE_OPEN_FAILED", `Failed to open read-only database: ${filename}`, error);
  }
  try {
    withSqliteBusyRetry(() => {
      // Timeout first: query_only can SQLITE_BUSY while a peer holds IMMEDIATE.
      connection.pragma(`busy_timeout = ${READ_ONLY_BUSY_TIMEOUT_MS}`);
      connection.pragma("query_only = ON");
    });
    return connection;
  } catch (error) {
    try { connection.close(); }
    catch (closeError) { throw new SqliteConnectionCleanupError(connection, error, closeError); }
    throw error;
  }
}

/** Windows MAX_PATH counts the journal sidecar. A long absolute path needs the extended prefix. */
export function sqliteHostFilename(filename: string, platform: NodeJS.Platform = process.platform): string {
  if (filename === ":memory:" || filename.startsWith("file:")) return filename;
  if (platform !== "win32") return filename;
  const absolute = path.win32.resolve(filename);
  if (absolute.length + SQLITE_JOURNAL_RESERVE + 1 < 260) return absolute;
  return path.win32.toNamespacedPath(absolute);
}

/** Windows can keep a sharing lock after close; SQLITE busy_timeout does not cover that. */
export function openSqliteConnection(filename: string, options?: OpenOptions): SqliteConnection {
  const deadline = Date.now() + OPEN_RETRY_BUDGET_MS;
  const hostFilename = sqliteHostFilename(filename);
  for (;;) {
    try {
      return new BetterSqlite3(hostFilename, options);
    } catch (error) {
      if (Date.now() >= deadline || !isTransientSqliteOpenError(filename, error)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, OPEN_RETRY_SLEEP_MS);
    }
  }
}

function isTransientSqliteOpenError(filename: string, error: unknown): boolean {
  const message = error instanceof Error ? `${error.message} ${error.name}` : String(error);
  if (/sqlite_busy|sqlite_locked|\bbusy\b|\blocked\b|eacces|\beperm\b|ebusy|sharing violation/i.test(message)) {
    return true;
  }
  // winOpen maps ERROR_SHARING_VIOLATION onto SQLITE_CANTOPEN / "unable to open".
  return existsSync(filename) && /cantopen|unable to open/i.test(message);
}
