import { StorageDatabase } from "./db.js";
import { openReadOnlySqliteConnection } from "./open-sqlite-connection.js";

export { READ_ONLY_BUSY_TIMEOUT_MS } from "./open-sqlite-connection.js";
export { withSqliteBusyRetry } from "./sqlite-busy-retry.js";

/**
 * Open an existing SQLite file with SQLITE_OPEN_READONLY. No mkdir, no
 * migrations, no write pragmas. Fail closed if the file cannot be opened
 * read-only.
 */
export function openReadOnlyDatabase(filename: string): StorageDatabase {
  const connection = openReadOnlySqliteConnection(filename);
  try {
    return new StorageDatabase(filename, connection);
  } catch (error) {
    connection.close();
    throw error;
  }
}
