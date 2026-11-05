import fs, { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { expect, it, vi } from "vitest";
import { initDatabase, type StorageDatabase } from "../../sqlite/db.js";
import { acquireTemporalMaintenanceLease } from "../../sqlite/temporal-maintenance-lease.js";

it("retains a failed reopen's native connection until close succeeds", () => {
  const directory = mkdtempSync(join(tmpdir(), "alaya-sqlite-reopen-cleanup-"));
  const filename = join(directory, "alaya.db"), lockfile = `${filename}.temporal-runtime.lock.sqlite`;
  const lease = acquireTemporalMaintenanceLease(lockfile);
  const database = initDatabase({ filename });
  database.close();
  const originalChmod = fs.chmodSync, originalClose = BetterSqlite3.prototype.close;
  let openingFailed = false, failures = 2;
  let native: StorageDatabase["connection"] | undefined;
  const chmod = vi.spyOn(fs, "chmodSync").mockImplementation((path, mode) => {
    if (String(path) === filename) { openingFailed = true; throw new Error("injected reopen failure"); }
    return originalChmod(path, mode);
  });
  const close = vi.spyOn(BetterSqlite3.prototype, "close").mockImplementation(function(this: StorageDatabase["connection"]) {
    if (openingFailed && this.name === filename && failures-- > 0) {
      native = this; throw new Error("injected native close failure");
    }
    return originalClose.call(this);
  });
  try {
    expect(() => database.reopenIfClosed()).toThrow("connection could not be closed");
    expect(native?.open).toBe(true);
    expect(database.isClosed()).toBe(false);
    expect(() => database.close()).toThrow("injected native close failure");
    expect(() => acquireTemporalMaintenanceLease(lockfile)).toThrow("unavailable");
    database.close();
    expect(native?.open).toBe(false);
    expect(database.isClosed()).toBe(true);
    lease.release();
    const successor = acquireTemporalMaintenanceLease(lockfile);
    successor.release();
  } finally {
    chmod.mockRestore(); close.mockRestore(); database.close(); lease.release();
    rmSync(directory, { recursive: true, force: true });
  }
});
