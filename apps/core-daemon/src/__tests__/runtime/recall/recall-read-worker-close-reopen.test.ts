import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { closeCachedDatabase, initDatabase, SqliteMemoryEntryRepo } from "@do-soul/alaya-storage";
import { removeTempDirectorySync } from "../../../../../../packages/storage/src/__tests__/temp-directory.js";
import { createRecallReadWorkerClient } from "../../../runtime/recall/recall-read-worker-client.js";
import {
  assertBuiltWorker,
  builtWorkerUrl,
  createMemoryEntry
} from "./recall-read-worker-client-fixture.js";

describe("RecallReadWorkerClient close/reopen", () => {
  it("closes a worker against a temp database and reopens the same rows", async () => {
    assertBuiltWorker();
    const directory = mkdtempSync(join(tmpdir(), "alaya-recall-worker-close-reopen-"));
    const databasePath = join(directory, "alaya.db");
    const database = initDatabase({ filename: databasePath });
    const workspaceId = "workspace-1";
    const objectId = randomUUID();
    const repo = new SqliteMemoryEntryRepo(database);
    await repo.create(
      createMemoryEntry({
        object_id: objectId,
        workspace_id: workspaceId,
        content: "worker close/reopen row",
        activation_score: 0.9
      })
    );
    database.close();
    closeCachedDatabase(databasePath);

    const first = createRecallReadWorkerClient({
      databaseFilename: databasePath,
      workerUrl: builtWorkerUrl
    });
    expect(first).not.toBeNull();
    if (first === null) {
      return;
    }

    try {
      await first.ready();
      const firstRows = await first.memoryRepo.findByWorkspaceId(workspaceId, "hot", {
        limit: 10,
        offset: 0
      });
      expect(firstRows.map((row) => row.object_id)).toEqual([objectId]);
      await first.close();
      await expect(
        first.memoryRepo.findByWorkspaceId(workspaceId, "hot", { limit: 10, offset: 0 })
      ).rejects.toThrow(/recall read worker is closed/);

      const second = createRecallReadWorkerClient({
        databaseFilename: databasePath,
        workerUrl: builtWorkerUrl
      });
      expect(second).not.toBeNull();
      if (second === null) {
        return;
      }
      try {
        await second.ready();
        const secondRows = await second.memoryRepo.findByWorkspaceId(workspaceId, "hot", {
          limit: 10,
          offset: 0
        });
        expect(secondRows.map((row) => row.object_id)).toEqual([objectId]);
        expect(secondRows[0]?.content).toBe("worker close/reopen row");
      } finally {
        await second.close();
      }
    } finally {
      await first.close();
      closeCachedDatabase(databasePath);
      removeTempDirectorySync(directory);
    }
  }, 30_000);
});
