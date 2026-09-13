import { StorageError } from "../shared/errors.js";
import { StorageDatabase, type SqliteConnection } from "./db.js";
import { openSqliteConnection } from "./open-sqlite-connection.js";

export const READ_ONLY_BUSY_TIMEOUT_MS = 5_000;
const SQLITE_BUSY_PRIMARY_CODE = 5;
const READ_ONLY_BUSY_RETRY_LIMIT = 5;
const READ_ONLY_BUSY_RETRY_SLEEP_MS = 20;

/**
 * Open an existing SQLite file with SQLITE_OPEN_READONLY. No mkdir, no
 * migrations, no write pragmas. Fail closed if the file cannot be opened
 * read-only.
 */
export function openReadOnlyDatabase(filename: string): StorageDatabase {
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
    throw new StorageError(
      "DATABASE_OPEN_FAILED",
      `Failed to open read-only database: ${filename}`,
      error
    );
  }

  try {
    withSqliteBusyRetry(() => {
      connection.pragma("query_only = ON");
      connection.pragma(`busy_timeout = ${READ_ONLY_BUSY_TIMEOUT_MS}`);
    });
    return new StorageDatabase(filename, connection, "runtime");
  } catch (error) {
    connection.close();
    throw error;
  }
}

export function withSqliteBusyRetry<T>(operation: () => T): T {
  let lastError: unknown;
  for (let attempt = 0; attempt < READ_ONLY_BUSY_RETRY_LIMIT; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      lastError = error;
      if (!isSqliteBusyError(error) || attempt === READ_ONLY_BUSY_RETRY_LIMIT - 1) {
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, READ_ONLY_BUSY_RETRY_SLEEP_MS);
    }
  }
  throw lastError;
}

function isSqliteBusyError(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "errcode" in error) {
    const errcode = (error as { readonly errcode?: unknown }).errcode;
    if (typeof errcode === "number" && (errcode & 0xff) === SQLITE_BUSY_PRIMARY_CODE) {
      return true;
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  return /sqlite_busy|\bbusy\b/i.test(message);
}
