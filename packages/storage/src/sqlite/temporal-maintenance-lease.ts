import BetterSqlite3 from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export interface TemporalMaintenanceLease {
  readonly lockFilename: string;
  release(): void;
}

/**
 * Holds an OS-released SQLite transaction for the lifetime of a temporal
 * maintenance operation. A crashed process loses the transaction automatically,
 * so no PID-based stale-lock deletion is needed.
 */
export function acquireTemporalMaintenanceLease(lockFilename: string): TemporalMaintenanceLease {
  const normalizedLockFilename = normalizeLockFilename(lockFilename);
  fs.mkdirSync(path.dirname(normalizedLockFilename), { recursive: true, mode: 0o700 });
  const database = new BetterSqlite3(normalizedLockFilename);
  let acquired = false;
  try {
    fs.chmodSync(normalizedLockFilename, 0o600);
    database.pragma("busy_timeout = 0");
    database.exec("BEGIN EXCLUSIVE");
    acquired = true;
  } catch (error) {
    database.close();
    throw new Error(`Temporal maintenance lease is unavailable: ${normalizedLockFilename}`, {
      cause: error
    });
  }

  let released = false;
  return Object.freeze({
    lockFilename: normalizedLockFilename,
    release: () => {
      if (released) return;
      released = true;
      try {
        if (acquired) database.exec("COMMIT");
      } finally {
        database.close();
      }
    }
  });
}

function normalizeLockFilename(lockFilename: string): string {
  if (typeof lockFilename !== "string" || lockFilename.trim().length === 0) {
    throw new Error("Temporal maintenance lease requires a non-empty lock path.");
  }
  return path.resolve(lockFilename);
}
