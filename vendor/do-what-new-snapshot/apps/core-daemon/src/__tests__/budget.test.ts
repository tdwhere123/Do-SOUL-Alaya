import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { WorkspaceKind, type BudgetSnapshot, type Proposal } from "@do-what/protocol";
import { CoreError, EventPublisher, RunHotStateService, RunService, WorkspaceService } from "@do-what/core";
import {
  SqliteEventLogRepo,
  SqliteRunRepo,
  SqliteWorkspaceRepo,
  initDatabase,
  type StorageDatabase
} from "@do-what/storage";
import { createApp } from "../app.js";
import { registerErrorHandler } from "../middleware/error-handler.js";
import { registerBudgetRoutes } from "../routes/budget.js";
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
  createUnusedSynthesisService,
  createUnusedSurfaceService
} from "./helpers/mock-services.js";
import { SseManager } from "../sse/sse-manager.js";

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

describe("budget routes", () => {
  it("returns the budget snapshot for an existing run", async () => {
    const snapshot = createBudgetSnapshot();
    const budgetBankruptcyService = createBudgetBankruptcyService({
      getSnapshot: vi.fn(async () => snapshot)
    });
    const { app } = createBudgetRouteTestContext({ budgetBankruptcyService });
    const workspace = await createWorkspace(app, "budget-snapshot");
    const runId = await createRun(app, workspace.workspace_id, "budget run");

    const response = await app.request(`/runs/${runId}/budget-snapshot`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: snapshot
    });
    expect(budgetBankruptcyService.getSnapshot).toHaveBeenCalledWith(runId, expect.any(String));
  });

  it("passes the injected clock through to the snapshot response", async () => {
    const budgetBankruptcyService = createBudgetBankruptcyService({
      getSnapshot: vi.fn(async (_runId: string, now: string) => createBudgetSnapshot({ snapshot_at: now }))
    });
    const { app } = createBudgetRouteTestContext({
      budgetBankruptcyService,
      budgetNow: () => "2026-03-26T00:00:00.000Z"
    });
    const workspace = await createWorkspace(app, "budget-injected-clock");
    const runId = await createRun(app, workspace.workspace_id, "clocked run");

    const response = await app.request(`/runs/${runId}/budget-snapshot`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        snapshot_at: "2026-03-26T00:00:00.000Z"
      }
    });
  });

  it("returns 404 for an unknown run", async () => {
    const { app } = createBudgetRouteTestContext();

    const response = await app.request("/runs/run-404/budget-snapshot");

    expect(response.status).toBe(404);
  });

  it("returns 400 when the injected snapshot clock is invalid", async () => {
    const budgetBankruptcyService = createBudgetBankruptcyService();
    const app = new Hono();
    registerErrorHandler(app);
    registerBudgetRoutes(app, {
      runService: {
        getById: vi.fn(async (runId: string) => ({ run_id: runId, workspace_id: "workspace-1" }))
      } as any,
      budgetBankruptcyService: budgetBankruptcyService as any,
      now: () => "not-a-timestamp"
    });

    const response = await app.request("/runs/run-1/budget-snapshot");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      success: false
    });
  });

  it("resolves a hard bankruptcy proposal", async () => {
    const proposal = createProposal({ resolution_state: "accepted" });
    const budgetBankruptcyService = createBudgetBankruptcyService({
      resolve: vi.fn(async () => proposal)
    });
    const { app } = createBudgetRouteTestContext({ budgetBankruptcyService });
    const workspace = await createWorkspace(app, "budget-resolve");
    const runId = await createRun(app, workspace.workspace_id, "resolve run");

    const response = await app.request(`/runs/${runId}/budget-bankruptcy/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        option_id: "option-request_confirmation",
        action: "accept"
      })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: proposal
    });
    expect(budgetBankruptcyService.resolve).toHaveBeenCalledWith({
      runId,
      workspaceId: workspace.workspace_id,
      optionId: "option-request_confirmation",
      action: "accept"
    });
  });

  it("returns 400 for missing or invalid resolve request fields", async () => {
    const { app } = createBudgetRouteTestContext();
    const workspace = await createWorkspace(app, "budget-invalid-resolve");
    const runId = await createRun(app, workspace.workspace_id, "invalid resolve run");

    const missingOption = await app.request(`/runs/${runId}/budget-bankruptcy/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "accept" })
    });
    expect(missingOption.status).toBe(400);

    const invalidAction = await app.request(`/runs/${runId}/budget-bankruptcy/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ option_id: "option-1", action: "later" })
    });
    expect(invalidAction.status).toBe(400);
  });

  it("surfaces option validation errors from the budget service", async () => {
    const budgetBankruptcyService = createBudgetBankruptcyService({
      resolve: vi.fn(async () => {
        throw new CoreError("VALIDATION", "option_id must belong to the active proposal");
      })
    });
    const { app } = createBudgetRouteTestContext({ budgetBankruptcyService });
    const workspace = await createWorkspace(app, "budget-option-validation");
    const runId = await createRun(app, workspace.workspace_id, "option validation run");

    const response = await app.request(`/runs/${runId}/budget-bankruptcy/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ option_id: "missing-option", action: "accept" })
    });

    expect(response.status).toBe(400);
  });

  it("clears bankruptcy state when deleting a run", async () => {
    const budgetBankruptcyService = createBudgetBankruptcyService();
    const { app } = createBudgetRouteTestContext({ budgetBankruptcyService });
    const workspace = await createWorkspace(app, "budget-clear-run");
    const runId = await createRun(app, workspace.workspace_id, "clear bankruptcy");

    const response = await app.request(`/runs/${runId}`, {
      method: "DELETE"
    });

    expect(response.status).toBe(200);
    expect(budgetBankruptcyService.clearRun).toHaveBeenCalledWith(runId);
  });
});

