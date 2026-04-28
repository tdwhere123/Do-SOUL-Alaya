import { describe, expect, it, vi } from "vitest";
import {
  Phase4BEventType,
  WorkspaceKind,
  type GraphNeighbor,
  type TopologyExplorationResult
} from "@do-what/protocol";
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
  initDatabase,
  type StorageDatabase
} from "@do-what/storage";
import { createApp } from "../app.js";
import type { CoreDaemonServices } from "../app.js";
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
import { SseManager } from "../sse/sse-manager.js";

describe("soul routes", () => {
  it("returns the daemon-issued request token when protection is enabled", async () => {
    const { app } = createTestContext({
      requestProtection: {
        allowedOrigin: "http://localhost:5173",
        requestToken: "request-token-123"
      }
    });

    const response = await app.request("/session/request-token", {
      headers: {
        origin: "http://localhost:5173"
      }
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        request_token: "request-token-123"
      }
    });
  });

  it("rejects request-token reads from a null origin", async () => {
    const { app } = createTestContext({
      requestProtection: {
        allowedOrigin: "http://localhost:5173",
        requestToken: "request-token-123"
      }
    });

    const response = await app.request("/session/request-token", {
      headers: {
        origin: "null"
      }
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Origin is not allowed"
    });
  });

  it("returns the daemon-issued request token for local-operator requests when Origin is missing", async () => {
    const { app } = createTestContext({
      requestProtection: {
        allowedOrigin: "http://localhost:5173",
        requestToken: "request-token-123"
      }
    });

    const response = await app.request("/session/request-token", {
      headers: {
        "x-do-what-desktop": "1"
      }
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        request_token: "request-token-123"
      }
    });
  });

  it("rejects desktop-header request-token reads without Origin when originless desktop exemption is disabled", async () => {
    const { app } = createTestContext({
      requestProtection: {
        allowedOrigin: "http://localhost:5173",
        requestToken: "request-token-123",
        allowDesktopOriginlessRequests: false
      }
    });

    const response = await app.request("/session/request-token", {
      headers: {
        "x-do-what-desktop": "1"
      }
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Origin is not allowed"
    });
  });

  it("rejects request-token reads when explicit origin is wrong even with the desktop header", async () => {
    const { app } = createTestContext({
      requestProtection: {
        allowedOrigin: "http://localhost:5173",
        requestToken: "request-token-123"
      }
    });

    const response = await app.request("/session/request-token", {
      headers: {
        origin: "https://evil.example.com",
        "x-do-what-desktop": "1"
      }
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Origin is not allowed"
    });
  });

  it("does not emit a CORS allow-origin header for null-origin read routes", async () => {
    const requestProtection = {
      allowedOrigin: "http://localhost:5173",
      requestToken: "request-token-123"
    };
    const { app } = createTestContext({
      requestProtection
    });
    const workspaceResponse = await app.request("/workspaces", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: requestProtection.allowedOrigin,
        "x-request-token": requestProtection.requestToken
      },
      body: JSON.stringify({
        name: "soul-desktop-read",
        root_path: "/tmp/soul-desktop-read",
        workspace_kind: WorkspaceKind.LOCAL_REPO
      })
    });

    expect(workspaceResponse.status).toBe(201);
    const workspaceBody = await workspaceResponse.json();
    const workspace = workspaceBody.data;

    const response = await app.request(
      `/soul/memories/memory-1/graph-neighbors?workspace_id=${workspace.workspace_id}`,
      {
        headers: {
          origin: "null",
          "x-do-what-desktop": "1"
        }
      }
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("returns one-hop graph neighbors for a memory", async () => {
    const { app, graphExploreService } = createTestContext();
    const workspace = await createWorkspace(app, "soul-route");

    const response = await app.request(
      `/soul/memories/memory-1/graph-neighbors?workspace_id=${workspace.workspace_id}&direction=outbound`
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: [
        {
          memory_id: "memory-2",
          edge_type: "supports",
          direction: "outbound",
          edge_id: "edge-1"
        }
      ]
    });
    expect(graphExploreService.exploreOneHop).toHaveBeenCalledWith("memory-1", workspace.workspace_id, {
      direction: "outbound",
      edgeTypes: undefined
    });
  });

  it("returns a workspace topology view and appends the reused audit event", async () => {
    const { app, eventLogRepo, topologyService } = createTestContext();
    const workspace = await createWorkspace(app, "soul-topology");

    const response = await app.request(`/soul/workspaces/${workspace.workspace_id}/topology`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        exploration_id: `topology-explore:${workspace.workspace_id}:2026-04-21T08:00:00.000Z`,
        workspace_id: workspace.workspace_id,
        total_nodes: 3,
        total_edges: 2,
        strongly_connected_components: 2
      }
    });
    expect(topologyService.explore).toHaveBeenCalledWith(workspace.workspace_id);

    const auditEvents = (await eventLogRepo.queryByEntity("workspace", workspace.workspace_id)).filter(
      (event) => event.event_type === Phase4BEventType.SOUL_GRAPH_EXPLORE_COMPLETED
    );
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      event_type: Phase4BEventType.SOUL_GRAPH_EXPLORE_COMPLETED,
      entity_type: "workspace",
      entity_id: workspace.workspace_id,
      workspace_id: workspace.workspace_id,
      run_id: null,
      payload_json: {
        exploration_kind: "path_topology",
        workspace_id: workspace.workspace_id,
        total_nodes: 3,
        total_edges: 2,
        strongly_connected_components: 2
      }
    });
  });

  it("appends topology audits on the next repo-managed workspace revision", async () => {
    const { app, eventLogRepo } = createTestContext();
    const workspace = await createWorkspace(app, "soul-topology-revision");
    const beforeTopology = await eventLogRepo.queryByEntity("workspace", workspace.workspace_id);
    const previousMaxRevision = beforeTopology.reduce((max, event) => Math.max(max, event.revision), -1);

    const response = await app.request(`/soul/workspaces/${workspace.workspace_id}/topology`);

    expect(response.status).toBe(200);
    const auditEvents = (await eventLogRepo.queryByEntity("workspace", workspace.workspace_id)).filter(
      (event) => event.event_type === Phase4BEventType.SOUL_GRAPH_EXPLORE_COMPLETED
    );
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]?.revision).toBe(previousMaxRevision + 1);
  });

  it("rejects topology GETs without a request token when request protection is enabled", async () => {
    const requestProtection = {
      allowedOrigin: "http://localhost:5173",
      requestToken: "request-token-123"
    };
    const { app } = createTestContext({ requestProtection });
    const workspace = await createProtectedWorkspace(app, "soul-topology-protected", requestProtection);

    const response = await app.request(`/soul/workspaces/${workspace.workspace_id}/topology`, {
      headers: {
        origin: requestProtection.allowedOrigin
      }
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "X-Request-Token is required"
    });
  });

  it("allows topology GETs when the request token is valid", async () => {
    const requestProtection = {
      allowedOrigin: "http://localhost:5173",
      requestToken: "request-token-123"
    };
    const { app } = createTestContext({ requestProtection });
    const workspace = await createProtectedWorkspace(
      app,
      "soul-topology-protected-success",
      requestProtection
    );

    const response = await app.request(`/soul/workspaces/${workspace.workspace_id}/topology`, {
      headers: {
        origin: requestProtection.allowedOrigin,
        "x-request-token": requestProtection.requestToken
      }
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        workspace_id: workspace.workspace_id
      }
    });
  });

  it("fails fast when topology routing is configured without an append-capable audit log", () => {
    expect(() =>
      createTestContext({
        omitTopologyAuditLog: true
      })
    ).toThrow("TopologyService requires topology audit logging.");
  });

  it("returns 400 when edge_types contains an invalid value", async () => {
    const { app, graphExploreService } = createTestContext();
    const workspace = await createWorkspace(app, "soul-route-invalid-edge-type");

    const response = await app.request(
      `/soul/memories/memory-1/graph-neighbors?workspace_id=${workspace.workspace_id}&edge_types=not-a-real-edge`
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Invalid edge_types query value"
    });
    expect(graphExploreService.exploreOneHop).not.toHaveBeenCalled();
  });

  it("returns 400 when approve route is missing run_id", async () => {
    const approvalService = createApprovalServiceSpy();
    const { app } = createTestContext({ approvalService });

    const response = await app.request("/soul/approval/approval-1/approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Invalid request"
    });
    expect(approvalService.approve).not.toHaveBeenCalled();
  });

  it("rejects protected mutating routes when the request token is missing", async () => {
    const approvalService = createApprovalServiceSpy();
    const { app } = createTestContext({
      approvalService,
      requestProtection: {
        allowedOrigin: "http://localhost:5173",
        requestToken: "request-token-123"
      }
    });

    const response = await app.request("/soul/approval/approval-1/approve", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:5173"
      },
      body: JSON.stringify({ run_id: "run-1" })
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "X-Request-Token is required"
    });
    expect(approvalService.approve).not.toHaveBeenCalled();
  });

  it("rejects protected mutating routes when the request token is wrong", async () => {
    const approvalService = createApprovalServiceSpy();
    const { app } = createTestContext({
      approvalService,
      requestProtection: {
        allowedOrigin: "http://localhost:5173",
        requestToken: "request-token-123"
      }
    });

    const response = await app.request("/soul/approval/approval-1/approve", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:5173",
        "x-request-token": "wrong-token"
      },
      body: JSON.stringify({ run_id: "run-1" })
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Invalid X-Request-Token"
    });
    expect(approvalService.approve).not.toHaveBeenCalled();
  });

  it("rejects protected mutating routes from the wrong origin even with the desktop header", async () => {
    const approvalService = createApprovalServiceSpy();
    const { app } = createTestContext({
      approvalService,
      requestProtection: {
        allowedOrigin: "http://localhost:5173",
        requestToken: "request-token-123"
      }
    });

    const response = await app.request("/soul/approval/approval-1/approve", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://evil.example.com",
        "x-do-what-desktop": "1",
        "x-request-token": "request-token-123"
      },
      body: JSON.stringify({ run_id: "run-1" })
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Origin is not allowed"
    });
    expect(approvalService.approve).not.toHaveBeenCalled();
  });

  it("rejects protected mutating routes with a missing origin when the desktop header is not present", async () => {
    const approvalService = createApprovalServiceSpy();
    const { app } = createTestContext({
      approvalService,
      requestProtection: {
        allowedOrigin: "http://localhost:5173",
        requestToken: "request-token-123"
      }
    });

    const response = await app.request("/soul/approval/approval-1/approve", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-request-token": "request-token-123"
      },
      body: JSON.stringify({ run_id: "run-1" })
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Origin is not allowed"
    });
    expect(approvalService.approve).not.toHaveBeenCalled();
  });

  it("allows protected mutating routes with a missing origin when the desktop header is present", async () => {
    const approvalService = createApprovalServiceSpy();
    const { app } = createTestContext({
      approvalService,
      requestProtection: {
        allowedOrigin: "http://localhost:5173",
        requestToken: "request-token-123"
      }
    });

    const response = await app.request("/soul/approval/approval-1/approve", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-do-what-desktop": "1",
        "x-request-token": "request-token-123"
      },
      body: JSON.stringify({ run_id: "run-1" })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        approval_id: "approval-1",
        result: "approved"
      }
    });
    expect(approvalService.approve).toHaveBeenCalledWith({
      approvalId: "approval-1",
      runId: "run-1",
      causedBy: "user_action"
    });
  });

  it("rejects desktop-header mutating requests without Origin when originless desktop exemption is disabled", async () => {
    const approvalService = createApprovalServiceSpy();
    const { app } = createTestContext({
      approvalService,
      requestProtection: {
        allowedOrigin: "http://localhost:5173",
        requestToken: "request-token-123",
        allowDesktopOriginlessRequests: false
      }
    });

    const response = await app.request("/soul/approval/approval-1/approve", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-do-what-desktop": "1",
        "x-request-token": "request-token-123"
      },
      body: JSON.stringify({ run_id: "run-1" })
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Origin is not allowed"
    });
    expect(approvalService.approve).not.toHaveBeenCalled();
  });

  it("rejects protected mutating routes for a null-origin desktop header request", async () => {
    const approvalService = createApprovalServiceSpy();
    const { app } = createTestContext({
      approvalService,
      requestProtection: {
        allowedOrigin: "http://localhost:5173",
        requestToken: "request-token-123"
      }
    });

    const response = await app.request("/soul/approval/approval-1/approve", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "null",
        "x-do-what-desktop": "1",
        "x-request-token": "request-token-123"
      },
      body: JSON.stringify({ run_id: "run-1" })
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Origin is not allowed"
    });
    expect(approvalService.approve).not.toHaveBeenCalled();
  });

  it("allows protected mutating routes with the expected origin and request token", async () => {
    const approvalService = createApprovalServiceSpy();
    const { app } = createTestContext({
      approvalService,
      requestProtection: {
        allowedOrigin: "http://localhost:5173",
        requestToken: "request-token-123"
      }
    });

    const response = await app.request("/soul/approval/approval-1/approve", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:5173",
        "x-request-token": "request-token-123"
      },
      body: JSON.stringify({ run_id: "run-1" })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        approval_id: "approval-1",
        result: "approved"
      }
    });
    expect(approvalService.approve).toHaveBeenCalledWith({
      approvalId: "approval-1",
      runId: "run-1",
      causedBy: "user_action"
    });
  });

  it("applies the same protection to non-approval mutating routes", async () => {
    const { app } = createTestContext({
      requestProtection: {
        allowedOrigin: "http://localhost:5173",
        requestToken: "request-token-123"
      }
    });

    const response = await app.request("/workspaces", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:5173",
        "x-request-token": "request-token-123"
      },
      body: JSON.stringify({
        name: "guarded-workspace",
        root_path: "/tmp/guarded-workspace",
        workspace_kind: WorkspaceKind.LOCAL_REPO
      })
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        name: "guarded-workspace"
      }
    });
  });

  it("returns 404 when the approval is not pending for the requested run", async () => {
    const approvalService = createApprovalServiceSpy({
      approveError: new CoreError("NOT_FOUND", "Pending approval not found for run")
    });
    const { app } = createTestContext({ approvalService });
    const workspace = await createWorkspace(app, "soul-approve-missing");
    const runId = await createRun(app, workspace.workspace_id, "missing approval run");

    const response = await app.request("/soul/approval/approval-missing/approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ run_id: runId })
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Resource not found"
    });
  });

  it("returns 409 when the approval has already been resolved", async () => {
    const approvalService = createApprovalServiceSpy({
      rejectError: new CoreError("CONFLICT", "Approval has already been resolved")
    });
    const { app } = createTestContext({ approvalService });
    const workspace = await createWorkspace(app, "soul-reject-conflict");
    const runId = await createRun(app, workspace.workspace_id, "resolved approval run");

    const response = await app.request("/soul/approval/approval-2/reject", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ run_id: runId })
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Request conflict"
    });
  });

  it("routes approve requests through the injected approval service and returns the success envelope", async () => {
    const approvalService = createApprovalServiceSpy();
    const { app } = createTestContext({ approvalService });
    const workspace = await createWorkspace(app, "soul-approve");
    const runId = await createRun(app, workspace.workspace_id, "approval run");

    const response = await app.request("/soul/approval/approval-1/approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ run_id: runId })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        approval_id: "approval-1",
        result: "approved",
        resolved_at: "2026-04-01T00:00:00.000Z"
      }
    });
    expect(approvalService.approve).toHaveBeenCalledWith({
      approvalId: "approval-1",
      runId,
      causedBy: "user_action"
    });
    expect(approvalService.appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "soul.approval_resolved",
        entity_type: "approval",
        entity_id: "approval-1",
        run_id: runId,
        caused_by: "user_action",
        payload_json: expect.objectContaining({
          approval_id: "approval-1",
          result: "approved",
          run_id: runId,
          message_id: "msg_approval_1"
        })
      })
    );
    expect(approvalService.broadcastSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "soul.approval_resolved",
        entity_id: "approval-1",
        run_id: runId
      })
    );
  });

  it("routes reject requests through the injected approval service and returns the success envelope", async () => {
    const approvalService = createApprovalServiceSpy();
    const { app } = createTestContext({ approvalService });
    const workspace = await createWorkspace(app, "soul-reject");
    const runId = await createRun(app, workspace.workspace_id, "rejection run");

    const response = await app.request("/soul/approval/approval-2/reject", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ run_id: runId })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        approval_id: "approval-2",
        result: "rejected",
        resolved_at: "2026-04-01T00:00:00.000Z"
      }
    });
    expect(approvalService.reject).toHaveBeenCalledWith({
      approvalId: "approval-2",
      runId,
      causedBy: "user_action"
    });
    expect(approvalService.appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "soul.approval_resolved",
        entity_id: "approval-2",
        run_id: runId,
        payload_json: expect.objectContaining({
          approval_id: "approval-2",
          result: "rejected",
          run_id: runId
        })
      })
    );
    expect(approvalService.broadcastSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "soul.approval_resolved",
        entity_id: "approval-2",
        run_id: runId
      })
    );
  });
});

