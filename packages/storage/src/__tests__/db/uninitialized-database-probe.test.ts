import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StorageError } from "../../shared/errors.js";
import { initDatabase, isUninitializedDatabaseFile } from "../../sqlite/db.js";
import { openSqliteConnection } from "../../sqlite/open-sqlite-connection.js";
import { removeTempDirectorySync } from "../temp-directory.js";

vi.mock("../../sqlite/open-sqlite-connection.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../sqlite/open-sqlite-connection.js")>();
  return {
    openSqliteConnection: vi.fn((...args: Parameters<typeof actual.openSqliteConnection>) =>
      actual.openSqliteConnection(...args)
    )
  };
});

const mockedOpen = vi.mocked(openSqliteConnection);
const directories: string[] = [];
const databases: Array<ReturnType<typeof initDatabase>> = [];

afterEach(() => {
  vi.restoreAllMocks();
  mockedOpen.mockClear();
  while (databases.length > 0) {
    databases.pop()?.close();
  }
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) {
      removeTempDirectorySync(directory);
    }
  }
});

function createFilename(): string {
  const directory = mkdtempSync(join(tmpdir(), "alaya-init-probe-"));
  directories.push(directory);
  return join(directory, "alaya.db");
}

function sqliteBusyError(): Error & { errcode: number; code: string } {
  return Object.assign(new Error("SQLITE_BUSY: database is locked"), {
    errcode: 5,
    code: "SQLITE_BUSY"
  });
}

describe("isUninitializedDatabaseFile probe errors", () => {
  it("rethrows SQLITE_BUSY from the readonly probe", () => {
    const filename = createFilename();
    new BetterSqlite3(filename).close();
    const busy = sqliteBusyError();
    mockedOpen.mockImplementationOnce(() => {
      throw busy;
    });
    expect(() => isUninitializedDatabaseFile(filename)).toThrow(busy);
  });

  it("rethrows a wrapped SQLITE_BUSY cause", () => {
    const filename = createFilename();
    new BetterSqlite3(filename).close();
    const wrapped = new StorageError(
      "DATABASE_OPEN_FAILED",
      "Failed to open database",
      sqliteBusyError()
    );
    mockedOpen.mockImplementationOnce(() => {
      throw wrapped;
    });
    expect(() => isUninitializedDatabaseFile(filename)).toThrow(wrapped);
  });

  it("treats generic resource busy as not proof of an empty ledger", () => {
    const filename = createFilename();
    new BetterSqlite3(filename).close();
    mockedOpen.mockImplementationOnce(() => {
      throw new Error("EBUSY: resource busy");
    });
    expect(isUninitializedDatabaseFile(filename)).toBe(false);
  });
});

describe("initDatabase uninitialized-file probe retry", () => {
  it("retries a probe SQLITE_BUSY and then bootstraps", () => {
    // This case checks retry routing; scheduler delay must not exhaust its budget.
    // Real competing-writer deadlines are covered by db-busy-timeout.test.ts.
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const filename = createFilename();
    new BetterSqlite3(filename).close();
    mockedOpen
      .mockImplementationOnce(() => {
        throw sqliteBusyError();
      })
      .mockImplementationOnce(() => {
        throw sqliteBusyError();
      });
    const database = initDatabase({ filename, busyTimeoutMs: 250 });
    databases.push(database);
    const maxVersion = database.connection.prepare(
      "SELECT MAX(version) AS max_version FROM schema_version"
    ).get() as { readonly max_version: number };
    expect(maxVersion.max_version).toBe(17);
    expect(mockedOpen.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});
