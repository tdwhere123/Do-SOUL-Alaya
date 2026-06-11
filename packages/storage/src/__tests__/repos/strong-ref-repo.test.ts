import { afterEach, describe, expect, it } from "vitest";
import type { StrongRef } from "@do-soul/alaya-protocol";
import { initDatabase } from "../../db.js";
import { SqliteStrongRefRepo } from "../../repos/strong-ref-repo.js";

const databases = new Set<ReturnType<typeof initDatabase>>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

describe("SqliteStrongRefRepo", () => {
  it("creates and loads strong refs by target/source", async () => {
    const { repo } = createRepo();
    const first = createStrongRefFixture();
    const second = createStrongRefFixture({
      ref_id: "strong-ref-2",
      source_entity_id: "snapshot-1",
      source_entity_type: "security_snapshot",
      reason: "security_snapshot",
      target_entity_id: "claim-1",
      target_entity_type: "claim_form",
      created_at: "2026-04-15T00:01:00.000Z"
    });

    await repo.create(first);
    await repo.create(second);

    await expect(repo.findByTarget("workspace-1", "claim_form", "claim-1")).resolves.toEqual([first, second]);
    await expect(repo.findBySource("lease-1")).resolves.toEqual([first]);
    await expect(repo.findByTargets("workspace-1", "claim_form", ["claim-1"])).resolves.toEqual([first, second]);
  });

  it("returns protection booleans for single and batch lookups", async () => {
    const { repo } = createRepo();

    await repo.create(createStrongRefFixture({ target_entity_id: "claim-1" }));
    await repo.create(createStrongRefFixture({ ref_id: "strong-ref-2", target_entity_id: "slot-1" }));

    await expect(repo.isProtected("workspace-1", "claim_form", "claim-1")).resolves.toBe(true);
    await expect(repo.isProtected("workspace-1", "claim_form", "missing-target")).resolves.toBe(false);
    await expect(repo.areAllProtected("workspace-1", "claim_form", ["claim-1", "slot-1"])).resolves.toBe(true);
    await expect(repo.areAllProtected("workspace-1", "claim_form", ["claim-1", "slot-1", "missing-target"])).resolves.toBe(false);
    await expect(repo.areAllProtected("workspace-1", "claim_form", [])).resolves.toBe(true);
  });

  it("deletes strong refs by ref id", async () => {
    const { repo } = createRepo();
    const ref = createStrongRefFixture();

    await repo.create(ref);
    await expect(repo.isProtected(ref.workspace_id, ref.target_entity_type, ref.target_entity_id)).resolves.toBe(true);

    await repo.delete(ref.ref_id);

    await expect(repo.isProtected(ref.workspace_id, ref.target_entity_type, ref.target_entity_id)).resolves.toBe(false);
    await expect(repo.findByTarget(ref.workspace_id, ref.target_entity_type, ref.target_entity_id)).resolves.toEqual([]);
  });

  it("deletes strong refs by source entity", async () => {
    const { repo } = createRepo();
    const first = createStrongRefFixture({
      source_entity_type: "worker_run",
      source_entity_id: "worker-1",
      target_entity_id: "claim-1"
    });
    const second = createStrongRefFixture({
      ref_id: "strong-ref-2",
      source_entity_type: "worker_run",
      source_entity_id: "worker-1",
      target_entity_id: "claim-2"
    });

    await repo.create(first);
    await repo.create(second);

    await repo.deleteBySource("worker_run", "worker-1");

    await expect(repo.findByTarget("workspace-1", "claim_form", "claim-1")).resolves.toEqual([]);
    await expect(repo.findByTarget("workspace-1", "claim_form", "claim-2")).resolves.toEqual([]);
  });

  it("enforces the unique source-target-reason constraint", async () => {
    const { repo } = createRepo();
    const ref = createStrongRefFixture();

    await repo.create(ref);
    await expect(
      repo.create(
        createStrongRefFixture({
          ref_id: "strong-ref-2"
        })
      )
    ).rejects.toMatchObject({
      code: "QUERY_FAILED"
    });
  });

  it("cascades strong refs when the workspace is deleted", async () => {
    const { database, repo } = createRepo();
    const ref = createStrongRefFixture();

    await repo.create(ref);
    await expect(repo.isProtected(ref.workspace_id, ref.target_entity_type, ref.target_entity_id)).resolves.toBe(true);

    database.connection
      .prepare("DELETE FROM workspaces WHERE workspace_id = ?")
      .run(ref.workspace_id);

    await expect(repo.isProtected(ref.workspace_id, ref.target_entity_type, ref.target_entity_id)).resolves.toBe(false);
    await expect(repo.findByTarget(ref.workspace_id, ref.target_entity_type, ref.target_entity_id)).resolves.toEqual([]);
  });
});

function createRepo(): {
  readonly database: ReturnType<typeof initDatabase>;
  readonly repo: SqliteStrongRefRepo;
} {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);
  seedWorkspace(database, "workspace-1");

  return {
    database,
    repo: new SqliteStrongRefRepo(database)
  };
}

function seedWorkspace(database: ReturnType<typeof initDatabase>, workspaceId: string): void {
  database.connection
    .prepare(
      `INSERT INTO workspaces (
        workspace_id,
        name,
        root_path,
        workspace_kind,
        default_engine_binding,
        workspace_state,
        created_at,
        archived_at,
        default_engine_class
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      workspaceId,
      "Strong Ref Workspace",
      `/tmp/${workspaceId}`,
      "local_repo",
      null,
      "active",
      "2026-04-15T00:00:00.000Z",
      null,
      null
    );
}

function createStrongRefFixture(overrides: Partial<StrongRef> = {}): StrongRef {
  return {
    ref_id: "strong-ref-1",
    source_entity_type: "governance_lease",
    source_entity_id: "lease-1",
    target_entity_type: "claim_form",
    target_entity_id: "claim-1",
    workspace_id: "workspace-1",
    reason: "governance_lease",
    created_at: "2026-04-15T00:00:00.000Z",
    ...overrides
  };
}
