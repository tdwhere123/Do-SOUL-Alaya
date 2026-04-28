/**
 * FROZEN RED TESTS — L0-B runs.update_engine_binding
 *
 * Locks the daemon route contract for:
 *   PUT /runs/:id/engine-binding
 *
 * RED: the route does not exist yet. All assertions against 200 will receive
 * 404/405 until registerRunRoutes (runs.ts) adds the handler.
 *
 * Pattern mirrors runs-rename-route.test.ts: real SQLite in-memory DB,
 * real RunService, no mocks for the happy path.
 */

import { afterEach, describe, expect, it } from "vitest";
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
      signalService: createUnusedSignalService("runs-engine-binding-route tests") as any,
      evidenceService: createUnusedEvidenceService("runs-engine-binding-route tests") as any,
      memoryService: createUnusedMemoryService("runs-engine-binding-route tests") as any,
      slotService: createUnusedSlotService("runs-engine-binding-route tests") as any,
      surfaceService: createUnusedSurfaceService("runs-engine-binding-route tests") as any,
      synthesisService: createUnusedSynthesisService("runs-engine-binding-route tests") as any,
      claimService: createUnusedClaimService("runs-engine-binding-route tests") as any,
      proposalService: createUnusedProposalService("runs-engine-binding-route tests") as any
    } as any),
    eventLogRepo,
    bindingRepo
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

describe("PUT /runs/:id/engine-binding", () => {
  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  it("returns 200 and the updated run when switching to a valid workspace-owned binding", async () => {
    const { app, bindingRepo } = createTestContext();
    const workspace = await createWorkspace(app, "engine-binding-happy");
    const runId = await createRun(app, workspace.workspace_id, "test run");

    // Create a second binding in the same workspace
    // RED: bindingRepo.create API may differ — adjust once storage schema lands
    const newBinding = await (bindingRepo as any).create({
      workspace_id: workspace.workspace_id,
      provider_type: "anthropic",
      base_url: null,
      api_key: "sk-ant-new",
      model: "claude-haiku-4-5",
      config: {}
    });

    // RED: route does not exist yet — will receive 404/405 instead of 200
    const response = await app.request(`/runs/${runId}/engine-binding`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ engine_binding_id: newBinding.binding_id })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        run_id: runId,
        engine_binding_id: newBinding.binding_id
      }
    });
  });

  // -------------------------------------------------------------------------
  // 400 for missing / empty engine_binding_id
  // -------------------------------------------------------------------------

  it("returns 400 when engine_binding_id is missing from the body", async () => {
    const { app } = createTestContext();
    const workspace = await createWorkspace(app, "engine-binding-missing-field");
    const runId = await createRun(app, workspace.workspace_id, "test run");

    // RED: route does not exist — expects 400 validation error
    const response = await app.request(`/runs/${runId}/engine-binding`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });

    expect(response.status).toBe(400);
  });

  it("returns 400 when engine_binding_id is an empty string", async () => {
    const { app } = createTestContext();
    const workspace = await createWorkspace(app, "engine-binding-empty-string");
    const runId = await createRun(app, workspace.workspace_id, "test run");

    // RED: route does not exist — expects 400 validation error
    const response = await app.request(`/runs/${runId}/engine-binding`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ engine_binding_id: "" })
    });

    expect(response.status).toBe(400);
  });

  // -------------------------------------------------------------------------
  // 404 when binding has been deleted (Failure Mode #12)
  // -------------------------------------------------------------------------

  it("returns 404 with a run-specific error body when the target engine_binding_id does not exist (binding deleted)", async () => {
    const { app } = createTestContext();
    const workspace = await createWorkspace(app, "engine-binding-not-found");
    const runId = await createRun(app, workspace.workspace_id, "test run");

    // RED: route does not exist yet.
    // When the route is absent, Hono returns 404 with an empty body (no JSON).
    // Once implemented, the route must return 404 with { success: false, error: <msg> }.
    // We assert BOTH status AND a JSON body with success:false to ensure the test
    // cannot accidentally pass merely because the route is missing.
    const response = await app.request(`/runs/${runId}/engine-binding`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ engine_binding_id: "binding_definitely_does_not_exist" })
    });

    expect(response.status).toBe(404);
    // RED: Hono 404 for a missing route does not return { success: false, error: "..." }
    const body = (await response.json()) as any;
    expect(body).toMatchObject({ success: false, error: expect.any(String) });
  });

  // -------------------------------------------------------------------------
  // 409 / validation error for cross-workspace binding
  // -------------------------------------------------------------------------

  it("returns 409 (or 400) when the binding belongs to a different workspace", async () => {
    const { app, bindingRepo } = createTestContext();
    const workspace = await createWorkspace(app, "engine-binding-cross-ws");
    const otherWorkspace = await createWorkspace(app, "engine-binding-other-ws");
    const runId = await createRun(app, workspace.workspace_id, "test run");

    // Create a binding that belongs to the OTHER workspace
    // RED: bindingRepo.create API may differ
    const foreignBinding = await (bindingRepo as any).create({
      workspace_id: otherWorkspace.workspace_id,
      provider_type: "anthropic",
      base_url: null,
      api_key: "sk-ant-foreign",
      model: "claude-haiku-4-5",
      config: {}
    });

    // RED: route does not exist — expects 409 (VALIDATION cross-workspace)
    const response = await app.request(`/runs/${runId}/engine-binding`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ engine_binding_id: foreignBinding.binding_id })
    });

    // The service throws CoreError("VALIDATION") for cross-workspace; the
    // daemon error-handler maps VALIDATION → 400 or 409 depending on implementation.
    expect([400, 409]).toContain(response.status);
  });
});
