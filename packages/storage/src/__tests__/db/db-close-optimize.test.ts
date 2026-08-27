import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initDatabase } from "../../sqlite/db.js";
import { removeTempDirectorySync } from "../temp-directory.js";

describe("StorageDatabase close optimize seam", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      removeTempDirectorySync(directory);
    }
  });

  it("runs optimize by default and skips it when opted out", () => {
    const filename = tempDbPath();
    const defaultDb = initDatabase({ filename });
    const defaultCalls = capturePragma(defaultDb.connection);
    defaultDb.close();
    expect(defaultDb.isClosed()).toBe(true);
    expect(defaultCalls).toContain("optimize");

    const optedOut = initDatabase({ filename: tempDbPath() });
    const skipped = capturePragma(optedOut.connection);
    optedOut.close({ optimize: false });
    expect(optedOut.isClosed()).toBe(true);
    expect(skipped).not.toContain("optimize");
  });

  it("does not change checkpointed main-file bytes when optimize is skipped", () => {
    const filename = tempDbPath();
    const database = initDatabase({ filename });
    database.connection.exec("ANALYZE");
    const [checkpoint] = database.connection.pragma("wal_checkpoint(TRUNCATE)") as Array<{
      readonly busy: number;
      readonly log: number;
      readonly checkpointed: number;
    }>;
    expect(checkpoint?.busy).toBe(0);
    expect(checkpoint?.log).toBe(checkpoint?.checkpointed);
    const before = sha256File(filename);
    database.close({ optimize: false });
    expect(sha256File(filename)).toBe(before);
  });

  function tempDbPath(): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "alaya-db-close-"));
    directories.push(directory);
    return path.join(directory, "alaya.db");
  }
});

function capturePragma(connection: { pragma: (sql: string) => unknown }): string[] {
  const calls: string[] = [];
  const original = connection.pragma.bind(connection);
  connection.pragma = ((sql: string) => {
    calls.push(sql);
    return original(sql);
  }) as typeof connection.pragma;
  return calls;
}

function sha256File(filename: string): string {
  return createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
}
