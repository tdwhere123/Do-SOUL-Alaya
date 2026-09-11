import { existsSync } from "node:fs";
import BetterSqlite3 from "better-sqlite3";

type SqliteConnection = InstanceType<typeof BetterSqlite3>;
type OpenOptions = ConstructorParameters<typeof BetterSqlite3>[1];

const OPEN_RETRY_BUDGET_MS = 2_000;
const OPEN_RETRY_SLEEP_MS = 50;

/** Windows can keep a sharing lock after close; SQLITE busy_timeout does not cover that. */
export function openSqliteConnection(filename: string, options?: OpenOptions): SqliteConnection {
  const deadline = Date.now() + OPEN_RETRY_BUDGET_MS;
  for (;;) {
    try {
      return new BetterSqlite3(filename, options);
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
