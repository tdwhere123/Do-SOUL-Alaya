import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTempDir, type TempDir } from "./helpers.js";
import { SqliteAlayaStorage } from "../storage/sqlite.js";

describe("SqliteAlayaStorage", () => {
  const tempDirs: TempDir[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((entry) => entry.cleanup()));
  });

  it("initializes a clean data dir and records the R1 migration", async () => {
    const temp = await createTempDir("alaya-storage-clean-");
    tempDirs.push(temp);

    const storage = await SqliteAlayaStorage.open({ dataDir: temp.path });
    try {
      expect(existsSync(join(temp.path, "alaya.sqlite"))).toBe(true);
      expect(storage.listAppliedMigrations()).toEqual([
        expect.objectContaining({ id: "001-runtime-truth-kernel-baseline" })
      ]);
    } finally {
      storage.close();
    }
  });

  it("can rerun migrations idempotently against the same data dir", async () => {
    const temp = await createTempDir("alaya-storage-idempotent-");
    tempDirs.push(temp);

    const first = await SqliteAlayaStorage.open({ dataDir: temp.path });
    const firstMigrations = first.listAppliedMigrations();
    first.close();

    const second = await SqliteAlayaStorage.open({ dataDir: temp.path });
    try {
      expect(second.listAppliedMigrations()).toEqual(firstMigrations);
    } finally {
      second.close();
    }
  });
});
