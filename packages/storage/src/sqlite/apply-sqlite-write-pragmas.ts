import {
  DEFAULT_SQLITE_BUSY_RETRY_LIMIT,
  DEFAULT_SQLITE_BUSY_RETRY_SLEEP_MS,
  withSqliteBusyRetry
} from "./sqlite-busy-retry.js";

export interface SqliteWritePragmaConnection {
  pragma(source: string): unknown;
}

export interface ApplySqliteWritePragmasOptions {
  readonly busyTimeoutMs: number;
  /** Main connections set planner sampling; worker writers may omit. */
  readonly analysisLimit?: number;
}

export interface SqliteWriteQueueSessionPragmas {
  readonly cacheSizeKib: number;
  readonly tempStore: "FILE" | "MEMORY";
}

/** Shared WAL/write pragmas for main DB open and write-queue worker connections. */
export function applySqliteWritePragmas(
  connection: SqliteWritePragmaConnection,
  options: ApplySqliteWritePragmasOptions
): void {
  withSqliteBusyRetry(() => {
    // Timeout before journal_mode: WAL conversion can SQLITE_BUSY and ignore a later timeout.
    connection.pragma(`busy_timeout = ${options.busyTimeoutMs}`);
    connection.pragma("foreign_keys = ON");
    connection.pragma("journal_mode = WAL");
    connection.pragma("synchronous = NORMAL");
    if (options.analysisLimit !== undefined) {
      // Bounded planner sampling avoids multi-second full scans on large databases.
      connection.pragma(`analysis_limit = ${options.analysisLimit}`);
    }
  }, {
    retryLimit: DEFAULT_SQLITE_BUSY_RETRY_LIMIT,
    budgetMs: options.busyTimeoutMs,
    sleepMs: DEFAULT_SQLITE_BUSY_RETRY_SLEEP_MS
  });
}

export function isSqliteWriteQueueSessionPragmas(
  value: unknown
): value is SqliteWriteQueueSessionPragmas {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as { readonly cacheSizeKib?: unknown; readonly tempStore?: unknown };
  return (
    typeof record.cacheSizeKib === "number" &&
    Number.isSafeInteger(record.cacheSizeKib) &&
    record.cacheSizeKib > 0 &&
    (record.tempStore === "FILE" || record.tempStore === "MEMORY")
  );
}

export function applySqliteWriteQueueSessionPragmas(
  connection: SqliteWritePragmaConnection,
  pragmas: SqliteWriteQueueSessionPragmas
): void {
  // cache_size/temp_store are connection-scoped and must not ride the shared WAL path.
  connection.pragma(`temp_store = ${pragmas.tempStore}`);
  connection.pragma(`cache_size = -${pragmas.cacheSizeKib}`);
}
