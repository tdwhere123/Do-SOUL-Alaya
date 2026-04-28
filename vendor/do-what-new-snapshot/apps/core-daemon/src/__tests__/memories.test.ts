import { afterEach, describe, expect, it } from "vitest";
import {
  FormationKind,
  MemoryDimension,
  ScopeClass,
  SourceKind,
  StorageTier,
  WorkspaceKind,
  type MemoryEntry
} from "@do-what/protocol";
import {
  EvidenceService,
  EventPublisher,
  MemoryService,
  RunHotStateService,
  RunService,
  WorkspaceService
} from "@do-what/core";
import {
  SqliteEvidenceCapsuleRepo,
  SqliteEventLogRepo,
  SqliteMemoryEntryRepo,
  SqliteRunRepo,
  SqliteWorkspaceRepo,
  initDatabase,
  type StorageDatabase
} from "@do-what/storage";
import { createApp } from "../app.js";
import { configureWorkspacePrincipalCodingEngine, createNoopConversationService, createStubEngineBindingService, createUnusedClaimService, createUnusedProposalService, createUnusedSignalService, createUnusedSlotService, createUnusedSynthesisService,
  createUnusedSurfaceService
} from "./helpers/mock-services.js";
import { SseManager } from "../sse/sse-manager.js";

interface TestContext {
  readonly app: ReturnType<typeof createApp>;
  readonly database: StorageDatabase;
  readonly memoryService: MemoryService;
}

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

describe("memory routes", () => {
  it("lists workspace memories with default hot tier", async () => {
    const { app, memoryService } = createTestContext();
    const workspace = await createWorkspace(app, "memory-workspace-hot");
    const runId = await createRun(app, workspace.workspace_id, "memory run");

    await createMemory(memoryService, {
      run_id: runId,
      workspace_id: workspace.workspace_id,
      storage_tier: StorageTier.HOT,
      content: "Hot memory"
    });
    await createMemory(memoryService, {
      run_id: runId,
      workspace_id: workspace.workspace_id,
      storage_tier: StorageTier.COLD,
      content: "Cold memory"
    });

    const response = await app.request(`/workspaces/${workspace.workspace_id}/memories`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body).toMatchObject({
      success: true,
      data: [
        expect.objectContaining({
          workspace_id: workspace.workspace_id,
          storage_tier: "hot",
          content: "Hot memory"
        })
      ]
    });
    expect(body.data).toHaveLength(1);
  });

  it("filters workspace memories by dimension", async () => {
    const { app, memoryService } = createTestContext();
    const workspace = await createWorkspace(app, "memory-workspace-dimension");
    const runId = await createRun(app, workspace.workspace_id, "memory dimension run");

    await createMemory(memoryService, {
      run_id: runId,
      workspace_id: workspace.workspace_id,
      dimension: MemoryDimension.PREFERENCE,
      content: "Preference memory"
    });
    await createMemory(memoryService, {
      run_id: runId,
      workspace_id: workspace.workspace_id,
      dimension: MemoryDimension.CONSTRAINT,
      content: "Constraint memory"
    });

    const response = await app.request(
      `/workspaces/${workspace.workspace_id}/memories?dimension=${MemoryDimension.CONSTRAINT}`
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: [
        expect.objectContaining({
          workspace_id: workspace.workspace_id,
          dimension: MemoryDimension.CONSTRAINT,
          content: "Constraint memory"
        })
      ]
    });
  });

  it("lists run memories across hot and cold tiers", async () => {
    const { app, memoryService } = createTestContext();
    const workspace = await createWorkspace(app, "memory-run-all");
    const runId = await createRun(app, workspace.workspace_id, "memory run all tiers");

    await createMemory(memoryService, {
      run_id: runId,
      workspace_id: workspace.workspace_id,
      storage_tier: StorageTier.HOT,
      content: "Run hot"
    });
    await createMemory(memoryService, {
      run_id: runId,
      workspace_id: workspace.workspace_id,
      storage_tier: StorageTier.COLD,
      content: "Run cold"
    });

    const response = await app.request(`/runs/${runId}/memories`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: expect.arrayContaining([
        expect.objectContaining({
          run_id: runId,
          storage_tier: "hot",
          content: "Run hot"
        }),
        expect.objectContaining({
          run_id: runId,
          storage_tier: "cold",
          content: "Run cold"
        })
      ])
    });
  });
  it("returns 404 when workspace does not exist for workspace memory list", async () => {
    const { app } = createTestContext();

    const response = await app.request("/workspaces/ws_missing/memories");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Resource not found"
    });
  });

  it("returns 404 when run does not exist for run memory list", async () => {
    const { app } = createTestContext();

    const response = await app.request("/runs/run_missing/memories");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Resource not found"
    });
  });

  it("returns memory by id", async () => {
    const { app, memoryService } = createTestContext();
    const workspace = await createWorkspace(app, "memory-by-id");
    const runId = await createRun(app, workspace.workspace_id, "memory id run");

    const created = await createMemory(memoryService, {
      run_id: runId,
      workspace_id: workspace.workspace_id,
      content: "Lookup memory"
    });

    const response = await app.request(`/memories/${created.object_id}`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        object_id: created.object_id,
        run_id: runId,
        workspace_id: workspace.workspace_id,
        content: "Lookup memory"
      }
    });
  });

  it("returns 404 when memory is missing", async () => {
    const { app } = createTestContext();

    const response = await app.request("/memories/85b3671a-d8d8-4848-9e5c-07d0a89f5ae9");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Resource not found"
    });
  });

  it("returns 400 when dimension filter is invalid", async () => {
    const { app } = createTestContext();
    const workspace = await createWorkspace(app, "memory-invalid-dimension");

    const response = await app.request(`/workspaces/${workspace.workspace_id}/memories?dimension=invalid`);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Invalid memory dimension"
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

  return {
    app: createApp({
      workspaceService,
      runService,
      principalCodingEngineAvailable: true,
      conversationService: createNoopConversationService("memory route tests") as any,
      engineBindingService: createStubEngineBindingService() as any,
      runHotStateService,
      sseManager,
      signalService: createUnusedSignalService("memory route tests") as any,
      evidenceService,
      memoryService,
      slotService: createUnusedSlotService("memory route tests") as any,
      surfaceService: createUnusedSurfaceService("memory route tests") as any,
      synthesisService: createUnusedSynthesisService("memory route tests") as any,
      claimService: createUnusedClaimService("memory route tests") as any,
      proposalService: createUnusedProposalService("memory route tests") as any
    }),
    database,
    memoryService
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

async function createMemory(
  memoryService: MemoryService,
  overrides: Partial<MemoryEntryInputForTest>
): Promise<Readonly<MemoryEntry>> {
  return await memoryService.create({
    created_by: "user_action",
    dimension: MemoryDimension.PREFERENCE,
    source_kind: SourceKind.USER,
    formation_kind: FormationKind.EXPLICIT,
    scope_class: ScopeClass.PROJECT,
    content: "Memory content",
    domain_tags: ["tag"],
    evidence_refs: [],
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    storage_tier: StorageTier.HOT,
    ...overrides
  });
}

type MemoryEntryInputForTest = {
  readonly created_by: string;
  readonly dimension: MemoryDimension;
  readonly source_kind: SourceKind;
  readonly formation_kind: FormationKind;
  readonly scope_class: ScopeClass;
  readonly content: string;
  readonly domain_tags: readonly string[];
  readonly evidence_refs: readonly string[];
  readonly workspace_id: string;
  readonly run_id: string;
  readonly surface_id: string | null;
  readonly storage_tier: StorageTier;
};
