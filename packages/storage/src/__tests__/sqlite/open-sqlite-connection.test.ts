import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openSqliteConnection } from "../../sqlite/open-sqlite-connection.js";

describe("openSqliteConnection", () => {
  it("fails immediately on a missing file instead of retrying the 2s lock budget", () => {
    const missing = join(mkdtempSync(join(tmpdir(), "alaya-open-retry-")), "missing.sqlite");
    const started = Date.now();
    expect(() => openSqliteConnection(missing, { fileMustExist: true })).toThrow();
    expect(Date.now() - started).toBeLessThan(500);
  });
});
