import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDaemonDatabase } from "../../../runtime/startup/database.js";

describe("daemon startup database", () => {
  it("uses the storage default busy timeout", () => {
    const directory = mkdtempSync(join(tmpdir(), "alaya-daemon-database-test-"));
    const database = openDaemonDatabase(join(directory, "alaya.db"));
    try {
      expect(database.getBusyTimeoutMs()).toBe(5_000);
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
