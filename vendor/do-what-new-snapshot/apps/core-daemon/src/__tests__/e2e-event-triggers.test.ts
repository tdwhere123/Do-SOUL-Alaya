import { describe, expect, it, vi } from "vitest";
import { EventPublisher, RunHotStateService, RunService, WorkspaceService } from "@do-what/core";
import { Phase5EventType, PhaseBEventType, WorkspaceKind } from "@do-what/protocol";
import {
  SqliteEventLogRepo,
  SqliteRunRepo,
  SqliteWorkspaceRepo,
  initDatabase,
  type StorageDatabase
} from "@do-what/storage";
import { createApp, type CoreDaemonServices, type RequestProtectionConfig } from "../app.js";
import { SseManager } from "../sse/sse-manager.js";
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
} from "./helpers/mock-services.js";

const requestProtection: RequestProtectionConfig = {
  allowedOrigin: "http://localhost:5173",
  requestToken: "request-token-123"
};

describe("E2E event trigger routes", () => {
  it("does not register trigger routes unless explicitly enabled", async () => {
    const { app } = createTestContext({ enableE2eEventTriggers: false });

    const response = await protectedPost(app, "/__e2e/events/soul-approval-requested", {
      run_id: "run-1"
    });

    expect(response.status).toBe(404);
  });

  it("keeps enabled trigger routes behind mutating request-token protection", async () => {
    const { app } = createTestContext({ enableE2eEventTriggers: true });
    const runId = await createProtectedRun(app, "e2e-protected-trigger");

    const response = await app.request("/__e2e/events/soul-approval-requested", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: requestProtection.allowedOrigin
      },
      body: JSON.stringify({ run_id: runId })
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "X-Request-Token is required"
    });
  });

  it("appends and broadcasts only existing approval and dirty-state protocol events", async () => {
    const { app, eventLogRepo, sseManager } = createTestContext({ enableE2eEventTriggers: true });
    const runId = await createProtectedRun(app, "e2e-live-trigger");
    const broadcastSpy = vi.spyOn(sseManager, "broadcastEntry");

    const approvalResponse = await protectedPost(app, "/__e2e/events/soul-approval-requested", {
      run_id: runId,
      approval_id: "approval-e2e-1",
      message_id: "message-e2e-1",
      description: "Route-triggered approval",
      risk_level: "medium"
    });

    expect(approvalResponse.status).toBe(201);
    await expect(approvalResponse.json()).resolves.toMatchObject({
      success: true,
      data: {
        approval_id: "approval-e2e-1",
        message_id: "message-e2e-1",
        run_id: runId
      }
    });

    const dirtyResponse = await protectedPost(app, "/__e2e/events/dirty-state-panic", {
      run_id: runId,
      dossier_id: "dossier-e2e-1",
      worker_run_id: "worker-e2e-1",
      panic_summary: "Route-triggered dirty-state panic"
    });

    expect(dirtyResponse.status).toBe(201);
    await expect(dirtyResponse.json()).resolves.toMatchObject({
      success: true,
      data: {
        dossier_id: "dossier-e2e-1",
        worker_run_id: "worker-e2e-1",
        run_id: runId
      }
    });

    const events = await eventLogRepo.queryByRun(runId);
    expect(events.map((event) => event.event_type)).toEqual(
      expect.arrayContaining([
        Phase5EventType.SOUL_APPROVAL_REQUESTED,
        PhaseBEventType.DIRTY_STATE_PANIC
      ])
    );
    expect(
      events.find((event) => event.event_type === Phase5EventType.SOUL_APPROVAL_REQUESTED)
        ?.payload_json
    ).toMatchObject({
      approval_id: "approval-e2e-1",
      message_id: "message-e2e-1",
      description: "Route-triggered approval",
      run_id: runId
    });
    expect(
      events.find((event) => event.event_type === PhaseBEventType.DIRTY_STATE_PANIC)
        ?.payload_json
    ).toMatchObject({
      dossier_id: "dossier-e2e-1",
      worker_run_id: "worker-e2e-1",
      principal_run_id: runId,
      trigger: "manual",
      panic_source: "e2e_event_trigger",
      panic_summary: "Route-triggered dirty-state panic"
    });
    expect(broadcastSpy).toHaveBeenCalledTimes(2);
  });
});

function createTestContext(options: {
  readonly enableE2eEventTriggers: boolean;
}): {
  readonly app: ReturnType<typeof createApp>;
  readonly database: StorageDatabase;
  readonly eventLogRepo: SqliteEventLogRepo;
  readonly sseManager: SseManager;
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

  const services = {
    workspaceService,
    runService,
    principalCodingEngineAvailable: true,
    conversationService: createNoopConversationService("e2e event trigger tests") as never,
    engineBindingService: createStubEngineBindingService() as never,
    runHotStateService,
    sseManager,
    signalService: createUnusedSignalService("e2e event trigger tests") as never,
    evidenceService: createUnusedEvidenceService("e2e event trigger tests") as never,
    memoryService: createUnusedMemoryService("e2e event trigger tests") as never,
    slotService: createUnusedSlotService("e2e event trigger tests") as never,
    surfaceService: createUnusedSurfaceService("e2e event trigger tests") as never,
    synthesisService: createUnusedSynthesisService("e2e event trigger tests") as never,
    claimService: createUnusedClaimService("e2e event trigger tests") as never,
    proposalService: createUnusedProposalService("e2e event trigger tests") as never,
    eventLogRepo,
    requestProtection,
    enableE2eEventTriggers: options.enableE2eEventTriggers
  } satisfies CoreDaemonServices;

  return {
    app: createApp(services),
    database,
    eventLogRepo,
    sseManager
  };
}

async function createProtectedRun(app: ReturnType<typeof createApp>, name: string): Promise<string> {
  const workspaceResponse = await protectedPost(app, "/workspaces", {
    name,
    root_path: `/tmp/${name}`,
    workspace_kind: WorkspaceKind.LOCAL_REPO
  });

  expect(workspaceResponse.status).toBe(201);
  const workspaceBody = await workspaceResponse.json() as {
    readonly data: { readonly workspace_id: string };
  };
  const workspaceId = workspaceBody.data.workspace_id;
  await configureWorkspacePrincipalCodingEngine(app, workspaceId, protectedHeaders());

  const runResponse = await protectedPost(app, `/workspaces/${workspaceId}/runs`, {
    title: "E2E trigger route run",
    run_mode: "chat"
  });

  expect(runResponse.status).toBe(201);
  const runBody = await runResponse.json() as {
    readonly data: { readonly run_id: string };
  };
  return runBody.data.run_id;
}

function protectedHeaders(): Record<string, string> {
  return {
    "content-type": "application/json",
    origin: requestProtection.allowedOrigin,
    "x-request-token": requestProtection.requestToken
  };
}

async function protectedPost(
  app: ReturnType<typeof createApp>,
  path: string,
  body: Record<string, unknown>
): Promise<Response> {
  return await app.request(path, {
    method: "POST",
    headers: protectedHeaders(),
    body: JSON.stringify(body)
  });
}
