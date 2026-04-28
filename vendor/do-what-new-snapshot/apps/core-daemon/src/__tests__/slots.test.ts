import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaimKind, ScopeClass, WorkspaceKind, canonicalGovernanceSubject } from "@do-what/protocol";
import {
  CoreError,
  EventPublisher,
  RunHotStateService,
  RunService,
  SlotService,
  WorkspaceService,
  type ArbitrationService
} from "@do-what/core";
import {
  SqliteEventLogRepo,
  SqliteRunRepo,
  SqliteSlotRepo,
  SqliteWorkspaceRepo,
  initDatabase,
  type StorageDatabase
} from "@do-what/storage";
import { createApp } from "../app.js";
import {
  createNoopConversationService,
  createStubEngineBindingService,
  createUnusedClaimService,
  createUnusedEvidenceService,
  createUnusedMemoryService,
  createUnusedProposalService,
  createUnusedSignalService,
  createUnusedSynthesisService,
  createUnusedSurfaceService
} from "./helpers/mock-services.js";
import { SseManager } from "../sse/sse-manager.js";

const SLOT_ID_1 = "11111111-1111-4111-8111-111111111111";
const MISSING_SLOT_ID = "99999999-9999-4999-8999-999999999999";
const CLAIM_ID_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CLAIM_ID_2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

interface TestContext {
  readonly app: ReturnType<typeof createApp>;
  readonly database: StorageDatabase;
  readonly slotRepo: SqliteSlotRepo;
  readonly arbitrationResolveSpy: ReturnType<typeof vi.fn> | null;
}

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

describe("slot routes", () => {
  it("lists slots by workspace", async () => {
    const { app, slotRepo } = createTestContext();
    const workspace = await createWorkspace(app, "slot-workspace");

    await slotRepo.create(createSlot(SLOT_ID_1, workspace.workspace_id));

    const response = await app.request(`/workspaces/${workspace.workspace_id}/slots`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: [
        expect.objectContaining({
          object_kind: "slot",
          workspace_id: workspace.workspace_id,
          winner_claim_id: CLAIM_ID_1
        })
      ]
    });
  });

  it("returns slot by id", async () => {
    const { app, slotRepo } = createTestContext();
    const workspace = await createWorkspace(app, "slot-by-id");

    await slotRepo.create(createSlot(SLOT_ID_1, workspace.workspace_id));

    const response = await app.request(`/slots/${SLOT_ID_1}`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        object_id: SLOT_ID_1,
        workspace_id: workspace.workspace_id
      }
    });
  });

  it("resolves slot conflict via arbitration service", async () => {
    const { app, slotRepo, arbitrationResolveSpy } = createTestContext({ withArbitrationService: true });
    const workspace = await createWorkspace(app, "slot-resolve");
    const seed = createSlot(SLOT_ID_1, workspace.workspace_id);
    await slotRepo.create(seed);

    const response = await app.request(`/slots/${SLOT_ID_1}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ winner_claim_id: CLAIM_ID_2 })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        object_id: SLOT_ID_1,
        winner_claim_id: CLAIM_ID_2
      }
    });

    expect(arbitrationResolveSpy).toHaveBeenCalledWith(SLOT_ID_1, CLAIM_ID_2);
  });

  it("returns 400 when resolve body is malformed", async () => {
    const { app } = createTestContext({ withArbitrationService: true });

    const response = await app.request(`/slots/${SLOT_ID_1}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{"
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Invalid request body"
    });
  });

  it("returns 400 when winner_claim_id is missing", async () => {
    const { app } = createTestContext({ withArbitrationService: true });

    const response = await app.request(`/slots/${SLOT_ID_1}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ winner_claim_id: "  " })
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Invalid request"
    });
  });

  it("returns 400 when arbitration rejects non-candidate winner_claim_id", async () => {
    const { app, arbitrationResolveSpy } = createTestContext({ withArbitrationService: true });

    expect(arbitrationResolveSpy).not.toBeNull();
    arbitrationResolveSpy?.mockRejectedValueOnce(
      new CoreError("VALIDATION", "winner_claim_id must match a candidate claim in slot")
    );

    const response = await app.request(`/slots/${SLOT_ID_1}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ winner_claim_id: CLAIM_ID_2 })
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Invalid request"
    });
  });

  it("returns 409 when arbitration service is not configured", async () => {
    const { app } = createTestContext();

    const response = await app.request(`/slots/${SLOT_ID_1}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ winner_claim_id: CLAIM_ID_2 })
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Request conflict"
    });
  });

  it("returns 404 when slot is missing", async () => {
    const { app } = createTestContext();

    const response = await app.request(`/slots/${MISSING_SLOT_ID}`);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Resource not found"
    });
  });

  it("returns 404 when workspace is missing for slot list", async () => {
    const { app } = createTestContext();

    const response = await app.request("/workspaces/ws_missing/slots");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Resource not found"
    });
  });
});

function createTestContext(options?: {
  readonly withArbitrationService?: boolean;
}): TestContext {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);

  const workspaceRepo = new SqliteWorkspaceRepo(database);
  const runRepo = new SqliteRunRepo(database);
  const eventLogRepo = new SqliteEventLogRepo(database);
  const slotRepo = new SqliteSlotRepo(database);
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

  const slotService = new SlotService({
    slotRepo,
    eventLogRepo,
    sseBroadcaster: sseManager
  });

  let arbitrationResolveSpy: ReturnType<typeof vi.fn> | null = null;
  let arbitrationService: ArbitrationService | undefined;

  if (options?.withArbitrationService === true) {
    arbitrationResolveSpy = vi.fn(async (_slotId: string, winnerClaimId: string) => ({
      ...createSlot(SLOT_ID_1, "ws-1"),
      winner_claim_id: winnerClaimId
    }));

    arbitrationService = {
      resolveSlotConflict: arbitrationResolveSpy
    } as unknown as ArbitrationService;
  }

  return {
    app: createApp({
      workspaceService,
      runService,
      conversationService: createNoopConversationService("slot route tests") as any,
      engineBindingService: createStubEngineBindingService() as any,
      runHotStateService,
      sseManager,
      signalService: createUnusedSignalService("slot route tests") as any,
      evidenceService: createUnusedEvidenceService("slot route tests") as any,
      memoryService: createUnusedMemoryService("slot route tests") as any,
      slotService,
      surfaceService: createUnusedSurfaceService("slot route tests") as any,
      synthesisService: createUnusedSynthesisService("slot route tests") as any,
      claimService: createUnusedClaimService("slot route tests") as any,
      proposalService: createUnusedProposalService("slot route tests") as any,
      arbitrationService
    }),
    database,
    slotRepo,
    arbitrationResolveSpy
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
  return body.data;
}

function createSlot(slotId: string, workspaceId: string) {
  return {
    object_id: slotId,
    object_kind: "slot",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-21T00:00:00.000Z",
    updated_at: "2026-03-21T00:00:00.000Z",
    created_by: "system",
    governance_subject: canonicalGovernanceSubject("security", { category: "secrets" }),
    claim_kind: ClaimKind.CONSTRAINT,
    scope_class: ScopeClass.PROJECT,
    winner_claim_id: CLAIM_ID_1,
    incumbent_since: "2026-03-21T00:00:00.000Z",
    flip_conditions: [],
    workspace_id: workspaceId
  } as const;
}
