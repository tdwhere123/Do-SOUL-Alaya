import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceKind, type SynthesisCapsule } from "@do-what/protocol";
import {
  EvidenceService,
  EventPublisher,
  MemoryService,
  RunHotStateService,
  RunService,
  SynthesisService,
  WorkspaceService
} from "@do-what/core";
import {
  SqliteEventLogRepo,
  SqliteEvidenceCapsuleRepo,
  SqliteMemoryEntryRepo,
  SqliteRunRepo,
  SqliteSynthesisCapsuleRepo,
  SqliteWorkspaceRepo,
  initDatabase,
  type StorageDatabase
} from "@do-what/storage";
import { createApp } from "../app.js";
import {
  configureWorkspacePrincipalCodingEngine,
  createNoopConversationService,
  createStubEngineBindingService,
  createUnusedClaimService,
  createUnusedProposalService,
  createUnusedSignalService,
  createUnusedSlotService,
  createUnusedSurfaceService
} from "./helpers/mock-services.js";
import { SseManager } from "../sse/sse-manager.js";

interface TestContext {
  readonly app: ReturnType<typeof createApp>;
  readonly database: StorageDatabase;
  readonly synthesisService: SynthesisService;
}

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

describe("synthesis routes", () => {
  it("lists synthesis capsules by workspace", async () => {
    const { app, synthesisService } = createTestContext();
    const workspace = await createWorkspace(app, "synthesis-workspace");
    const runId = await createRun(app, workspace.workspace_id, "synthesis run");

    await createSynthesis(synthesisService, workspace.workspace_id, runId, "tooling/pnpm");

    const response = await app.request(`/workspaces/${workspace.workspace_id}/syntheses`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: [
        expect.objectContaining({
          object_kind: "synthesis_capsule",
          workspace_id: workspace.workspace_id,
          run_id: runId,
          topic_key: "tooling/pnpm"
        })
      ]
    });
  });

  it("returns synthesis by id", async () => {
    const { app, synthesisService } = createTestContext();
    const workspace = await createWorkspace(app, "synthesis-by-id");
    const runId = await createRun(app, workspace.workspace_id, "synthesis id run");

    const created = await createSynthesis(synthesisService, workspace.workspace_id, runId, "security/keys");

    const response = await app.request(`/syntheses/${created.object_id}`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        object_id: created.object_id,
        workspace_id: workspace.workspace_id,
        run_id: runId,
        topic_key: "security/keys"
      }
    });
  });

  it("returns 404 when synthesis is missing", async () => {
    const { app } = createTestContext();

    const response = await app.request("/syntheses/85b3671a-d8d8-4848-9e5c-07d0a89f5ae9");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Resource not found"
    });
  });

  it("returns 404 when workspace does not exist for synthesis list", async () => {
    const { app } = createTestContext();

    const response = await app.request("/workspaces/ws_missing/syntheses");

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
  const memoryEntryRepo = new SqliteMemoryEntryRepo(database);
  const synthesisCapsuleRepo = new SqliteSynthesisCapsuleRepo(database);
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
  const memoryService = new MemoryService({
    memoryEntryRepo,
    evidenceService,
    eventLogRepo,
    sseBroadcaster: sseManager
  });
  const synthesisService = new SynthesisService({
    synthesisCapsuleRepo,
    evidenceService,
    memoryService,
    eventLogRepo,
    sseBroadcaster: sseManager
  });

  return {
    app: createApp({
      workspaceService,
      runService,
      principalCodingEngineAvailable: true,
      conversationService: createNoopConversationService("synthesis route tests") as any,
      engineBindingService: createStubEngineBindingService() as any,
      runHotStateService,
      sseManager,
      signalService: createUnusedSignalService("synthesis route tests") as any,
      evidenceService,
      memoryService,
      slotService: createUnusedSlotService("synthesis route tests") as any,
      surfaceService: createUnusedSurfaceService("synthesis route tests") as any,
      synthesisService,
      claimService: createUnusedClaimService("synthesis route tests") as any,
      proposalService: createUnusedProposalService("synthesis route tests") as any
    }),
    database,
    synthesisService
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

async function createSynthesis(
  synthesisService: SynthesisService,
  workspaceId: string,
  runId: string,
  topicKey: string
): Promise<Readonly<SynthesisCapsule>> {
  return await synthesisService.create({
    created_by: "user_action",
    topic_key: topicKey,
    synthesis_type: "phase_synthesis",
    summary: "Synthesis summary",
    evidence_refs: [],
    source_memory_refs: [],
    workspace_id: workspaceId,
    run_id: runId
  });
}


