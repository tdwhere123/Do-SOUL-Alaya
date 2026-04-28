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

  it("initializes a clean data dir and records ordered runtime migrations", async () => {
    const temp = await createTempDir("alaya-storage-clean-");
    tempDirs.push(temp);

    const storage = await SqliteAlayaStorage.open({ dataDir: temp.path });
    try {
      expect(existsSync(join(temp.path, "alaya.sqlite"))).toBe(true);
      expect(storage.listAppliedMigrations()).toEqual([
        expect.objectContaining({ id: "001-runtime-truth-kernel-baseline" }),
        expect.objectContaining({ id: "002-ontology" }),
        expect.objectContaining({ id: "003-structure" }),
        expect.objectContaining({ id: "004-governance" }),
        expect.objectContaining({ id: "005-recall-context" }),
        expect.objectContaining({ id: "006-provider-proposal" }),
        expect.objectContaining({ id: "007-session-trust" }),
        expect.objectContaining({ id: "008-runtime-use-proof-lineage-replay" })
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

  it("maintains the recall FTS index for memory content", async () => {
    const temp = await createTempDir("alaya-storage-recall-");
    tempDirs.push(temp);

    const storage = await SqliteAlayaStorage.open({ dataDir: temp.path });
    try {
      storage.createOntologyRecord({
        objectKind: "memory_entry",
        objectId: "memory-fts",
        workspaceId: "workspace-1",
        lifecycleState: "active",
        payload: {
          object_kind: "memory_entry",
          object_id: "memory-fts",
          content: "Alaya 记忆核心 recall baseline"
        },
        createdAt: "2026-04-28T00:00:00.000Z",
        updatedAt: "2026-04-28T00:00:00.000Z"
      });

      expect(storage.searchMemoryContent("workspace-1", "记忆核心", 10).map((row) => row.objectId)).toEqual(["memory-fts"]);
      expect(storage.searchMemoryContent("workspace-2", "记忆核心", 10)).toEqual([]);
    } finally {
      storage.close();
    }
  });
});
