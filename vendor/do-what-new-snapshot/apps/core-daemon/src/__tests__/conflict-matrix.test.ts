import { afterEach, describe, expect, it } from "vitest";
import { ClaimKind, ScopeClass, WorkspaceKind, canonicalGovernanceSubject, type ClaimForm } from "@do-what/protocol";
import {
  ArbitrationService,
  EventPublisher,
  RunHotStateService,
  RunService,
  WorkspaceService
} from "@do-what/core";
import {
  SqliteClaimFormRepo,
  SqliteConflictMatrixRepo,
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
  createUnusedEvidenceService,
  createUnusedMemoryService,
  createUnusedProposalService,
  createUnusedSignalService,
  createUnusedSlotService,
  createUnusedSynthesisService,
  createUnusedClaimService,
  createUnusedSurfaceService
} from "./helpers/mock-services.js";
import { SseManager } from "../sse/sse-manager.js";

const WORKSPACE_ID = "workspace-1";
const CLAIM_ID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CLAIM_ID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const EDGE_ID = "11111111-1111-4111-8111-111111111111";

interface TestContext {
  readonly app: ReturnType<typeof createApp>;
  readonly database: StorageDatabase;
  readonly claimRepo: SqliteClaimFormRepo;
  readonly conflictMatrixRepo: SqliteConflictMatrixRepo;
}

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

