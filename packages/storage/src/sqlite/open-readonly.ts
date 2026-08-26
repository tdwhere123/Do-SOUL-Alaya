import BetterSqlite3 from "better-sqlite3";
import { StorageError } from "../shared/errors.js";
import { StorageDatabase, type SqliteConnection } from "./db.js";

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
    connection = new BetterSqlite3(filename, { readonly: true, fileMustExist: true });
  } catch (error) {
    throw new StorageError(
      "DATABASE_OPEN_FAILED",
      `Failed to open read-only database: ${filename}`,
      error
    );
  }

  try {
    connection.pragma("query_only = ON");
    return new StorageDatabase(filename, connection, "runtime");
  } catch (error) {
    connection.close();
    throw error;
  }
}
