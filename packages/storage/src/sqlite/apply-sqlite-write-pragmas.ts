export interface SqliteWritePragmaConnection {
  pragma(source: string): unknown;
}

export interface ApplySqliteWritePragmasOptions {
  readonly busyTimeoutMs: number;
  /** Main connections set planner sampling; worker writers may omit. */
  readonly analysisLimit?: number;
}

/** Shared WAL/write pragmas for main DB open and write-queue worker connections. */
export function applySqliteWritePragmas(
  connection: SqliteWritePragmaConnection,
  options: ApplySqliteWritePragmasOptions
): void {
  connection.pragma("foreign_keys = ON");
  // WAL keeps readers independent; timeout bounds lock waits for writers.
  connection.pragma("journal_mode = WAL");
  connection.pragma(`busy_timeout = ${options.busyTimeoutMs}`);
  connection.pragma("synchronous = NORMAL");
  if (options.analysisLimit !== undefined) {
    // Bounded planner sampling avoids multi-second full scans on large databases.
    connection.pragma(`analysis_limit = ${options.analysisLimit}`);
  }
}
