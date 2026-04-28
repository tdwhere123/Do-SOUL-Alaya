import { afterEach, describe, expect, it } from "vitest";
import type { NodeInstance } from "@do-soul/alaya-protocol";
import { initDatabase, SqliteNodeInstanceRepo } from "../index.js";
import { StorageError } from "../errors.js";

const databases = new Set<ReturnType<typeof initDatabase>>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

describe("SqliteNodeInstanceRepo", () => {
  it("inserts and loads a node instance by id", async () => {
    const { repo } = createRepo();
    const instance = createNodeInstance();

    await expect(repo.insert(instance)).resolves.toEqual(instance);
    await expect(repo.getById(instance.node_id)).resolves.toEqual(instance);
  });

  it("returns null when a node instance does not exist", async () => {
    const { repo } = createRepo();

    await expect(repo.getById("missing-node")).resolves.toBeNull();
  });

  it("updates state with compare-and-swap semantics", async () => {
    const { repo } = createRepo();
    const instance = createNodeInstance();

    await repo.insert(instance);

    await expect(
      repo.updateState(instance.node_id, "pending", "active", "2026-04-13T10:05:00.000Z")
    ).resolves.toEqual({
      ...instance,
      state: "active",
      updated_at: "2026-04-13T10:05:00.000Z"
    });
  });

  it("throws CONFLICT when the expected state does not match", async () => {
    const { repo } = createRepo();
    const instance = createNodeInstance();

    await repo.insert(instance);

    await expect(
      repo.updateState(instance.node_id, "active", "completed", "2026-04-13T10:05:00.000Z")
    ).rejects.toMatchObject({
      code: "CONFLICT"
    });
  });

  it("rejects invalid updated_at values before the CAS write with field-level validation and preserves the stored row", async () => {
    const { repo } = createRepo();
    const instance = createNodeInstance();

    await repo.insert(instance);

    const error = await repo
      .updateState(instance.node_id, "pending", "active", "zzz")
      .then(() => null)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(StorageError);
    expect(error).toMatchObject({
      code: "VALIDATION_FAILED"
    });
    expect((error as StorageError).cause).toMatchObject({
      name: "ZodError"
    });
    await expect(repo.getById(instance.node_id)).resolves.toEqual(instance);
  });

  it("wraps duplicate node_id inserts as QUERY_FAILED and preserves the original row", async () => {
    const { repo } = createRepo();
    const original = createNodeInstance();
    const duplicate = createNodeInstance({
      state: "active",
      updated_at: "2026-04-13T10:05:00.000Z"
    });

    await repo.insert(original);

    await expect(repo.insert(duplicate)).rejects.toMatchObject({
      code: "QUERY_FAILED"
    });
    await expect(repo.getById(original.node_id)).resolves.toEqual(original);
  });

  it("lists node instances by principal run id ordered by created_at", async () => {
    const { repo } = createRepo();
    const first = createNodeInstance({
      created_at: "2026-04-13T10:00:00.000Z",
      node_id: "node-1"
    });
    const second = createNodeInstance({
      created_at: "2026-04-13T10:10:00.000Z",
      node_id: "node-2",
      updated_at: "2026-04-13T10:10:00.000Z"
    });
    const otherRun = createNodeInstance({
      created_at: "2026-04-13T10:20:00.000Z",
      node_id: "node-3",
      principal_run_id: "run-2",
      updated_at: "2026-04-13T10:20:00.000Z"
    });

    await repo.insert(second);
    await repo.insert(otherRun);
    await repo.insert(first);

    await expect(repo.findByPrincipalRunId("run-1")).resolves.toEqual([first, second]);
  });
});

function createRepo(): {
  readonly database: ReturnType<typeof initDatabase>;
  readonly repo: SqliteNodeInstanceRepo;
} {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);
  seedWorkspace(database);
  insertRun(database, "run-1");
  insertRun(database, "run-2");

  return {
    database,
    repo: new SqliteNodeInstanceRepo(database)
  };
}

function createNodeInstance(overrides: Partial<NodeInstance> = {}): NodeInstance {
  return {
    node_id: overrides.node_id ?? "node-1",
    principal_run_id: overrides.principal_run_id ?? "run-1",
    node_template: overrides.node_template ?? "analyze",
    state: overrides.state ?? "pending",
    task_surface_ref: overrides.task_surface_ref ?? "surface://runs/run-1/tasks/1",
    stance_resolution_ref: overrides.stance_resolution_ref ?? null,
    created_at: overrides.created_at ?? "2026-04-13T10:00:00.000Z",
    updated_at: overrides.updated_at ?? "2026-04-13T10:00:00.000Z"
  };
}

function seedWorkspace(database: ReturnType<typeof initDatabase>): void {
  database.connection
    .prepare(
      `INSERT OR IGNORE INTO workspaces (
        workspace_id, name, root_path, workspace_kind, default_engine_binding, workspace_state, created_at, archived_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      "ws-node-instances",
      "Node Instances",
      "/tmp/node-instances",
      "local_repo",
      null,
      "active",
      "2026-04-13T00:00:00.000Z",
      null
    );
}

function insertRun(database: ReturnType<typeof initDatabase>, runId: string): void {
  database.connection
    .prepare(
      `INSERT INTO runs (
        run_id, workspace_id, title, goal, run_mode, engine_binding_id, run_state, current_surface_id, created_at, last_active_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      runId,
      "ws-node-instances",
      `Run ${runId}`,
      null,
      "build",
      null,
      "idle",
      null,
      "2026-04-13T00:00:00.000Z",
      "2026-04-13T00:00:00.000Z"
    );
}
