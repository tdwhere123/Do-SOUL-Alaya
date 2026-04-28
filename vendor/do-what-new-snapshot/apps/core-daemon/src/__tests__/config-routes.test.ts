import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_ENVIRONMENT_CONFIG,
  DEFAULT_SOUL_CONFIG,
  DEFAULT_STRATEGY_CONFIG,
  WorkspaceKind
} from "@do-what/protocol";
import {
  EventPublisher,
  RunHotStateService,
  RunService,
  WorkspaceService
} from "@do-what/core";
import {
  SqliteConfigRepo,
  SqliteEngineBindingRepo,
  SqliteEventLogRepo,
  SqliteRunRepo,
  SqliteWorkspaceRepo,
  initDatabase,
  type StorageDatabase
} from "@do-what/storage";
import { createApp } from "../app.js";
import { createConfigService } from "../services/config-service.js";
import { createEnvironmentStatusService } from "../services/environment-status-service.js";
import { SseManager } from "../sse/sse-manager.js";
import {
  createNoopConversationService,
  createStubEngineBindingService,
  createUnusedClaimService,
  createUnusedEvidenceService,
  createUnusedMemoryService,
  createUnusedProposalService,
  createUnusedSignalService,
  createUnusedSlotService,
  createUnusedSynthesisService
} from "./helpers/mock-services.js";

interface TestContext {
  readonly app: ReturnType<typeof createApp>;
  readonly database: StorageDatabase;
  readonly eventLogRepo: SqliteEventLogRepo;
}

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

describe("config routes", () => {
  it("returns section defaults for a workspace", async () => {
    const { app } = createTestContext();
    const workspace = await createWorkspace(app, "config-defaults");

    const soulResponse = await app.request(`/workspaces/${workspace.workspace_id}/config/soul`);
    expect(soulResponse.status).toBe(200);
    await expect(soulResponse.json()).resolves.toEqual({
      success: true,
      data: DEFAULT_SOUL_CONFIG
    });

    const strategyResponse = await app.request(`/workspaces/${workspace.workspace_id}/config/strategy`);
    expect(strategyResponse.status).toBe(200);
    await expect(strategyResponse.json()).resolves.toEqual({
      success: true,
      data: DEFAULT_STRATEGY_CONFIG
    });

    const environmentResponse = await app.request(`/workspaces/${workspace.workspace_id}/config/environment`);
    expect(environmentResponse.status).toBe(200);
    await expect(environmentResponse.json()).resolves.toEqual({
      success: true,
      data: DEFAULT_ENVIRONMENT_CONFIG
    });
  });

  it("patches and persists config sections without appending new event log entries", async () => {
    const { app, eventLogRepo } = createTestContext();
    const workspace = await createWorkspace(app, "config-patch");
    const baselineEvents = await eventLogRepo.queryByWorkspace(workspace.workspace_id);

    const soulPatchResponse = await app.request(`/workspaces/${workspace.workspace_id}/config/soul`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        local_heuristics_enabled: false,
        garden_backlog_soft_limit: 250
      })
    });
    expect(soulPatchResponse.status).toBe(200);
    await expect(soulPatchResponse.json()).resolves.toEqual({
      success: true,
      data: {
        ...DEFAULT_SOUL_CONFIG,
        local_heuristics_enabled: false,
        garden_backlog_soft_limit: 250
      }
    });

    const strategyPatchResponse = await app.request(`/workspaces/${workspace.workspace_id}/config/strategy`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        auto_approve_readonly: true
      })
    });
    expect(strategyPatchResponse.status).toBe(200);
    await expect(strategyPatchResponse.json()).resolves.toEqual({
      success: true,
      data: {
        ...DEFAULT_STRATEGY_CONFIG,
        auto_approve_readonly: true
      }
    });

    const environmentPatchResponse = await app.request(`/workspaces/${workspace.workspace_id}/config/environment`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        env_vars: {
          OPENAI_API_KEY: "sk-live",
          NODE_ENV: "development"
        },
        worktree_enabled: true
      })
    });
    expect(environmentPatchResponse.status).toBe(200);
    await expect(environmentPatchResponse.json()).resolves.toEqual({
      success: true,
      data: {
        env_vars: {
          OPENAI_API_KEY: "sk-live",
          NODE_ENV: "development"
        },
        worktree_enabled: true
      }
    });

    const environmentGetResponse = await app.request(`/workspaces/${workspace.workspace_id}/config/environment`);
    expect(environmentGetResponse.status).toBe(200);
    await expect(environmentGetResponse.json()).resolves.toEqual({
      success: true,
      data: {
        env_vars: {
          OPENAI_API_KEY: "sk-live",
          NODE_ENV: "development"
        },
        worktree_enabled: true
      }
    });

    const eventsAfterPatches = await eventLogRepo.queryByWorkspace(workspace.workspace_id);
    expect(eventsAfterPatches).toHaveLength(baselineEvents.length);
  });

  it("returns 404 when the workspace does not exist", async () => {
    const { app } = createTestContext();

    const response = await app.request("/workspaces/ws_missing/config/soul");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Resource not found"
    });
  });

  it("returns environment status with toolchain and storage metadata", async () => {
    const { app } = createTestContext();
    const workspace = await createWorkspace(app, "config-status");

    const response = await app.request(`/workspaces/${workspace.workspace_id}/environment-status`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        tools: {
          git: true,
          node: true,
          pnpm: false,
          rg: true
        },
        active_worktrees: 3,
        db_path: ":memory:",
        files_dir: "/tmp/do-what-files"
      }
    });
  });
});

