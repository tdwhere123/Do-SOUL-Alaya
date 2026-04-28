import { afterEach, describe, expect, it } from "vitest";
import {
  CrossCuttingPermissionService,
  EventPublisher,
  RunHotStateService,
  RunService,
  SurfaceBindingService,
  SurfaceDriftService,
  SurfaceService,
  WorkspaceService
} from "@do-what/core";
import { BindingState, CrossCuttingState, PhaseCEventType, WorkspaceKind } from "@do-what/protocol";
import {
  SqliteCrossCuttingPermissionRepo,
  SqliteDriftLeaseRepo,
  SqliteEventLogRepo,
  SqliteRunRepo,
  SqliteSurfaceAnchorRepo,
  SqliteSurfaceBindingRepo,
  SqliteSurfaceIdentityRepo,
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
  createUnusedSlotService,
  createUnusedSynthesisService
} from "./helpers/mock-services.js";
import { SseManager } from "../sse/sse-manager.js";

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

describe("surface binding routes", () => {
  it("creates first surface binding", async () => {
    const { app } = createTestContext();
    const workspace = await createWorkspace(app, "surface-binding-create");
    await createSurface(app, workspace.workspace_id, "surface://main");

    const response = await app.request(`/workspaces/${workspace.workspace_id}/surface-bindings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        object_id: "claim://object-1",
        surface_id: "surface://main",
        is_primary: true
      })
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        binding_id: expect.any(String),
        object_kind: "surface_binding",
        object_id: "claim://object-1",
        surface_id: "surface://main",
        is_primary: true,
        binding_state: BindingState.ACTIVE,
        workspace_id: workspace.workspace_id
      }
    });
  });

  it("emits C-4 drift events when creating a surface binding", async () => {
    const { app, eventLogRepo } = createTestContext();
    const workspace = await createWorkspace(app, "surface-binding-drift-events");
    await createSurface(app, workspace.workspace_id, "surface://main");

    const response = await app.request(`/workspaces/${workspace.workspace_id}/surface-bindings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        object_id: "claim://object-1",
        surface_id: "surface://main",
        is_primary: true
      })
    });

    expect(response.status).toBe(201);
    const events = await eventLogRepo.queryByWorkspace(workspace.workspace_id);
    const eventTypes = events.map((event) => event.event_type);

    expect(eventTypes).toEqual(
      expect.arrayContaining([
        PhaseCEventType.SURFACE_DRIFT_LEASE_ACQUIRED,
        PhaseCEventType.SURFACE_DRIFT_DETECTED,
        PhaseCEventType.SURFACE_DRIFT_ALERT
      ])
    );
  });

  it("blocks second binding when cross_cutting is not active", async () => {
    const { app } = createTestContext();
    const workspace = await createWorkspace(app, "surface-binding-conflict");
    await createSurface(app, workspace.workspace_id, "surface://main");
    await createSurface(app, workspace.workspace_id, "surface://secondary");

    const first = await app.request(`/workspaces/${workspace.workspace_id}/surface-bindings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        object_id: "claim://object-1",
        surface_id: "surface://main",
        is_primary: true
      })
    });
    expect(first.status).toBe(201);

    const second = await app.request(`/workspaces/${workspace.workspace_id}/surface-bindings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        object_id: "claim://object-1",
        surface_id: "surface://secondary",
        is_primary: false
      })
    });

    expect(second.status).toBe(409);
    await expect(second.json()).resolves.toMatchObject({
      success: false,
      error: "Request conflict"
    });
  });

  it("returns 404 when binding references an unknown surface", async () => {
    const { app } = createTestContext();
    const workspace = await createWorkspace(app, "surface-binding-missing-surface");

    const response = await app.request(`/workspaces/${workspace.workspace_id}/surface-bindings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        object_id: "claim://object-1",
        surface_id: "surface://missing",
        is_primary: true
      })
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Resource not found"
    });
  });

  it("lists bindings and includes binding_id", async () => {
    const { app } = createTestContext();
    const workspace = await createWorkspace(app, "surface-binding-list");
    await createSurface(app, workspace.workspace_id, "surface://main");

    await app.request(`/workspaces/${workspace.workspace_id}/surface-bindings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        object_id: "claim://object-1",
        surface_id: "surface://main",
        is_primary: true
      })
    });

    const response = await app.request(`/workspaces/${workspace.workspace_id}/surface-bindings`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: [
        {
          binding_id: expect.any(String),
          object_id: "claim://object-1",
          surface_id: "surface://main"
        }
      ]
    });
  });

  it("fails fast when surface binding routes are registered without the batch anchor repo", () => {
    expect(() => createTestContext({ includeSurfaceAnchorRepo: false })).toThrowError(
      "surfaceAnchorRepo is required when surface binding routes are registered"
    );
  });

  it("lists all workspace surface anchors in one batch route", async () => {
    const { app } = createTestContext();
    const workspace = await createWorkspace(app, "surface-anchor-batch-list");
    const mainSurfaceObjectId = await createSurface(app, workspace.workspace_id, "surface://main");
    const reviewSurfaceObjectId = await createSurface(app, workspace.workspace_id, "surface://review");
    await createSurfaceAnchor(app, mainSurfaceObjectId, "src/main.ts:10");
    await createSurfaceAnchor(app, reviewSurfaceObjectId, "src/review.ts:8");

    const response = await app.request(`/workspaces/${workspace.workspace_id}/surface-anchors`);
    const body = (await response.json()) as {
      readonly success: boolean;
      readonly data: ReadonlyArray<{ readonly surface_id: string; readonly anchor_value: string }>;
    };

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(2);
    expect(body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          surface_id: "surface://main",
          anchor_value: "src/main.ts:10"
        }),
        expect.objectContaining({
          surface_id: "surface://review",
          anchor_value: "src/review.ts:8"
        })
      ])
    );
  });

  it("returns empty workspace anchor batch when no anchors exist", async () => {
    const { app } = createTestContext();
    const workspace = await createWorkspace(app, "surface-anchor-batch-empty");

    const response = await app.request(`/workspaces/${workspace.workspace_id}/surface-anchors`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: []
    });
  });

  it("returns 404 for unknown workspace anchor batch route", async () => {
    const { app } = createTestContext();

    const response = await app.request("/workspaces/ws-missing/surface-anchors");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Resource not found"
    });
  });

  it("keeps per-surface anchor route working", async () => {
    const { app } = createTestContext();
    const workspace = await createWorkspace(app, "surface-anchor-single-route");
    const surfaceObjectId = await createSurface(app, workspace.workspace_id, "surface://main");
    await createSurfaceAnchor(app, surfaceObjectId, "src/main.ts:10");

    const response = await app.request(`/surfaces/${surfaceObjectId}/anchors`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: [
        expect.objectContaining({
          surface_id: "surface://main",
          anchor_value: "src/main.ts:10"
        })
      ]
    });
  });

  it("updates binding state", async () => {
    const { app } = createTestContext();
    const workspace = await createWorkspace(app, "surface-binding-transition");
    await createSurface(app, workspace.workspace_id, "surface://main");

    const created = await app.request(`/workspaces/${workspace.workspace_id}/surface-bindings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        object_id: "claim://object-1",
        surface_id: "surface://main",
        is_primary: true
      })
    });
    const createdBody = (await created.json()) as { readonly data: { readonly binding_id: string } };

    const response = await app.request(`/surface-bindings/${createdBody.data.binding_id}/state`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        next_state: BindingState.STALE,
        reason: "anchor_degradation"
      })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        binding_id: createdBody.data.binding_id,
        binding_state: BindingState.STALE
      }
    });
  });

  it("returns 404 when updating missing binding", async () => {
    const { app } = createTestContext();

    const response = await app.request(
      "/surface-bindings/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/state",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          next_state: BindingState.STALE,
          reason: "anchor_degradation"
        })
      }
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Resource not found"
    });
  });

  it("creates cross_cutting permission with default none", async () => {
    const { app } = createTestContext();
    const workspace = await createWorkspace(app, "cross-cutting-create");

    const response = await app.request(`/workspaces/${workspace.workspace_id}/cross-cutting-permissions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        object_id: "claim://object-1"
      })
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        permission_id: expect.any(String),
        object_kind: "cross_cutting_permission",
        object_id: "claim://object-1",
        cross_cutting_state: CrossCuttingState.NONE,
        allowed_surfaces: []
      }
    });
  });

  it("transitions cross_cutting to active and then allows second binding", async () => {
    const { app } = createTestContext();
    const workspace = await createWorkspace(app, "cross-cutting-activate");
    await createSurface(app, workspace.workspace_id, "surface://main");
    await createSurface(app, workspace.workspace_id, "surface://secondary");

    const createPermission = await app.request(
      `/workspaces/${workspace.workspace_id}/cross-cutting-permissions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ object_id: "claim://object-1" })
      }
    );
    expect(createPermission.status).toBe(201);
    const permission = (await createPermission.json()) as {
      readonly data: { readonly permission_id: string };
    };

    const toCandidate = await app.request(
      `/cross-cutting-permissions/${permission.data.permission_id}/state`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          next_state: CrossCuttingState.CANDIDATE,
          allowed_surfaces: [],
          reason: "proposal"
        })
      }
    );
    expect(toCandidate.status).toBe(200);

    const toActive = await app.request(
      `/cross-cutting-permissions/${permission.data.permission_id}/state`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          next_state: CrossCuttingState.ACTIVE,
          allowed_surfaces: ["surface://secondary"],
          reason: "review_accepted"
        })
      }
    );
    expect(toActive.status).toBe(200);

    const first = await app.request(`/workspaces/${workspace.workspace_id}/surface-bindings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        object_id: "claim://object-1",
        surface_id: "surface://main",
        is_primary: true
      })
    });
    expect(first.status).toBe(201);

    const second = await app.request(`/workspaces/${workspace.workspace_id}/surface-bindings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        object_id: "claim://object-1",
        surface_id: "surface://secondary",
        is_primary: false
      })
    });

    expect(second.status).toBe(201);
    await expect(second.json()).resolves.toMatchObject({
      success: true,
      data: {
        surface_id: "surface://secondary",
        is_primary: false
      }
    });
  });

  it("returns 400 for invalid cross_cutting transition", async () => {
    const { app } = createTestContext();
    const workspace = await createWorkspace(app, "cross-cutting-invalid");

    const created = await app.request(`/workspaces/${workspace.workspace_id}/cross-cutting-permissions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ object_id: "claim://object-1" })
    });

    const body = (await created.json()) as { readonly data: { readonly permission_id: string } };

    const response = await app.request(`/cross-cutting-permissions/${body.data.permission_id}/state`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        next_state: CrossCuttingState.ACTIVE,
        allowed_surfaces: ["surface://main"],
        reason: "skip_candidate"
      })
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Invalid cross_cutting transition: none -> active"
    });
  });

  it("returns 400 when allowed_surfaces includes non-surface uri", async () => {
    const { app } = createTestContext();
    const workspace = await createWorkspace(app, "cross-cutting-bad-surfaces");

    const created = await app.request(`/workspaces/${workspace.workspace_id}/cross-cutting-permissions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ object_id: "claim://object-1" })
    });

    const body = (await created.json()) as { readonly data: { readonly permission_id: string } };

    const toCandidate = await app.request(`/cross-cutting-permissions/${body.data.permission_id}/state`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        next_state: CrossCuttingState.CANDIDATE,
        reason: "proposal"
      })
    });
    expect(toCandidate.status).toBe(200);

    const response = await app.request(`/cross-cutting-permissions/${body.data.permission_id}/state`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        next_state: CrossCuttingState.ACTIVE,
        allowed_surfaces: ["not-a-surface-uri"],
        reason: "review_accepted"
      })
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Invalid request"
    });
  });

  it("returns 404 when updating missing cross_cutting permission", async () => {
    const { app } = createTestContext();

    const response = await app.request(
      "/cross-cutting-permissions/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/state",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          next_state: CrossCuttingState.CANDIDATE,
          reason: "proposal"
        })
      }
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Resource not found"
    });
  });

  it("returns 400 for malformed JSON", async () => {
    const { app } = createTestContext();
    const workspace = await createWorkspace(app, "surface-binding-malformed");

    const response = await app.request(`/workspaces/${workspace.workspace_id}/surface-bindings`, {
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
});

function createTestContext(options: { readonly includeSurfaceAnchorRepo?: boolean } = {}): {
  readonly app: ReturnType<typeof createApp>;
  readonly database: StorageDatabase;
  readonly eventLogRepo: SqliteEventLogRepo;
} {
  const includeSurfaceAnchorRepo = options.includeSurfaceAnchorRepo ?? true;
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);

  const workspaceRepo = new SqliteWorkspaceRepo(database);
  const runRepo = new SqliteRunRepo(database);
  const eventLogRepo = new SqliteEventLogRepo(database);
  const surfaceIdentityRepo = new SqliteSurfaceIdentityRepo(database);
  const surfaceAnchorRepo = new SqliteSurfaceAnchorRepo(database);
  const surfaceBindingRepo = new SqliteSurfaceBindingRepo(database);
  const crossCuttingRepo = new SqliteCrossCuttingPermissionRepo(database);
  const runHotStateService = new RunHotStateService({ runRepo, eventLogRepo });
  const sseManager = new SseManager(eventLogRepo);

  const eventPublisher = new EventPublisher({
    eventLogRepo,
    runHotStateService,
    sseBroadcaster: sseManager
  });
  const driftLeaseRepo = new SqliteDriftLeaseRepo(database);
  const surfaceDriftService = new SurfaceDriftService({
    leaseRepo: driftLeaseRepo,
    eventPublisher
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

  const crossCuttingPermissionService = new CrossCuttingPermissionService({
    crossCuttingRepo,
    sseBroadcaster: sseManager
  });

  const surfaceBindingService = new SurfaceBindingService({
    surfaceBindingRepo,
    crossCuttingPermissionLookup: crossCuttingRepo,
    eventPublisher,
    sseBroadcaster: sseManager,
    surfaceDriftService
  });

  const surfaceService = new SurfaceService({
    surfaceIdentityRepo,
    surfaceAnchorRepo,
    sseBroadcaster: sseManager,
    surfaceBindingCascader: surfaceBindingService,
    surfaceDriftService
  });

  return {
    app: createApp({
      workspaceService,
      runService,
      conversationService: createNoopConversationService("surface binding route tests") as any,
      engineBindingService: createStubEngineBindingService() as any,
      runHotStateService,
      sseManager,
      signalService: createUnusedSignalService("surface binding route tests") as any,
      evidenceService: createUnusedEvidenceService("surface binding route tests") as any,
      memoryService: createUnusedMemoryService("surface binding route tests") as any,
      slotService: createUnusedSlotService("surface binding route tests") as any,
      surfaceService,
      ...(includeSurfaceAnchorRepo ? { surfaceAnchorRepo } : {}),
      surfaceBindingService,
      crossCuttingPermissionService,
      synthesisService: createUnusedSynthesisService("surface binding route tests") as any,
      claimService: createUnusedClaimService("surface binding route tests") as any,
      proposalService: createUnusedProposalService("surface binding route tests") as any
    }),
    database,
    eventLogRepo
  };
}

async function createWorkspace(
  app: ReturnType<typeof createApp>,
  name: string
): Promise<{ readonly workspace_id: string }> {
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
  const body = (await response.json()) as { readonly data: { readonly workspace_id: string } };

  return body.data;
}

async function createSurface(
  app: ReturnType<typeof createApp>,
  workspaceId: string,
  surfaceId: string
): Promise<string> {
  const response = await app.request(`/workspaces/${workspaceId}/surfaces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      surface_id: surfaceId,
      surface_kind: "conversation"
    })
  });

  expect(response.status).toBe(201);
  const body = (await response.json()) as { readonly data: { readonly object_id: string } };
  return body.data.object_id;
}

async function createSurfaceAnchor(
  app: ReturnType<typeof createApp>,
  surfaceObjectId: string,
  anchorValue: string
): Promise<void> {
  const response = await app.request(`/surfaces/${surfaceObjectId}/anchors`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      anchor_kind: "path_fragment",
      anchor_value: anchorValue
    })
  });

  expect(response.status).toBe(201);
}
