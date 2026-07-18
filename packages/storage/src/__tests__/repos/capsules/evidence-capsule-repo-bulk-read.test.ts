import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeTempDirectorySync } from "../../temp-directory.js";
import {
  createEvidenceCapsule,
  createEvidenceCapsuleRepo,
  evidenceCapsuleDatabases
} from "./evidence-capsule-repo-fixture.js";

afterEach(() => {
  for (const database of evidenceCapsuleDatabases) database.close();
  evidenceCapsuleDatabases.clear();
});

describe("SqliteEvidenceCapsuleRepo bulk reads", () => {
  it("reprepares after the database connection is closed and reopened", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "alaya-evidence-capsule-"));
    const { database, repo } = await createEvidenceCapsuleRepo(
      path.join(tempDir, "evidence.db")
    );
    const capsule = createEvidenceCapsule();
    await repo.create(capsule);

    database.close();
    await expect(repo.findByIds(capsule.workspace_id, [capsule.object_id])).resolves.toEqual([
      capsule
    ]);

    evidenceCapsuleDatabases.delete(database);
    removeTempDirectorySync(tempDir, [database]);
  });

  it("does not prepare new statements for each input cardinality", async () => {
    const { database, repo } = await createEvidenceCapsuleRepo();
    const capsule = createEvidenceCapsule();
    await repo.create(capsule);
    let prepareCount = 0;
    const originalPrepare = database.connection.prepare.bind(database.connection);
    database.connection.prepare = ((sql: string) => {
      prepareCount += 1;
      return originalPrepare(sql);
    }) as typeof database.connection.prepare;

    await repo.findByIds("workspace-1", [capsule.object_id]);
    await repo.findByIds("workspace-1", [capsule.object_id, "missing-id"]);
    await repo.findSourceAnchorsByIds("workspace-1", [capsule.object_id]);
    await repo.findSourceAnchorsByIds("workspace-1", [capsule.object_id, "missing-id"]);

    expect(prepareCount).toBe(0);
  });

  it("preserves deterministic ordering across chunks", async () => {
    const { repo } = await createEvidenceCapsuleRepo();
    const earlier = createEvidenceCapsule({
      object_id: "f6c1b587-be07-4410-b2ca-8bfbc4d82db4",
      created_at: "2026-03-20T00:00:00.000Z"
    });
    const later = createEvidenceCapsule({
      object_id: "3ca5f78f-b5fd-4543-99eb-ce72ab2578ab",
      created_at: "2026-03-20T00:00:01.000Z"
    });
    await repo.create(earlier);
    await repo.create(later);
    const missingIds = Array.from({ length: 500 }, (_, index) => `missing-${index}`);

    const rows = await repo.findByIds("workspace-1", [
      later.object_id,
      ...missingIds,
      earlier.object_id
    ]);

    expect(rows.map((row) => row.object_id)).toEqual([earlier.object_id, later.object_id]);
  });
});
