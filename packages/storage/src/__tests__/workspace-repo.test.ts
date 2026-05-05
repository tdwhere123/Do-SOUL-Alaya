import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceKind, WorkspaceState } from "@do-soul/alaya-protocol";
import { initDatabase } from "../db.js";
import { SqliteWorkspaceRepo } from "../repos/workspace-repo.js";

const databases = new Set<ReturnType<typeof initDatabase>>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

describe("SqliteWorkspaceRepo", () => {
  it("create returns a complete workspace with created_at", async () => {
    const workspaceRepo = createWorkspaceRepo();

    const workspace = await workspaceRepo.create({
      workspace_id: "ws_alpha",
      name: "alpha",
      root_path: "/tmp/alpha",
      workspace_kind: WorkspaceKind.LOCAL_REPO,
      default_engine_binding: null,
      workspace_state: WorkspaceState.ACTIVE
    });

    expect(workspace.workspace_id).toBe("ws_alpha");
    expect(workspace.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(workspace.archived_at).toBeNull();
    expect(workspace.default_engine_class).toBeNull();
  });

  it("getById returns an existing workspace and null for a missing one", async () => {
    const workspaceRepo = createWorkspaceRepo();
    await workspaceRepo.create({
      workspace_id: "ws_existing",
      name: "existing",
      root_path: "/tmp/existing",
      workspace_kind: WorkspaceKind.DOCS_ONLY,
      default_engine_binding: "engine_default",
      workspace_state: WorkspaceState.ACTIVE
    });

    await expect(workspaceRepo.getById("ws_existing")).resolves.toMatchObject({
      workspace_id: "ws_existing",
      default_engine_binding: "engine_default"
    });
    await expect(workspaceRepo.getById("ws_missing")).resolves.toBeNull();
  });

  it("list starts empty and grows after create", async () => {
    const workspaceRepo = createWorkspaceRepo();

    await expect(workspaceRepo.list()).resolves.toEqual([]);

    await workspaceRepo.create({
      workspace_id: "ws_one",
      name: "one",
      root_path: "/tmp/one",
      workspace_kind: WorkspaceKind.MIXED,
      default_engine_binding: null,
      workspace_state: WorkspaceState.ACTIVE
    });

    const workspaces = await workspaceRepo.list();
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]?.workspace_id).toBe("ws_one");
  });

  it("delete removes an existing workspace", async () => {
    const workspaceRepo = createWorkspaceRepo();
    await workspaceRepo.create({
      workspace_id: "ws_delete",
      name: "delete",
      root_path: "/tmp/delete",
      workspace_kind: WorkspaceKind.LOCAL_REPO,
      default_engine_binding: null,
      workspace_state: WorkspaceState.ACTIVE
    });

    await workspaceRepo.delete("ws_delete");

    await expect(workspaceRepo.getById("ws_delete")).resolves.toBeNull();
  });

  it("delete is idempotent for a missing workspace", async () => {
    const workspaceRepo = createWorkspaceRepo();

    expect(workspaceRepo.delete("ws_missing")).toBeUndefined();
  });

  it("updates the workspace default_engine_binding", async () => {
    const workspaceRepo = createWorkspaceRepo();
    await workspaceRepo.create({
      workspace_id: "ws_binding",
      name: "binding",
      root_path: "/tmp/binding",
      workspace_kind: WorkspaceKind.LOCAL_REPO,
      default_engine_binding: null,
      workspace_state: WorkspaceState.ACTIVE
    });

    const updated = await workspaceRepo.updateDefaultEngineBinding("ws_binding", "binding_default");

    expect(updated).toMatchObject({
      workspace_id: "ws_binding",
      default_engine_binding: "binding_default"
    });
    await expect(workspaceRepo.getById("ws_binding")).resolves.toMatchObject({
      workspace_id: "ws_binding",
      default_engine_binding: "binding_default"
    });
  });

  it("updates the workspace default_engine_class", async () => {
    const workspaceRepo = createWorkspaceRepo();
    await workspaceRepo.create({
      workspace_id: "ws_engine_class",
      name: "engine class",
      root_path: "/tmp/engine-class",
      workspace_kind: WorkspaceKind.LOCAL_REPO,
      default_engine_binding: null,
      workspace_state: WorkspaceState.ACTIVE
    });

    const updated = await workspaceRepo.updateDefaultEngineClass("ws_engine_class", "coding_engine");

    expect(updated).toMatchObject({
      workspace_id: "ws_engine_class",
      default_engine_class: "coding_engine"
    });
    await expect(workspaceRepo.getById("ws_engine_class")).resolves.toMatchObject({
      workspace_id: "ws_engine_class",
      default_engine_class: "coding_engine"
    });
  });

  it("round-trips repo_path and defaults legacy rows to null", async () => {
    const database = initDatabase({ filename: ":memory:" });
    databases.add(database);
    const workspaceRepo = new SqliteWorkspaceRepo(database);

    const created = await workspaceRepo.create({
      workspace_id: "ws_repo_path",
      name: "repo path",
      root_path: "/tmp/repo-path",
      workspace_kind: WorkspaceKind.LOCAL_REPO,
      repo_path: "/tmp/repo-path/.git-root",
      default_engine_binding: null,
      workspace_state: WorkspaceState.ACTIVE
    } as any);

    expect(created.repo_path).toBe("/tmp/repo-path/.git-root");

    database.connection
      .prepare(`
        INSERT INTO workspaces (
          workspace_id,
          name,
          root_path,
          workspace_kind,
          default_engine_binding,
          default_engine_class,
          workspace_state,
          created_at,
          archived_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        "ws_legacy_repo_path",
        "legacy",
        "/tmp/legacy",
        WorkspaceKind.LOCAL_REPO,
        null,
        null,
        WorkspaceState.ACTIVE,
        "2026-04-23T00:00:00.000Z",
        null
      );

    await expect(workspaceRepo.getById("ws_legacy_repo_path")).resolves.toMatchObject({
      workspace_id: "ws_legacy_repo_path",
      repo_path: null
    });
  });
});

function createWorkspaceRepo(): SqliteWorkspaceRepo {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);
  return new SqliteWorkspaceRepo(database);
}
