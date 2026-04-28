import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceKind, type ClaimForm } from "@do-what/protocol";
import {
  ClaimService,
  EventPublisher,
  RunHotStateService,
  RunService,
  WorkspaceService
} from "@do-what/core";
import {
  SqliteClaimFormRepo,
  SqliteEventLogRepo,
  SqliteRunRepo,
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
  createUnusedSignalService,
  createUnusedSlotService, createUnusedSynthesisService,
  createUnusedProposalService,
  createUnusedSurfaceService
} from "./helpers/mock-services.js";
import { SseManager } from "../sse/sse-manager.js";

interface TestContext {
  readonly app: ReturnType<typeof createApp>;
  readonly database: StorageDatabase;
  readonly claimService: ClaimService;
  readonly eventLogRepo: SqliteEventLogRepo;
}

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

describe("claim routes", () => {
  it("lists claims by workspace", async () => {
    const { app, claimService } = createTestContext();
    const workspace = await createWorkspace(app, "claim-workspace");

    await createClaim(claimService, workspace.workspace_id, "code_style", { language: "typescript" });

    const response = await app.request(`/workspaces/${workspace.workspace_id}/claims`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: [
        expect.objectContaining({
          object_kind: "claim_form",
          workspace_id: workspace.workspace_id,
          claim_status: "draft"
        })
      ]
    });
  });

  it("returns claim by id", async () => {
    const { app, claimService } = createTestContext();
    const workspace = await createWorkspace(app, "claim-by-id");

    const created = await createClaim(claimService, workspace.workspace_id, "security", { category: "secrets" });

    const response = await app.request(`/claims/${created.object_id}`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        object_id: created.object_id,
        workspace_id: workspace.workspace_id,
        governance_subject: {
          canonical_key: "security::category=secrets"
        }
      }
    });
  });

  it("returns 404 when claim is missing", async () => {
    const { app } = createTestContext();

    const response = await app.request("/claims/85b3671a-d8d8-4848-9e5c-07d0a89f5ae9");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Resource not found"
    });
  });

  it("returns 404 when workspace does not exist for claim list", async () => {
    const { app } = createTestContext();

    const response = await app.request("/workspaces/ws_missing/claims");

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
  const claimFormRepo = new SqliteClaimFormRepo(database);
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

  const claimService = new ClaimService({
    claimFormRepo,
    eventLogRepo,
    sseBroadcaster: sseManager
  });

  return {
    app: createApp({
      workspaceService,
      runService,
      conversationService: createNoopConversationService("claim route tests") as any,
      engineBindingService: createStubEngineBindingService() as any,
      runHotStateService,
      sseManager,
      signalService: createUnusedSignalService("claim route tests") as any,
      evidenceService: createUnusedEvidenceService("claim route tests") as any,
      memoryService: createUnusedMemoryService("claim route tests") as any,
      slotService: createUnusedSlotService("claim route tests") as any,
      surfaceService: createUnusedSurfaceService("claim route tests") as any,
      synthesisService: createUnusedSynthesisService("claim route tests") as any,
      claimService,
      proposalService: createUnusedProposalService("claim route tests") as any
    }),
    database,
    claimService,
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
  const body = (await response.json()) as any;
  return body.data;
}

async function createClaim(
  claimService: ClaimService,
  workspaceId: string,
  domain: string,
  qualifiers: Record<string, string>
): Promise<Readonly<ClaimForm>> {
  return await claimService.create({
    created_by: "user_action",
    governance_subject_domain: domain,
    governance_subject_qualifiers: qualifiers,
    claim_kind: "constraint",
    scope_class: "project",
    enforcement_level: "strict",
    origin_tier: "user_explicit",
    precedence_basis: "authority",
    proposition_digest: "Use pnpm for workspace commands.",
    evidence_refs: [],
    source_object_refs: [],
    workspace_id: workspaceId
  });
}

