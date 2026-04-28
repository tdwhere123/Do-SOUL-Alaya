import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceKind } from "@do-what/protocol";
import {
  EventPublisher,
  RunHotStateService,
  RunService,
  WorkspaceService
} from "@do-what/core";
import {
  SqliteEngineBindingRepo,
  SqliteEventLogRepo,
  SqliteRunRepo,
  SqliteWorkspaceRepo,
  initDatabase,
  type StorageDatabase
} from "@do-what/storage";
import { createApp } from "../app.js";
import {
  configureWorkspacePrincipalConversationEngine,
  createUnusedClaimService,
  createUnusedEvidenceService,
  createUnusedMemoryService,
  createUnusedProposalService,
  createUnusedSignalService,
  createUnusedSlotService,
  createUnusedSurfaceService,
  createUnusedSynthesisService
} from "./helpers/mock-services.js";
import { SseManager } from "../sse/sse-manager.js";
import { SqliteWorkspaceEngineConfigRepo } from "../services/workspace-engine-config-repo.js";

// RED: PATCH /runs/:id route does not exist yet — all route tests will return
// 404 (or method-not-allowed) until the implementation card lands.

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }
  databases.clear();
});

function createTestContext() {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);

  const workspaceRepo = new SqliteWorkspaceRepo(database);
  const runRepo = new SqliteRunRepo(database);
  const bindingRepo = new SqliteEngineBindingRepo(database);
  const workspaceEngineConfigRepo = new SqliteWorkspaceEngineConfigRepo(database);
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
    eventPublisher,
    engineConfigRepo: workspaceEngineConfigRepo
  });
  const runService = new RunService({
    workspaceRepo,
    runRepo,
    eventPublisher,
    isPrincipalCodingEngineAvailable: () => true,
    bindingRepo
  });

  return {
    app: createApp({
      workspaceService,
      runService,
      runHotStateService,
      eventLogRepo,
      sseManager,
      principalCodingEngineAvailable: true,
      signalService: createUnusedSignalService("runs-rename-route tests") as any,
      evidenceService: createUnusedEvidenceService("runs-rename-route tests") as any,
      memoryService: createUnusedMemoryService("runs-rename-route tests") as any,
      slotService: createUnusedSlotService("runs-rename-route tests") as any,
      surfaceService: createUnusedSurfaceService("runs-rename-route tests") as any,
      synthesisService: createUnusedSynthesisService("runs-rename-route tests") as any,
      claimService: createUnusedClaimService("runs-rename-route tests") as any,
      proposalService: createUnusedProposalService("runs-rename-route tests") as any
    } as any),
    eventLogRepo
  };
}

async function createWorkspace(
  app: ReturnType<typeof createApp>,
  name: string
): Promise<{ readonly workspace_id: string }> {
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
  const body = (await response.json()) as any;
  const workspace = body.data;
  await configureWorkspacePrincipalConversationEngine(app, workspace.workspace_id);
  return workspace;
}

async function createRun(
  app: ReturnType<typeof createApp>,
  workspaceId: string,
  title: string
): Promise<string> {
  const response = await app.request(`/workspaces/${workspaceId}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title, goal: null, run_mode: "chat" })
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as any;
  return body.data.run_id as string;
}

describe("PATCH /runs/:id (rename route)", () => {
  it("returns 200 and the updated run when title is valid", async () => {
    const { app } = createTestContext();
    const workspace = await createWorkspace(app, "rename-happy");
    const runId = await createRun(app, workspace.workspace_id, "original title");

    // RED: route does not exist yet — expects 200 but will receive 404 / 405
    const response = await app.request(`/runs/${runId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "renamed title" })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        run_id: runId,
        title: "renamed title"
      }
    });
  });

  it("returns 400 for an empty title", async () => {
    const { app } = createTestContext();
    const workspace = await createWorkspace(app, "rename-empty-title");
    const runId = await createRun(app, workspace.workspace_id, "original title");

    const response = await app.request(`/runs/${runId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "" })
    });

    expect(response.status).toBe(400);
  });

  it("returns 404 when the run id does not exist", async () => {
    const { app } = createTestContext();
    await createWorkspace(app, "rename-not-found");

    const response = await app.request("/runs/run_does_not_exist", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "valid title" })
    });

    expect(response.status).toBe(404);
  });

  it("returns 400 for a malformed JSON body", async () => {
    const { app } = createTestContext();
    const workspace = await createWorkspace(app, "rename-bad-json");
    const runId = await createRun(app, workspace.workspace_id, "original title");

    const response = await app.request(`/runs/${runId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "not valid json {"
    });

    expect(response.status).toBe(400);
  });
});
