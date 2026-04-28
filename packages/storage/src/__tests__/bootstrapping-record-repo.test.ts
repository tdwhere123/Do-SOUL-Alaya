import { afterEach, describe, expect, it } from "vitest";
import type { BootstrappingRecord } from "@do-soul/alaya-protocol";
import { initDatabase } from "../db.js";
import { SqliteBootstrappingRecordRepo, SqliteWorkspaceRepo } from "../index.js";

const databases = new Set<ReturnType<typeof initDatabase>>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

describe("SqliteBootstrappingRecordRepo", () => {
  it("persists bootstrapping records and exposes migration 046", async () => {
    const { database, repo, workspaceRepo } = createRepo();
    const record = createBootstrappingRecord();
    await createWorkspace(workspaceRepo, record.workspace_id);

    await expect(repo.create(record)).resolves.toEqual(record);
    await expect(repo.findByWorkspace(record.workspace_id)).resolves.toEqual(record);

    const appliedVersion = database.connection
      .prepare("SELECT version FROM schema_version WHERE version = 46 LIMIT 1")
      .get() as { readonly version: number } | undefined;

    expect(appliedVersion).toEqual({ version: 46 });
  });

  it("returns null when a workspace has no bootstrapping record", async () => {
    const { repo } = createRepo();

    await expect(repo.findByWorkspace("workspace-missing")).resolves.toBeNull();
  });

  it("rejects a second record for the same workspace", async () => {
    const { repo, workspaceRepo } = createRepo();
    await createWorkspace(workspaceRepo, "workspace-1");
    await repo.create(createBootstrappingRecord());

    await expect(
      repo.create(
        createBootstrappingRecord({
          record_id: "bootstrap-record-2"
        })
      )
    ).rejects.toMatchObject({
      code: "QUERY_FAILED"
    });
  });

  it("deletes bootstrapping records when the owning workspace is deleted", async () => {
    const { repo, workspaceRepo } = createRepo();
    const workspaceId = "workspace-owned-record";
    await workspaceRepo.create({
      workspace_id: workspaceId,
      name: "owned-record-workspace",
      root_path: `/tmp/${workspaceId}`,
      workspace_kind: "local_repo",
      default_engine_binding: null,
      default_engine_class: null,
      workspace_state: "active"
    });
    await repo.create(
      createBootstrappingRecord({
        workspace_id: workspaceId
      })
    );

    await workspaceRepo.delete(workspaceId);

    await expect(repo.findByWorkspace(workspaceId)).resolves.toBeNull();
  });

  it("returns the persisted bootstrapping record after create", async () => {
    const { database, repo, workspaceRepo } = createRepo();
    const record = createBootstrappingRecord();
    const persistedRecord = createBootstrappingRecord({
      planted_at: "2026-04-20T01:00:00.000Z"
    });

    await createWorkspace(workspaceRepo, record.workspace_id);
    database.connection.exec(`
      CREATE TRIGGER bootstrapping_records_normalize_after_insert
      AFTER INSERT ON bootstrapping_records
      BEGIN
        UPDATE bootstrapping_records
        SET planted_at = '2026-04-20T01:00:00.000Z'
        WHERE record_id = NEW.record_id;
      END;
    `);

    await expect(repo.create(record)).resolves.toEqual(persistedRecord);
    await expect(repo.findByWorkspace(record.workspace_id)).resolves.toEqual(persistedRecord);
  });
});

function createRepo(): {
  readonly database: ReturnType<typeof initDatabase>;
  readonly repo: SqliteBootstrappingRecordRepo;
  readonly workspaceRepo: SqliteWorkspaceRepo;
} {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);

  return {
    database,
    repo: new SqliteBootstrappingRecordRepo(database),
    workspaceRepo: new SqliteWorkspaceRepo(database)
  };
}

function createBootstrappingRecord(
  overrides: Partial<BootstrappingRecord> = {}
): BootstrappingRecord {
  return {
    record_id: "bootstrap-record-1",
    workspace_id: "workspace-1",
    paths_planted: 1,
    template_ids_used: ["workspace.bootstrap.conservative-start"],
    planted_at: "2026-04-20T00:00:00.000Z",
    ...overrides
  };
}

async function createWorkspace(workspaceRepo: SqliteWorkspaceRepo, workspaceId: string): Promise<void> {
  await workspaceRepo.create({
    workspace_id: workspaceId,
    name: `workspace-${workspaceId}`,
    root_path: `/tmp/${workspaceId}`,
    workspace_kind: "local_repo",
    default_engine_binding: null,
    default_engine_class: null,
    workspace_state: "active"
  });
}
