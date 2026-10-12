import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openSqliteConnection, sqliteHostFilename } from "../../sqlite/open-sqlite-connection.js";

describe("openSqliteConnection", () => {
  it("fails immediately on a missing file instead of retrying the 2s lock budget", () => {
    const missing = join(mkdtempSync(join(tmpdir(), "alaya-open-retry-")), "missing.sqlite");
    const started = Date.now();
    expect(() => openSqliteConnection(missing, { fileMustExist: true })).toThrow();
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("prefixes only a Windows path whose journal sidecar would pass MAX_PATH", () => {
    const shortName = "C:\\Users\\runner\\AppData\\Local\\Temp\\alaya.db";
    expect(sqliteHostFilename(shortName, "win32")).toBe(shortName);
    const longName = `C:\\${"segment\\".repeat(20)}${"a".repeat(180)}.sqlite`;
    expect(longName.length + "-journal".length).toBeGreaterThanOrEqual(260);
    expect(sqliteHostFilename(longName, "win32")).toBe(`\\\\?\\${longName}`);
    expect(sqliteHostFilename("/tmp/alaya.db", "linux")).toBe("/tmp/alaya.db");
    expect(sqliteHostFilename(":memory:", "win32")).toBe(":memory:");
  });
});