function createTestContext(): {
  readonly app: ReturnType<typeof createApp>;
  readonly database: StorageDatabase;
  readonly graphExploreService: NonNullable<CoreDaemonServices["graphExploreService"]>;
  readonly topologyService: NonNullable<CoreDaemonServices["topologyService"]>;
  readonly eventLogRepo: SqliteEventLogRepo;
}
function createTestContext(options?: {
  readonly approvalService?: ReturnType<typeof createApprovalServiceSpy>;
  readonly omitTopologyAuditLog?: boolean;
  readonly requestProtection?: {
    readonly allowedOrigin: string;
    readonly requestToken: string;
    readonly allowDesktopOriginlessRequests?: boolean;
  };
}): {
  readonly app: ReturnType<typeof createApp>;
  readonly database: StorageDatabase;
  readonly graphExploreService: NonNullable<CoreDaemonServices["graphExploreService"]>;
  readonly topologyService: NonNullable<CoreDaemonServices["topologyService"]>;
  readonly eventLogRepo: SqliteEventLogRepo;
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
  const graphExploreService: NonNullable<CoreDaemonServices["graphExploreService"]> = {
    exploreOneHop: vi.fn(async (): Promise<readonly GraphNeighbor[]> => [
      {
        memory_id: "memory-2",
        edge_type: "supports",
        direction: "outbound",
        edge_id: "edge-1"
      }
    ])
  };
  const topologyService: NonNullable<CoreDaemonServices["topologyService"]> = {
    explore: vi.fn(async (workspaceId: string): Promise<Readonly<TopologyExplorationResult>> => ({
      exploration_id: `topology-explore:${workspaceId}:2026-04-21T08:00:00.000Z`,
      workspace_id: workspaceId,
      total_nodes: 3,
      total_edges: 2,
      max_out_degree: 2,
      max_in_degree: 1,
      avg_degree: 4 / 3,
      strongly_connected_components: 2,
      explored_at: "2026-04-21T08:00:00.000Z"
    }))
  };
  const services = {
    workspaceService,
    runService,
    principalCodingEngineAvailable: true,
    conversationService: createNoopConversationService("soul route tests") as never,
    engineBindingService: createStubEngineBindingService() as never,
    runHotStateService,
    sseManager,
    signalService: createUnusedSignalService("soul route tests") as never,
    evidenceService: createUnusedEvidenceService("soul route tests") as never,
    memoryService: createUnusedMemoryService("soul route tests") as never,
    slotService: createUnusedSlotService("soul route tests") as never,
    surfaceService: createUnusedSurfaceService("soul route tests") as never,
    synthesisService: createUnusedSynthesisService("soul route tests") as never,
    claimService: createUnusedClaimService("soul route tests") as never,
    proposalService: createUnusedProposalService("soul route tests") as never,
    graphExploreService,
    topologyService,
    eventLogRepo: options?.omitTopologyAuditLog ? undefined : eventLogRepo,
    soulApprovalService: options?.approvalService,
    requestProtection: options?.requestProtection
  };

  return {
    app: createApp(services as CoreDaemonServices),
    database,
    graphExploreService,
    topologyService,
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
  const body = await response.json();
  const workspace = body.data;
  await configureWorkspacePrincipalCodingEngine(app, workspace.workspace_id);
  return workspace;
}

async function createProtectedWorkspace(
  app: ReturnType<typeof createApp>,
  name: string,
  requestProtection: {
    readonly allowedOrigin: string;
    readonly requestToken: string;
  }
): Promise<{
  readonly workspace_id: string;
}> {
  const response = await app.request("/workspaces", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: requestProtection.allowedOrigin,
      "x-request-token": requestProtection.requestToken
    },
    body: JSON.stringify({
      name,
      root_path: `/tmp/${name}`,
      workspace_kind: WorkspaceKind.LOCAL_REPO
    })
  });

  expect(response.status).toBe(201);
  const body = await response.json();
  return body.data;
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
      run_mode: "chat"
    })
  });

  expect(response.status).toBe(201);
  const body = await response.json();
  return body.data.run_id;
}

