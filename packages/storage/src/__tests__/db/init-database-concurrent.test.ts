import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { StorageError } from "../../shared/errors.js";
import { initDatabase } from "../../sqlite/db.js";
import { removeTempDirectorySync } from "../temp-directory.js";

const directories: string[] = [];
const databases: Array<ReturnType<typeof initDatabase>> = [];

afterEach(() => {
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
  const directory = mkdtempSync(join(tmpdir(), "alaya-init-concurrent-"));
  directories.push(directory);
  return join(directory, "alaya.db");
}

const distInitModule = fileURLToPath(new URL("../../../dist/sqlite/db.js", import.meta.url));

describe("initDatabase concurrent migration", () => {
  it("lets a second file-backed initDatabase observe the applied ledger without throwing", () => {
    const filename = createFilename();
    const first = initDatabase({ filename });
    databases.push(first);
    first.close();
    databases.pop();
    const second = initDatabase({ filename });
    databases.push(second);
    const maxVersion = second.connection.prepare(
      "SELECT MAX(version) AS max_version FROM schema_version"
    ).get() as { readonly max_version: number };
    expect(maxVersion.max_version).toBe(15);
  });

  it.skipIf(!existsSync(distInitModule))(
    "lets two processes initialize the same file without a migration throw",
    async () => {
      const filename = createFilename();
      const moduleUrl = pathToFileURL(distInitModule).href;
      const [first, second] = await Promise.all([
        spawnInitDatabaseProcess(filename, moduleUrl),
        spawnInitDatabaseProcess(filename, moduleUrl)
      ]);
      expect(first.stderr, first.stderr).toBe("");
      expect(second.stderr, second.stderr).toBe("");
      expect(first.status).toBe(0);
      expect(second.status).toBe(0);
      const probe = new BetterSqlite3(filename, { readonly: true, fileMustExist: true });
      try {
        const maxVersion = probe.prepare(
          "SELECT MAX(version) AS max_version FROM schema_version"
        ).get() as { readonly max_version: number };
        expect(maxVersion.max_version).toBe(15);
      } finally {
        probe.close();
      }
    },
    30_000
  );
});

describe("initDatabase uninitialized-file probe", () => {
  it("bootstraps a valid sqlite file that has no schema_version ledger", () => {
    const filename = createFilename();
    new BetterSqlite3(filename).close();
    const database = initDatabase({ filename });
    databases.push(database);
    const maxVersion = database.connection.prepare(
      "SELECT MAX(version) AS max_version FROM schema_version"
    ).get() as { readonly max_version: number };
    expect(maxVersion.max_version).toBe(15);
  });

  it("keeps the runtime temporal gate on an unreadable existing file", () => {
    const filename = createFilename();
    writeFileSync(filename, "not a sqlite database");
    let captured: unknown;
    try {
      initDatabase({ filename });
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(StorageError);
    expect((captured as StorageError).code).toBe("CONFLICT");
  });
});

function spawnInitDatabaseProcess(
  filename: string,
  moduleUrl: string
): Promise<{ readonly status: number; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { initDatabase } from ${JSON.stringify(moduleUrl)};
         const database = initDatabase({ filename: ${JSON.stringify(filename)} });
         database.close();`
      ],
      { stdio: ["ignore", "pipe", "pipe"], env: process.env, cwd: process.cwd() }
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      resolve({ status: code ?? 1, stderr });
    });
  });
}
