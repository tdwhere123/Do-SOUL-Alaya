import { describe, expect, it, vi } from "vitest";
import type { SoulGraph } from "@do-what/protocol";
import {
  CoreError,
  EventPublisher,
  RunHotStateService,
  RunService,
  WorkspaceService
} from "@do-what/core";
import {
  SqliteEventLogRepo,
  SqliteRunRepo,
  SqliteWorkspaceRepo,
  initDatabase
} from "@do-what/storage";
import { WorkspaceKind } from "@do-what/protocol";
import { createApp, type CoreDaemonServices } from "../../app.js";
import {
  configureWorkspacePrincipalCodingEngine,
  createNoopConversationService,
  createStubEngineBindingService,
  createUnusedClaimService,
  createUnusedEvidenceService,
  createUnusedMemoryService,
  createUnusedProposalService,
  createUnusedSignalService,
  createUnusedSlotService,
  createUnusedSurfaceService,
  createUnusedSynthesisService
} from "../helpers/mock-services.js";
import { SseManager } from "../../sse/sse-manager.js";

describe("soul graph route", () => {
  it("returns the workspace graph from the distinct graph route", async () => {
    const { app, soulGraphService } = createTestContext();
    const workspace = await createWorkspace(app, "soul-graph-route");

    const response = await app.request(`/workspaces/${workspace.workspace_id}/soul/graph?depth=2&limit=25`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: createSoulGraphFixture(workspace.workspace_id)
    });
    expect(soulGraphService.buildSoulGraph).toHaveBeenCalledWith({
      workspaceId: workspace.workspace_id,
      depth: 2,
      limit: 25
    });
  });

  it("uses the protocol defaults when graph query params are omitted", async () => {
    const { app, soulGraphService } = createTestContext();
    const workspace = await createWorkspace(app, "soul-graph-defaults");

    const response = await app.request(`/workspaces/${workspace.workspace_id}/soul/graph`);

    expect(response.status).toBe(200);
    expect(soulGraphService.buildSoulGraph).toHaveBeenCalledWith({
      workspaceId: workspace.workspace_id,
      depth: 2,
      limit: 500
    });
  });

  it("accepts depth three as part of the public graph contract", async () => {
    const { app, soulGraphService } = createTestContext();
    const workspace = await createWorkspace(app, "soul-graph-depth-three");

    const response = await app.request(`/workspaces/${workspace.workspace_id}/soul/graph?depth=3`);

    expect(response.status).toBe(200);
    expect(soulGraphService.buildSoulGraph).toHaveBeenCalledWith({
      workspaceId: workspace.workspace_id,
      depth: 3,
      limit: 500
    });
  });

  it("returns 400 when depth exceeds the supported 1..3 range", async () => {
    const { app, soulGraphService } = createTestContext();
    const workspace = await createWorkspace(app, "soul-graph-invalid-depth");

    const response = await app.request(`/workspaces/${workspace.workspace_id}/soul/graph?depth=4`);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Invalid request"
    });
    expect(soulGraphService.buildSoulGraph).not.toHaveBeenCalled();
  });

  it("returns 400 when limit is outside the supported range", async () => {
    const { app, soulGraphService } = createTestContext();
    const workspace = await createWorkspace(app, "soul-graph-invalid-limit");

    const response = await app.request(`/workspaces/${workspace.workspace_id}/soul/graph?limit=2001`);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Invalid request"
    });
    expect(soulGraphService.buildSoulGraph).not.toHaveBeenCalled();
  });

  it("returns 400 when depth is a malformed decimal instead of an integer", async () => {
    const { app, soulGraphService } = createTestContext();
    const workspace = await createWorkspace(app, "soul-graph-malformed-depth");

    const response = await app.request(`/workspaces/${workspace.workspace_id}/soul/graph?depth=1.5`);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Invalid request"
    });
    expect(soulGraphService.buildSoulGraph).not.toHaveBeenCalled();
  });

  it("returns 400 when limit has trailing non-numeric characters", async () => {
    const { app, soulGraphService } = createTestContext();
    const workspace = await createWorkspace(app, "soul-graph-malformed-limit");

    const response = await app.request(`/workspaces/${workspace.workspace_id}/soul/graph?limit=10foo`);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Invalid request"
    });
    expect(soulGraphService.buildSoulGraph).not.toHaveBeenCalled();
  });

  it("returns 404 when the workspace does not exist", async () => {
    const { app, soulGraphService } = createTestContext();

    const response = await app.request("/workspaces/missing-workspace/soul/graph");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Resource not found"
    });
    expect(soulGraphService.buildSoulGraph).not.toHaveBeenCalled();
  });
});

function createTestContext(): {
  readonly app: ReturnType<typeof createApp>;
  readonly soulGraphService: NonNullable<CoreDaemonServices["soulGraphService"]>;
} {
  const database = initDatabase({ filename: ":memory:" });
  const workspaceRepo = new SqliteWorkspaceRepo(database);
  const runRepo = new SqliteRunRepo(database);
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
    eventPublisher,
    isPrincipalCodingEngineAvailable: () => true
  });
  const soulGraphService: NonNullable<CoreDaemonServices["soulGraphService"]> = {
    buildSoulGraph: vi.fn(async ({ workspaceId }: {
      readonly workspaceId: string;
      readonly depth: number;
      readonly limit: number;
    }): Promise<Readonly<SoulGraph>> => createSoulGraphFixture(workspaceId))
  };

  const services = {
    workspaceService,
    runService,
    principalCodingEngineAvailable: true,
    conversationService: createNoopConversationService("soul graph route tests") as never,
    engineBindingService: createStubEngineBindingService() as never,
    runHotStateService,
    sseManager,
    signalService: createUnusedSignalService("soul graph route tests") as never,
    evidenceService: createUnusedEvidenceService("soul graph route tests") as never,
    memoryService: createUnusedMemoryService("soul graph route tests") as never,
    slotService: createUnusedSlotService("soul graph route tests") as never,
    surfaceService: createUnusedSurfaceService("soul graph route tests") as never,
    synthesisService: createUnusedSynthesisService("soul graph route tests") as never,
    claimService: createUnusedClaimService("soul graph route tests") as never,
    proposalService: createUnusedProposalService("soul graph route tests") as never,
    soulGraphService
  };

  return {
    app: createApp(services as CoreDaemonServices),
    soulGraphService
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
  const body = await response.json();
  const workspace = body.data;
  await configureWorkspacePrincipalCodingEngine(app, workspace.workspace_id);
  return workspace;
}

function createSoulGraphFixture(workspaceId: string): SoulGraph {
  return {
    workspace_id: workspaceId,
    nodes: [
      {
        id: "memory:memory-1",
        kind: "memory",
        label: "Remember repo conventions",
        scope_id: "scope:project",
        origin_plane: "project"
      },
      {
        id: "scope:project",
        kind: "scope",
        label: "project"
      }
    ],
    edges: [
      {
        id: "belongs_to:memory:memory-1:scope:project",
        kind: "belongs_to",
        source_id: "memory:memory-1",
        target_id: "scope:project"
      }
    ],
    truncated: false,
    node_total: 2,
    edge_total: 1
  };
}
