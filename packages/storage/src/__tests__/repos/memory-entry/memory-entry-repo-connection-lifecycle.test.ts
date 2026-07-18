import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeTempDirectorySync } from "../../temp-directory.js";
import {
  createMemoryEntry,
  createRepo,
  trackedDatabases
} from "./memory-entry-repo-fixture.js";

afterEach(() => {
  for (const database of trackedDatabases) database.close();
  trackedDatabases.clear();
});

describe("SqliteMemoryEntryRepo connection lifecycle", () => {
  it("reopens before createWithinTransaction", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "alaya-memory-entry-"));
    const { repo, database } = await createRepo({
      filename: path.join(tempDir, "memory-entry.db")
    });
    const entry = createMemoryEntry();

    database.close();
    expect(repo.createWithinTransaction(entry, {})).toEqual(entry);
    expect(database.isClosed()).toBe(false);
    await expect(repo.findById(entry.object_id)).resolves.toEqual(entry);
    disposeTempDatabase(tempDir, database);
  });

  it("reuses stable bulk-read statements across input cardinalities", async () => {
    const { repo, database } = await createRepo();
    const first = createMemoryEntry({ object_id: "7ab81ca8-9425-4e18-ad4a-81ab6406db55" });
    const second = createMemoryEntry({ object_id: "ca648194-c03c-4932-b103-3ec4d318732a" });
    await repo.create(first);
    await repo.create(second);
    let prepareCount = 0;
    const originalPrepare = database.connection.prepare.bind(database.connection);
    database.connection.prepare = ((sql: string) => {
      prepareCount += 1;
      return originalPrepare(sql);
    }) as typeof database.connection.prepare;

    await repo.findByIds("workspace-1", [first.object_id]);
    await repo.findByIds("workspace-1", [first.object_id, second.object_id]);
    await repo.findBySharedDomainTags("workspace-1", ["tag-a"]);
    await repo.findBySharedDomainTags("workspace-1", ["tag-a", "tag-b"]);
    await repo.findByEvidenceRefs("workspace-1", ["evidence-a"]);
    await repo.findByEvidenceRefs("workspace-1", ["evidence-a", "evidence-b"]);

    expect(prepareCount).toBe(3);
  });

  it("reprepares findByIds after reopen", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "alaya-memory-entry-"));
    const { repo, database } = await createRepo({
      filename: path.join(tempDir, "memory-entry.db")
    });
    const entry = createMemoryEntry();
    await repo.create(entry);

    database.close();
    await expect(repo.findByIds(entry.workspace_id, [entry.object_id])).resolves.toEqual([entry]);
    expect(database.isClosed()).toBe(false);
    disposeTempDatabase(tempDir, database);
  });

  it("reopens before transitionLifecycle", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "alaya-memory-entry-"));
    const { repo, database } = await createRepo({
      filename: path.join(tempDir, "memory-entry.db")
    });
    const entry = createMemoryEntry();
    await repo.create(entry);

    database.close();
    const transitioned = await repo.transitionLifecycle(
      entry.object_id,
      "dormant",
      "2026-03-22T00:00:00.000Z"
    );

    expect(transitioned.lifecycle_state).toBe("dormant");
    expect(transitioned.updated_at).toBe("2026-03-22T00:00:00.000Z");
    expect(database.isClosed()).toBe(false);
    disposeTempDatabase(tempDir, database);
  });
});

function disposeTempDatabase(
  tempDir: string,
  database: Awaited<ReturnType<typeof createRepo>>["database"]
): void {
  trackedDatabases.delete(database);
  removeTempDirectorySync(tempDir, [database]);
}