function createTestContext(): TestContext {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);

  const workspaceRepo = new SqliteWorkspaceRepo(database);
  const runRepo = new SqliteRunRepo(database);
  const bindingRepo = new SqliteEngineBindingRepo(database);
  const configRepo = new SqliteConfigRepo(database);
  const eventLogRepo = new SqliteEventLogRepo(database);
  const runHotStateService = new RunHotStateService({ runRepo, eventLogRepo });
  const sseManager = new SseManager(eventLogRepo);
  const eventPublisher = new EventPublisher({
    eventLogRepo,
    runHotStateService,
    sseBroadcaster: sseManager
  });

  const workspaceService = new WorkspaceService({
    workspaceRepo,
    runRepo,
    eventPublisher
  });
  const runService = new RunService({
    workspaceRepo,
    runRepo,
    eventPublisher
  });

  const configService = createConfigService({
    configRepo
  });
  const environmentStatusService = createEnvironmentStatusService({
    toolNames: ["git", "node", "pnpm", "rg"],
    probeTool: async (toolName) => toolName !== "pnpm",
    countActiveWorktrees: async () => 3,
    getDatabasePath: () => database.filename,
    getFilesDirectory: () => "/tmp/do-what-files"
  });

  return {
    app: createApp({
      workspaceService,
      runService,
      conversationService: createNoopConversationService("config routes") as any,
      engineBindingService: createStubEngineBindingService() as any,
      runHotStateService,
      sseManager,
      signalService: createUnusedSignalService("config routes") as any,
      evidenceService: createUnusedEvidenceService("config routes") as any,
      memoryService: createUnusedMemoryService("config routes") as any,
      slotService: createUnusedSlotService("config routes") as any,
      synthesisService: createUnusedSynthesisService("config routes") as any,
      claimService: createUnusedClaimService("config routes") as any,
      proposalService: createUnusedProposalService("config routes") as any,
      configService,
      environmentStatusService
    }),
    database,
    eventLogRepo
  };
}

async function createWorkspace(app: ReturnType<typeof createApp>, name: string): Promise<{
  readonly workspace_id: string;
}> {
  const response = await app.request("/workspaces", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name,
      root_path: `/tmp/${name}`,
      workspace_kind: WorkspaceKind.LOCAL_REPO
    })
  });

  expect(response.status).toBe(201);
  const body = (await response.json()) as { readonly data: { readonly workspace_id: string } };
  return body.data;
}