function createBudgetRouteTestContext(overrides: Partial<{
  budgetBankruptcyService: ReturnType<typeof createBudgetBankruptcyService>;
  budgetNow: () => string;
}> = {}) {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);

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

  return {
    app: createApp({
      workspaceService,
      runService,
      principalCodingEngineAvailable: true,
      conversationService: createNoopConversationService("budget route tests") as any,
      engineBindingService: createStubEngineBindingService() as any,
      runHotStateService,
      sseManager,
      signalService: createUnusedSignalService("budget route tests") as any,
      evidenceService: createUnusedEvidenceService("budget route tests") as any,
      memoryService: createUnusedMemoryService("budget route tests") as any,
      slotService: createUnusedSlotService("budget route tests") as any,
      surfaceService: createUnusedSurfaceService("budget route tests") as any,
      synthesisService: createUnusedSynthesisService("budget route tests") as any,
      claimService: createUnusedClaimService("budget route tests") as any,
      proposalService: createUnusedProposalService("budget route tests") as any,
      budgetNow: overrides.budgetNow,
      budgetBankruptcyService: overrides.budgetBankruptcyService ?? createBudgetBankruptcyService()
    })
  };
}

function createBudgetBankruptcyService(overrides: Partial<{
  getSnapshot: ReturnType<typeof vi.fn>;
  resolve: ReturnType<typeof vi.fn>;
  clearRun: ReturnType<typeof vi.fn>;
}> = {}) {
  return {
    getSnapshot: overrides.getSnapshot ?? vi.fn(async () => createBudgetSnapshot()),
    resolve: overrides.resolve ?? vi.fn(async () => createProposal()),
    clearRun: overrides.clearRun ?? vi.fn(() => {})
  };
}

function createBudgetSnapshot(overrides: Partial<BudgetSnapshot> = {}): BudgetSnapshot {
  return {
    snapshot_at: "2026-03-26T00:00:00.000Z",
    run_id: "run-1",
    current_mode: "lean",
    bankruptcy_kind: "soft",
    trigger_summary: "Token estimate 1200 exceeds budget 800",
    active_dossier: {
      bankruptcy_id: "bankruptcy-1",
      trigger_kind: "token_overflow",
      mode_at_trigger: "full",
      dropped_candidates: ["memory-1"],
      protected_constraints_preserved: ["claim-1"],
      required_actions: ["compress", "defer"],
      created_at: "2026-03-26T00:00:00.000Z"
    },
    pending_proposal: {
      proposal_id: "proposal-1",
      resolution_state: "pending",
      recommended_option_id: "option-request_confirmation",
      options: [
        {
          option_id: "option-request_confirmation",
          option_kind: "request_confirmation",
          preserves_protected_constraints: true,
          requires_confirmation: true
        }
      ],
      expires_at: "2026-03-26T01:00:00.000Z"
    },
    ...overrides
  };
}

function createProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    runtime_id: "proposal-1",
    object_kind: "proposal",
    task_surface_ref: null,
    expires_at: "2026-03-26T01:00:00.000Z",
    derived_from: null,
    retention_policy: "session_only",
    proposal_id: "proposal-1",
    dossier_ref: "dossier-1",
    recommended_option_id: "option-request_confirmation",
    proposal_options: [
      {
        option_id: "option-request_confirmation",
        option_kind: "request_confirmation",
        preserves_protected_constraints: true,
        dropped_candidates: ["memory-1"],
        unresolved_after_apply: [],
        requires_confirmation: true
      }
    ],
    resolution_state: "pending",
    last_updated_at: "2026-03-26T00:00:00.000Z",
    ...overrides
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
