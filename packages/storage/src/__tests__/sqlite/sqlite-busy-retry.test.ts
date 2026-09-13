import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SQLITE_BUSY_RETRY_LIMIT,
  isSqliteBusyError,
  withSqliteBusyRetry
} from "../../sqlite/sqlite-busy-retry.js";

function sqliteBusyError(message: string): Error & { errcode: number; code: string } {
  return Object.assign(new Error(message), { errcode: 5, code: "SQLITE_BUSY" });
}

describe("isSqliteBusyError", () => {
  it("matches SQLITE_BUSY and SQLITE_LOCKED codes", () => {
    expect(isSqliteBusyError(Object.assign(new Error("locked"), { errcode: 5 }))).toBe(true);
    expect(isSqliteBusyError(Object.assign(new Error("locked"), { errcode: 6 }))).toBe(true);
    expect(isSqliteBusyError(Object.assign(new Error("locked"), { code: "SQLITE_BUSY" }))).toBe(true);
    expect(isSqliteBusyError(Object.assign(new Error("locked"), { code: "SQLITE_LOCKED" }))).toBe(true);
    expect(isSqliteBusyError(new Error("SQLITE_BUSY: database is locked"))).toBe(true);
    expect(isSqliteBusyError(new Error("SQLITE_LOCKED"))).toBe(true);
  });

  it("does not match Windows sharing or generic resource-busy strings", () => {
    expect(isSqliteBusyError(new Error("EBUSY: resource busy"))).toBe(false);
    expect(isSqliteBusyError(new Error("device or resource busy"))).toBe(false);
    expect(isSqliteBusyError(new Error("sharing violation"))).toBe(false);
    expect(isSqliteBusyError(new Error("unable to open database file"))).toBe(false);
  });
});

describe("withSqliteBusyRetry", () => {
  it("caps attempts at the default finite retry limit", () => {
    let attempts = 0;
    expect(() => withSqliteBusyRetry(() => {
      attempts += 1;
      throw sqliteBusyError("SQLITE_BUSY: database is locked");
    })).toThrow(/SQLITE_BUSY/);
    expect(attempts).toBe(DEFAULT_SQLITE_BUSY_RETRY_LIMIT);
  });

  it("does not start another attempt after the busy budget", () => {
    let attempts = 0;
    const started = performance.now();
    expect(() => withSqliteBusyRetry(() => {
      attempts += 1;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
      throw sqliteBusyError("SQLITE_BUSY: database is locked");
    }, { budgetMs: 50, sleepMs: 5 })).toThrow(/SQLITE_BUSY/);
    expect(attempts).toBeLessThanOrEqual(2);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("does not treat budgetMs as an infinite retry limit", () => {
    let attempts = 0;
    expect(() => withSqliteBusyRetry(() => {
      attempts += 1;
      throw sqliteBusyError("SQLITE_BUSY: database is locked");
    }, { budgetMs: 5_000, sleepMs: 0 })).toThrow(/SQLITE_BUSY/);
    expect(attempts).toBe(DEFAULT_SQLITE_BUSY_RETRY_LIMIT);
  });
});