function createApprovalServiceSpy(options?: {
  readonly approveError?: Error;
  readonly rejectError?: Error;
}) {
  const appendSpy = vi.fn((entry: Record<string, unknown>) => ({
    event_id: "event-approval-1",
    created_at: "2026-04-01T00:00:00.000Z",
    revision: 0,
    ...entry
  }));
  const broadcastSpy = vi.fn();

  return {
    appendSpy,
    broadcastSpy,
    approve: vi.fn(async ({ approvalId, runId, causedBy }: {
      readonly approvalId: string;
      readonly runId: string;
      readonly causedBy: string;
    }) => {
      if (options?.approveError !== undefined) {
        throw options.approveError;
      }

      const event = appendSpy({
        event_type: "soul.approval_resolved",
        entity_type: "approval",
        entity_id: approvalId,
        workspace_id: "ws_approval",
        run_id: runId,
        caused_by: causedBy,
        payload_json: {
          message_id: "msg_approval_1",
          approval_id: approvalId,
          result: "approved",
          description: "Approval granted",
          resolved_at: "2026-04-01T00:00:00.000Z",
          run_id: runId
        }
      });
      broadcastSpy(event);
      return {
        approval_id: approvalId,
        result: "approved" as const,
        resolved_at: "2026-04-01T00:00:00.000Z"
      };
    }),
    reject: vi.fn(async ({ approvalId, runId, causedBy }: {
      readonly approvalId: string;
      readonly runId: string;
      readonly causedBy: string;
    }) => {
      if (options?.rejectError !== undefined) {
        throw options.rejectError;
      }

      const event = appendSpy({
        event_type: "soul.approval_resolved",
        entity_type: "approval",
        entity_id: approvalId,
        workspace_id: "ws_approval",
        run_id: runId,
        caused_by: causedBy,
        payload_json: {
          message_id: "msg_approval_2",
          approval_id: approvalId,
          result: "rejected",
          description: "Approval rejected",
          resolved_at: "2026-04-01T00:00:00.000Z",
          run_id: runId
        }
      });
      broadcastSpy(event);
      return {
        approval_id: approvalId,
        result: "rejected" as const,
        resolved_at: "2026-04-01T00:00:00.000Z"
      };
    })
  };
}
