import { afterEach, expect, it } from "vitest";
import { createEvidenceCapsule, createEvidenceCapsuleRepo, evidenceCapsuleDatabases } from "./evidence-capsule-repo-fixture.js";
import { SqliteSourceHintReader } from "../../../repos/field/source-hint-reader.js";

afterEach(() => {
  for (const database of evidenceCapsuleDatabases) database.close();
  evidenceCapsuleDatabases.clear();
});

it("requires a transaction and compares workspace, retained hypothesis bytes, source hash and active state before archive", async () => {
  const { database, repo } = await createEvidenceCapsuleRepo();
  const capsule = createEvidenceCapsule();
  await repo.create(capsule);
  const input = { objectId: capsule.object_id, workspaceId: capsule.workspace_id, expectedGist: capsule.gist,
    sourceHash: capsule.source_hash!, updatedAt: "2026-03-21T00:00:00.000Z" };
  const reader = new SqliteSourceHintReader(database.connection), keys = [capsule.object_id, "absent-legacy-key"];
  expect(() => reader.readBoundInterpretationForLifecycle(capsule.workspace_id, keys, 4096)).toThrow(/requires a transaction/u);
  expect(() => repo.archiveSourceInterpretationInCurrentTransaction(input)).toThrow(/requires a transaction/u);
  database.connection.transaction(() => {
    expect(reader.readBoundInterpretationForLifecycle("workspace-2", keys, 4096).status).toBe("absent");
    expect(repo.archiveSourceInterpretationInCurrentTransaction({ ...input, workspaceId: "workspace-2" })).toBe(false);
    expect(repo.archiveSourceInterpretationInCurrentTransaction({ ...input, expectedGist: "different hypothesis" })).toBe(false);
    expect(repo.archiveSourceInterpretationInCurrentTransaction({ ...input, sourceHash: "sha256:different" })).toBe(false);
    expect(reader.readBoundInterpretationForLifecycle(capsule.workspace_id, keys, 4096)).toMatchObject({ lifecycleState: "active", gist: capsule.gist });
    expect(repo.archiveSourceInterpretationInCurrentTransaction(input)).toBe(true);
    expect(repo.archiveSourceInterpretationInCurrentTransaction(input)).toBe(false);
    expect(reader.readBoundInterpretationForLifecycle(capsule.workspace_id, keys, 4096)).toMatchObject({ lifecycleState: "archived", gist: capsule.gist });
  }).immediate();
  expect(await repo.findById(capsule.object_id)).toEqual({ ...capsule, lifecycle_state: "archived", updated_at: input.updatedAt });
});

it("rolls back archive bytes and lifecycle when the owning transaction fails", async () => {
  const { database, repo } = await createEvidenceCapsuleRepo();
  const capsule = createEvidenceCapsule();
  await repo.create(capsule);
  expect(() => database.connection.transaction(() => {
    expect(repo.archiveSourceInterpretationInCurrentTransaction({ objectId: capsule.object_id, workspaceId: capsule.workspace_id,
      expectedGist: capsule.gist, sourceHash: capsule.source_hash!, updatedAt: "2026-03-21T00:00:00.000Z" })).toBe(true);
    throw new Error("owner rollback");
  }).immediate()).toThrow("owner rollback");
  expect(await repo.findById(capsule.object_id)).toEqual(capsule);
});
