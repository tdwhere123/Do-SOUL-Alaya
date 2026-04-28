import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceKind, type EvidenceCapsule } from "@do-what/protocol";
import {
  EvidenceService,
  EventPublisher,
  RunHotStateService,
  RunService,
  WorkspaceService
} from "@do-what/core";
import {
  SqliteEvidenceCapsuleRepo,
  SqliteEventLogRepo,
  SqliteRunRepo,
  SqliteWorkspaceRepo,
  initDatabase,
  type StorageDatabase
} from "@do-what/storage";
import { createApp } from "../app.js";
import { configureWorkspacePrincipalCodingEngine, createNoopConversationService, createStubEngineBindingService, createUnusedClaimService, createUnusedMemoryService, createUnusedProposalService, createUnusedSignalService, createUnusedSlotService, createUnusedSynthesisService,
  createUnusedSurfaceService
} from "./helpers/mock-services.js";
import { SseManager } from "../sse/sse-manager.js";

interface TestContext {
  readonly app: ReturnType<typeof createApp>;
  readonly database: StorageDatabase;
  readonly evidenceService: EvidenceService;
}

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

describe("evidence routes", () => {
  it("lists evidence by run", async () => {
    const { app, evidenceService } = createTestContext();
    const workspace = await createWorkspace(app, "evidence-run");
    const runId = await createRun(app, workspace.workspace_id, "evidence run");

    await createEvidence(evidenceService, runId, workspace.workspace_id);

    const response = await app.request(`/runs/${runId}/evidence`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: [
        expect.objectContaining({
          object_kind: "evidence_capsule",
          run_id: runId,
          workspace_id: workspace.workspace_id,
          evidence_kind: "tool_output"
        })
      ]
    });
  });

  it("lists evidence by workspace", async () => {
    const { app, evidenceService } = createTestContext();
    const workspace = await createWorkspace(app, "evidence-workspace");
    const runId = await createRun(app, workspace.workspace_id, "workspace evidence run");

    await createEvidence(evidenceService, runId, workspace.workspace_id);

    const response = await app.request(`/workspaces/${workspace.workspace_id}/evidence`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: [
        expect.objectContaining({
          object_kind: "evidence_capsule",
          workspace_id: workspace.workspace_id
        })
      ]
    });
  });

  it("returns evidence by id", async () => {
    const { app, evidenceService } = createTestContext();
    const workspace = await createWorkspace(app, "evidence-by-id");
    const runId = await createRun(app, workspace.workspace_id, "id run");

    const created = await createEvidence(evidenceService, runId, workspace.workspace_id);

    const response = await app.request(`/evidence/${created.object_id}`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        object_id: created.object_id,
        run_id: runId,
        workspace_id: workspace.workspace_id
      }
    });
  });

  it("returns 404 when evidence is missing", async () => {
    const { app } = createTestContext();

    const response = await app.request("/evidence/85b3671a-d8d8-4848-9e5c-07d0a89f5ae9");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Resource not found"
    });
  });
});

function createTestContext(): TestContext {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);

  const workspaceRepo = new SqliteWorkspaceRepo(database);
  const runRepo = new SqliteRunRepo(database);
  const eventLogRepo = new SqliteEventLogRepo(database);
  const evidenceCapsuleRepo = new SqliteEvidenceCapsuleRepo(database);
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

  const evidenceService = new EvidenceService({
    evidenceCapsuleRepo,
    eventLogRepo,
    sseBroadcaster: sseManager
  });

  return {
    app: createApp({
      workspaceService,
      runService,
      principalCodingEngineAvailable: true,
      conversationService: createNoopConversationService("evidence tests") as any,
      engineBindingService: createStubEngineBindingService() as any,
      runHotStateService,
      sseManager,
      signalService: createUnusedSignalService("evidence tests") as any,
      evidenceService,
      memoryService: createUnusedMemoryService("evidence tests") as any,
      slotService: createUnusedSlotService("evidence tests") as any,
      surfaceService: createUnusedSurfaceService("evidence tests") as any,
      synthesisService: createUnusedSynthesisService("evidence tests") as any,
      claimService: createUnusedClaimService("evidence tests") as any,
      proposalService: createUnusedProposalService("evidence tests") as any
    }),
    database,
    evidenceService
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
  const body = (await response.json()) as any;
  const workspace = body.data;
  await configureWorkspacePrincipalCodingEngine(app, workspace.workspace_id);
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
    body: JSON.stringify({
      title,
      goal: null,
      run_mode: "chat"
    })
  });

  expect(response.status).toBe(201);
  const body = (await response.json()) as any;
  return body.data.run_id as string;
}

async function createEvidence(
  evidenceService: EvidenceService,
  runId: string,
  workspaceId: string
): Promise<Readonly<EvidenceCapsule>> {
  return await evidenceService.create({
    created_by: "user_action",
    evidence_kind: "tool_output",
    semantic_anchor: {
      topic: "test evidence",
      keywords: ["api", "route"],
      summary: "route verification"
    },
    event_anchor: null,
    physical_anchor: null,
    evidence_health_state: "verified",
    gist: "Evidence gist",
    excerpt: "Evidence excerpt",
    source_hash: "sha256:route",
    run_id: runId,
    workspace_id: workspaceId,
    surface_id: null
  });
}