describe("conflict matrix routes", () => {
  it("lists conflict-matrix edges by workspace", async () => {
    const { app, claimRepo, conflictMatrixRepo } = createTestContext();
    const workspace = await createWorkspace(app, "conflict-list");

    await seedClaims(claimRepo, workspace.workspace_id);
    await conflictMatrixRepo.create(createEdge({ workspace_id: workspace.workspace_id }));

    const response = await app.request(`/workspaces/${workspace.workspace_id}/conflict-matrix-edges`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: [
        expect.objectContaining({
          object_kind: "conflict_matrix_edge",
          source_claim_id: CLAIM_ID_A,
          target_claim_id: CLAIM_ID_B,
          edge_type: "exception_to"
        })
      ]
    });
  });

  it("creates conflict-matrix edge", async () => {
    const { app, claimRepo } = createTestContext();
    const workspace = await createWorkspace(app, "conflict-create");
    await seedClaims(claimRepo, workspace.workspace_id);

    const response = await app.request("/conflict-matrix-edges", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source_claim_id: CLAIM_ID_A,
        target_claim_id: CLAIM_ID_B,
        edge_type: "incompatible_with",
        created_by: "reviewer"
      })
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        source_claim_id: CLAIM_ID_A,
        target_claim_id: CLAIM_ID_B,
        edge_type: "incompatible_with"
      }
    });
  });

  it("returns 400 when creating conflict-matrix edge with malformed JSON", async () => {
    const { app, claimRepo } = createTestContext();
    const workspace = await createWorkspace(app, "conflict-malformed-json");
    await seedClaims(claimRepo, workspace.workspace_id);

    const response = await app.request("/conflict-matrix-edges", {
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

  it("deletes conflict-matrix edge", async () => {
    const { app, claimRepo, conflictMatrixRepo } = createTestContext();
    const workspace = await createWorkspace(app, "conflict-delete");
    await seedClaims(claimRepo, workspace.workspace_id);
    await conflictMatrixRepo.create(createEdge({ object_id: EDGE_ID, workspace_id: workspace.workspace_id }));

    const response = await app.request(`/conflict-matrix-edges/${EDGE_ID}`, {
      method: "DELETE"
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: null
    });

    await expect(conflictMatrixRepo.findById(EDGE_ID)).resolves.toBeNull();
  });

  it("returns 404 when deleting a non-existent conflict-matrix edge", async () => {
    const { app } = createTestContext();

    const response = await app.request(`/conflict-matrix-edges/${EDGE_ID}`, {
      method: "DELETE"
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Resource not found"
    });
  });

  it("rebuild endpoint deletes orphaned edges", async () => {
    const { app, database, claimRepo, conflictMatrixRepo } = createTestContext();
    const workspace = await createWorkspace(app, "conflict-rebuild");
    await seedClaims(claimRepo, workspace.workspace_id);

    await conflictMatrixRepo.create(createEdge({ object_id: EDGE_ID, workspace_id: workspace.workspace_id }));
    database.connection.prepare("DELETE FROM claim_forms WHERE object_id = ?").run(CLAIM_ID_A);

    const response = await app.request(`/workspaces/${workspace.workspace_id}/conflict-matrix/rebuild`, {
      method: "POST"
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        total_edges: 0,
        orphaned_deleted: 0,
        valid_edges: 0
      }
    });

    await expect(conflictMatrixRepo.findById(EDGE_ID)).resolves.toBeNull();
  });
});

function createTestContext(): TestContext {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);

  const workspaceRepo = new SqliteWorkspaceRepo(database);
  const runRepo = new SqliteRunRepo(database);
  const eventLogRepo = new SqliteEventLogRepo(database);
  const claimRepo = new SqliteClaimFormRepo(database);
  const conflictMatrixRepo = new SqliteConflictMatrixRepo(database);
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

  const arbitrationService = new ArbitrationService({
    slotRepo,
    claimRepo,
    conflictMatrixRepo,
    claimService: createUnusedClaimService("conflict matrix route tests") as any,
    eventLogRepo,
    sseBroadcaster: sseManager,
    generateObjectId: () => EDGE_ID,
    now: () => "2026-03-21T02:00:00.000Z"
  });

  return {
    app: createApp({
      workspaceService,
      runService,
      conversationService: createNoopConversationService("conflict matrix route tests") as any,
      engineBindingService: createStubEngineBindingService() as any,
      runHotStateService,
      sseManager,
      signalService: createUnusedSignalService("conflict matrix route tests") as any,
      evidenceService: createUnusedEvidenceService("conflict matrix route tests") as any,
      memoryService: createUnusedMemoryService("conflict matrix route tests") as any,
      slotService: createUnusedSlotService("conflict matrix route tests") as any,
      surfaceService: createUnusedSurfaceService("conflict matrix route tests") as any,
      synthesisService: createUnusedSynthesisService("conflict matrix route tests") as any,
      claimService: createUnusedClaimService("conflict matrix route tests") as any,
      proposalService: createUnusedProposalService("conflict matrix route tests") as any,
      arbitrationService
    }),
    database,
    claimRepo,
    conflictMatrixRepo
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

async function seedClaims(claimRepo: SqliteClaimFormRepo, workspaceId: string): Promise<void> {
  await claimRepo.create(createClaim(CLAIM_ID_A, workspaceId, "Never print secrets."));
  await claimRepo.create(createClaim(CLAIM_ID_B, workspaceId, "Allow HTTP in local dev."));
}

function createClaim(claimId: string, workspaceId: string, digest: string): ClaimForm {
  return {
    object_id: claimId,
    object_kind: "claim_form",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-21T00:00:00.000Z",
    updated_at: "2026-03-21T00:00:00.000Z",
    created_by: "user_action",
    governance_subject: canonicalGovernanceSubject("security", { category: claimId === CLAIM_ID_A ? "secrets" : "http" }),
    claim_kind: ClaimKind.CONSTRAINT,
    scope_class: ScopeClass.PROJECT,
    enforcement_level: "strict",
    origin_tier: "user_explicit",
    precedence_basis: "authority",
    proposition_digest: digest,
    evidence_refs: [],
    source_object_refs: [],
    workspace_id: workspaceId,
    claim_status: "active"
  };
}

function createEdge(overrides: Partial<any> = {}) {
  return {
    object_id: EDGE_ID,
    object_kind: "conflict_matrix_edge",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-21T01:00:00.000Z",
    updated_at: "2026-03-21T01:00:00.000Z",
    created_by: "user_action",
    source_claim_id: CLAIM_ID_A,
    target_claim_id: CLAIM_ID_B,
    edge_type: "exception_to",
    workspace_id: WORKSPACE_ID,
    ...overrides
  } as const;
}


