import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EngineProvider, WorkspaceKind, WorkspaceState } from "@do-soul/alaya-protocol";
import { initDatabase } from "../../../sqlite/db.js";
import { SqliteEngineBindingRepo } from "../../../repos/control/engine-binding-repo.js";
import { SqliteWorkspaceRepo } from "../../../repos/runtime/workspace-repo.js";

const databases = new Set<ReturnType<typeof initDatabase>>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

describe("SqliteEngineBindingRepo", () => {
  it("upserts and reloads a binding record", async () => {
    const { workspaceRepo, bindingRepo } = createRepos();
    await workspaceRepo.create({
      workspace_id: "ws_alpha",
      name: "alpha",
      root_path: "/tmp/alpha",
      workspace_kind: WorkspaceKind.LOCAL_REPO,
      default_engine_binding: null,
      workspace_state: WorkspaceState.ACTIVE
    });

    const created = await bindingRepo.upsert({
      binding_id: "binding_alpha",
      workspace_id: "ws_alpha",
      provider_type: EngineProvider.OPENAI,
      base_url: null,
      api_key: "sk-alpha",
      model: "gpt-4o-mini",
      config: {}
    });

    expect(created).toMatchObject({
      binding_id: "binding_alpha",
      workspace_id: "ws_alpha",
      provider_type: EngineProvider.OPENAI,
      api_key: "sk-alpha"
    });
    await expect(bindingRepo.getById("binding_alpha")).resolves.toMatchObject({
      binding_id: "binding_alpha",
      workspace_id: "ws_alpha",
      model: "gpt-4o-mini"
    });
  });

  it("preserves created_at and updates updated_at on repeated upsert", async () => {
    const { workspaceRepo, bindingRepo } = createRepos();
    await workspaceRepo.create({
      workspace_id: "ws_beta",
      name: "beta",
      root_path: "/tmp/beta",
      workspace_kind: WorkspaceKind.LOCAL_REPO,
      default_engine_binding: null,
      workspace_state: WorkspaceState.ACTIVE
    });

    const first = await bindingRepo.upsert({
      binding_id: "binding_beta",
      workspace_id: "ws_beta",
      provider_type: EngineProvider.OPENAI,
      base_url: null,
      api_key: "sk-beta",
      model: "gpt-4o-mini",
      config: {}
    });
    const second = await bindingRepo.upsert({
      binding_id: "binding_beta",
      workspace_id: "ws_beta",
      provider_type: EngineProvider.CUSTOM,
      base_url: "https://example.test/v1",
      api_key: "sk-beta-next",
      model: "custom-model",
      config: { compatibility: "openai" }
    });

    expect(second.created_at).toBe(first.created_at);
    expect(second.updated_at >= first.updated_at).toBe(true);
    expect(second).toMatchObject({
      provider_type: EngineProvider.CUSTOM,
      base_url: "https://example.test/v1",
      api_key: "sk-beta-next",
      model: "custom-model"
    });
  });

  it("persists api_key_ref bindings without an inline api key", async () => {
    const { workspaceRepo, bindingRepo } = createRepos();
    await workspaceRepo.create({
      workspace_id: "ws_ref",
      name: "ref",
      root_path: "/tmp/ref",
      workspace_kind: WorkspaceKind.LOCAL_REPO,
      default_engine_binding: null,
      workspace_state: WorkspaceState.ACTIVE
    });

    const created = await bindingRepo.upsert({
      binding_id: "binding_ref",
      workspace_id: "ws_ref",
      provider_type: EngineProvider.OPENAI,
      base_url: null,
      api_key: "",
      api_key_ref: "OPENAI_API_KEY",
      model: "gpt-4o-mini",
      config: {}
    });

    expect(created).toMatchObject({
      binding_id: "binding_ref",
      api_key: "",
      api_key_ref: "OPENAI_API_KEY"
    });
    await expect(bindingRepo.getById("binding_ref")).resolves.toMatchObject({
      binding_id: "binding_ref",
      api_key: "",
      api_key_ref: "OPENAI_API_KEY"
    });
  });

  it("lists bindings by workspace", async () => {
    const { workspaceRepo, bindingRepo } = createRepos();
    await workspaceRepo.create({
      workspace_id: "ws_gamma",
      name: "gamma",
      root_path: "/tmp/gamma",
      workspace_kind: WorkspaceKind.LOCAL_REPO,
      default_engine_binding: null,
      workspace_state: WorkspaceState.ACTIVE
    });
    await workspaceRepo.create({
      workspace_id: "ws_delta",
      name: "delta",
      root_path: "/tmp/delta",
      workspace_kind: WorkspaceKind.LOCAL_REPO,
      default_engine_binding: null,
      workspace_state: WorkspaceState.ACTIVE
    });

    await bindingRepo.upsert({
      binding_id: "binding_gamma_1",
      workspace_id: "ws_gamma",
      provider_type: EngineProvider.OPENAI,
      base_url: null,
      api_key: "sk-1",
      model: "gpt-4o-mini",
      config: {}
    });
    await bindingRepo.upsert({
      binding_id: "binding_delta_1",
      workspace_id: "ws_delta",
      provider_type: EngineProvider.OPENAI,
      base_url: null,
      api_key: "sk-2",
      model: "gpt-4o-mini",
      config: {}
    });
    await bindingRepo.upsert({
      binding_id: "binding_gamma_2",
      workspace_id: "ws_gamma",
      provider_type: EngineProvider.ANTHROPIC,
      base_url: null,
      api_key: "sk-3",
      model: "claude-sonnet-4-5",
      config: { max_tokens: 1024 }
    });

    await expect(bindingRepo.listByWorkspace("ws_gamma")).resolves.toEqual([
      expect.objectContaining({ binding_id: "binding_gamma_1" }),
      expect.objectContaining({ binding_id: "binding_gamma_2" })
    ]);
  });

  it("survives database connection closure and reopening", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "alaya-repo-test-"));
    const tempFile = path.join(tempDir, "alaya.db");
    let database: ReturnType<typeof initDatabase> | undefined;
    try {
      database = initDatabase({ filename: tempFile });
      databases.add(database);
      const workspaceRepo = new SqliteWorkspaceRepo(database);
      const bindingRepo = new SqliteEngineBindingRepo(database);

      await workspaceRepo.create({
        workspace_id: "ws_survive",
        name: "survive",
        root_path: "/tmp/survive",
        workspace_kind: WorkspaceKind.LOCAL_REPO,
        default_engine_binding: null,
        workspace_state: WorkspaceState.ACTIVE
      });

      await bindingRepo.upsert({
        binding_id: "binding_survive",
        workspace_id: "ws_survive",
        provider_type: EngineProvider.OPENAI,
        base_url: null,
        api_key: "sk-survive",
        model: "gpt-4o-mini",
        config: {}
      });

      // Close the database connection
      database.close();

      // Reopen it
      database.reopenIfClosed();

      // Attempt to access the repo
      await expect(bindingRepo.getById("binding_survive")).resolves.toMatchObject({
        binding_id: "binding_survive"
      });
    } finally {
      if (database !== undefined) {
        database.close();
        databases.delete(database);
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

function createRepos(): {
  readonly workspaceRepo: SqliteWorkspaceRepo;
  readonly bindingRepo: SqliteEngineBindingRepo;
} {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);

  return {
    workspaceRepo: new SqliteWorkspaceRepo(database),
    bindingRepo: new SqliteEngineBindingRepo(database)
  };
}
