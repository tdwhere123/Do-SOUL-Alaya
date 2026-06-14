import { afterEach, describe, expect, it } from "vitest";
import { RunMode, RunState, WorkspaceKind, WorkspaceState } from "@do-soul/alaya-protocol";
import { StorageError } from "../../../shared/errors.js";
import { initDatabase } from "../../../sqlite/db.js";
import { SqliteRunRepo } from "../../../repos/runtime/run-repo.js";
import { SqliteWorkspaceRepo } from "../../../repos/runtime/workspace-repo.js";

const databases = new Set<ReturnType<typeof initDatabase>>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

describe("SqliteRunRepo", () => {
  it("create links a run to its workspace", async () => {
    const { workspaceRepo, runRepo } = createRunRepos();
    await workspaceRepo.create({
      workspace_id: "ws_runs",
      name: "runs",
      root_path: "/tmp/runs",
      workspace_kind: WorkspaceKind.LOCAL_REPO,
      default_engine_binding: null,
      workspace_state: WorkspaceState.ACTIVE
    });

    const run = await runRepo.create({
      run_id: "run_one",
      workspace_id: "ws_runs",
      title: "Run One",
      goal: "Validate link",
      run_mode: RunMode.CHAT,
      engine_binding_id: null,
      engine_class: null,
      run_state: RunState.IDLE,
      current_surface_id: null
    });

    expect(run.workspace_id).toBe("ws_runs");
    expect(run.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(run.last_active_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("listByWorkspace only returns runs from the requested workspace", async () => {
    const { workspaceRepo, runRepo } = createRunRepos();
    await workspaceRepo.create({
      workspace_id: "ws_a",
      name: "A",
      root_path: "/tmp/a",
      workspace_kind: WorkspaceKind.LOCAL_REPO,
      default_engine_binding: null,
      workspace_state: WorkspaceState.ACTIVE
    });
    await workspaceRepo.create({
      workspace_id: "ws_b",
      name: "B",
      root_path: "/tmp/b",
      workspace_kind: WorkspaceKind.DOCS_ONLY,
      default_engine_binding: null,
      workspace_state: WorkspaceState.ACTIVE
    });
    await runRepo.create({
      run_id: "run_a1",
      workspace_id: "ws_a",
      title: "A1",
      goal: null,
      run_mode: RunMode.BUILD,
      engine_binding_id: null,
      engine_class: null,
      run_state: RunState.IDLE,
      current_surface_id: null
    });
    await runRepo.create({
      run_id: "run_b1",
      workspace_id: "ws_b",
      title: "B1",
      goal: null,
      run_mode: RunMode.REVIEW,
      engine_binding_id: null,
      engine_class: null,
      run_state: RunState.ACTIVE,
      current_surface_id: null
    });

    const runs = await runRepo.listByWorkspace("ws_a");

    expect(runs).toHaveLength(1);
    expect(runs[0]?.run_id).toBe("run_a1");
  });

  it("listByWorkspace supports limit/offset with a separate count", async () => {
    const { workspaceRepo, runRepo } = createRunRepos();
    await workspaceRepo.create({
      workspace_id: "ws_page",
      name: "page",
      root_path: "/tmp/page",
      workspace_kind: WorkspaceKind.LOCAL_REPO,
      default_engine_binding: null,
      workspace_state: WorkspaceState.ACTIVE
    });
    for (const id of ["run_page_1", "run_page_2", "run_page_3"]) {
      await runRepo.create({
        run_id: id,
        workspace_id: "ws_page",
        title: id,
        goal: null,
        run_mode: RunMode.CHAT,
        engine_binding_id: null,
        engine_class: null,
        run_state: RunState.IDLE,
        current_surface_id: null
      });
    }

    const page = await runRepo.listByWorkspace("ws_page", { limit: 1, offset: 1 });

    expect(page.map((run) => run.run_id)).toEqual(["run_page_2"]);
    await expect(runRepo.countByWorkspace("ws_page")).resolves.toBe(3);
  });

  it("updateState returns an updated run without mutating prior results", async () => {
    const { workspaceRepo, runRepo } = createRunRepos();
    await workspaceRepo.create({
      workspace_id: "ws_state",
      name: "state",
      root_path: "/tmp/state",
      workspace_kind: WorkspaceKind.MIXED,
      default_engine_binding: null,
      workspace_state: WorkspaceState.ACTIVE
    });
    await runRepo.create({
      run_id: "run_state",
      workspace_id: "ws_state",
      title: "stateful",
      goal: null,
      run_mode: RunMode.ANALYZE,
      engine_binding_id: null,
      engine_class: null,
      run_state: RunState.IDLE,
      current_surface_id: null
    });

    const original = await runRepo.getById("run_state");
    const updated = await runRepo.updateState("run_state", RunState.ACTIVE);

    expect(original?.run_state).toBe(RunState.IDLE);
    expect(updated.run_state).toBe(RunState.ACTIVE);
    expect(updated.last_active_at >= (original?.last_active_at ?? "")).toBe(true);
  });

  it("delete removes an existing run", async () => {
    const { workspaceRepo, runRepo } = createRunRepos();
    await workspaceRepo.create({
      workspace_id: "ws_delete_run",
      name: "delete run",
      root_path: "/tmp/delete-run",
      workspace_kind: WorkspaceKind.LOCAL_REPO,
      default_engine_binding: null,
      workspace_state: WorkspaceState.ACTIVE
    });
    await runRepo.create({
      run_id: "run_delete",
      workspace_id: "ws_delete_run",
      title: "delete me",
      goal: null,
      run_mode: RunMode.CHAT,
      engine_binding_id: null,
      engine_class: null,
      run_state: RunState.IDLE,
      current_surface_id: null
    });

    await runRepo.delete("run_delete");

    await expect(runRepo.getById("run_delete")).resolves.toBeNull();
  });

  it("create surfaces a storage error when the workspace is missing", async () => {
    const { runRepo } = createRunRepos();

    expect(() =>
      runRepo.create({
        run_id: "run_missing_workspace",
        workspace_id: "ws_unknown",
        title: "missing",
        goal: null,
        run_mode: RunMode.CHAT,
        engine_binding_id: null,
        engine_class: null,
        run_state: RunState.IDLE,
        current_surface_id: null
      })
    ).toThrow(StorageError);
  });

  it("updateState throws not found for a missing run", async () => {
    const { runRepo } = createRunRepos();

    await expect(runRepo.updateState("run_missing", RunState.ARCHIVED)).rejects.toMatchObject({
      code: "NOT_FOUND"
    });
  });
});

function createRunRepos(): {
  workspaceRepo: SqliteWorkspaceRepo;
  runRepo: SqliteRunRepo;
} {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);
  return {
    workspaceRepo: new SqliteWorkspaceRepo(database),
    runRepo: new SqliteRunRepo(database)
  };
}
