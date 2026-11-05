import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import { acquireTemporalMaintenanceLease } from "../../sqlite/temporal-maintenance-lease.js";
import { removeTempDirectorySync } from "../temp-directory.js";

it("retains the real exclusive lock when close fails and releases only after retry", () => {
  const root = mkdtempSync(join(tmpdir(), "alaya-temporal-lease-close-"));
  const filename = join(root, "runtime.lock.sqlite");
  const lease = acquireTemporalMaintenanceLease(filename);
  const close = vi.spyOn(BetterSqlite3.prototype, "close").mockImplementationOnce(() => { throw new Error("injected close failure"); });
  try {
    expect(() => lease.release()).toThrow("injected close failure");
    expect(() => acquireTemporalMaintenanceLease(filename)).toThrow("Temporal maintenance lease is unavailable");
    lease.release();
    const successor = acquireTemporalMaintenanceLease(filename);
    successor.release();
  } finally {
    close.mockRestore();
    lease.release();
    removeTempDirectorySync(root);
  }
});

it("holds and releases the same exclusive lease beyond Windows MAX_PATH without changing its identity", () => {
  const root = mkdtempSync(join(tmpdir(), "alaya-temporal-lease-"));
  const filename = join(root, "a".repeat(90), "b".repeat(90), "c".repeat(90),
    "alaya.db.temporal-runtime.lock.sqlite");
  expect(filename.length).toBeGreaterThan(260);
  let release: (() => void) | undefined;
  try {
    const lease = acquireTemporalMaintenanceLease(filename);
    release = lease.release;
    expect(lease.lockFilename).toBe(filename);
    expect(lease.lockFilename.startsWith("\\\\?\\")).toBe(false);
    expect(() => acquireTemporalMaintenanceLease(filename)).toThrow("Temporal maintenance lease is unavailable");
    lease.release();
    const next = acquireTemporalMaintenanceLease(filename);
    release = next.release;
    expect(next.lockFilename).toBe(filename);
    next.release();
  } finally {
    release?.();
    removeTempDirectorySync(root);
  }
});
