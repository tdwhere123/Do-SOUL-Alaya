import { afterEach, describe, expect, it } from "vitest";
import {
  EventPublisher,
  RunHotStateService,
  RunService,
  SurfaceDriftService,
  SurfaceService,
  WorkspaceService
} from "@do-what/core";
import { PhaseCEventType, SurfaceStatus, WorkspaceKind } from "@do-what/protocol";
import {
  SqliteDriftLeaseRepo,
  SqliteEventLogRepo,
  SqliteRunRepo,
  SqliteSurfaceAnchorRepo,
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

const MISSING_SURFACE_ID = "99999999-9999-4999-8999-999999999999";
const MISSING_ANCHOR_ID = "99999999-9999-4999-8999-999999999999";

interface TestContext {
  readonly app: ReturnType<typeof createApp>;
  readonly database: StorageDatabase;
  readonly surfaceService: SurfaceService;
  readonly eventLogRepo: SqliteEventLogRepo;
  readonly sseManager: SseManager;
}

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

describe("surface routes", () => {
  it("creates a surface", async () => {
    const { app } = createTestContext();
    const workspace = await createWorkspace(app, "surface-create");

    const response = await app.request(`/workspaces/${workspace.workspace_id}/surfaces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        surface_id: "surface://main",
        surface_kind: "conversation"
      })
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        object_kind: "surface_identity",
        surface_id: "surface://main",
        surface_kind: "conversation",
        workspace_id: workspace.workspace_id,
        surface_status: SurfaceStatus.ACTIVE
      }
    });
  });

  it("returns 400 when create body is malformed", async () => {
    const { app } = createTestContext();
    const workspace = await createWorkspace(app, "surface-malformed");

    const response = await app.request(`/workspaces/${workspace.workspace_id}/surfaces`, {
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

  it("returns 400 when surface_id is missing", async () => {
    const { app } = createTestContext();
    const workspace = await createWorkspace(app, "surface-missing-id");

    const response = await app.request(`/workspaces/${workspace.workspace_id}/surfaces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        surface_kind: "conversation"
      })
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Invalid request"
    });
  });

  it("lists surfaces by workspace", async () => {
    const { app } = createTestContext();
    const workspace = await createWorkspace(app, "surface-list");

    await createSurface(app, workspace.workspace_id, "surface://list", "conversation");

    const response = await app.request(`/workspaces/${workspace.workspace_id}/surfaces`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: [
        expect.objectContaining({
          surface_id: "surface://list",
          workspace_id: workspace.workspace_id
        })
      ]
    });
  });

  it("gets surface by id", async () => {
    const { app } = createTestContext();
    const workspace = await createWorkspace(app, "surface-get");
    const created = await createSurface(app, workspace.workspace_id, "surface://get", "conversation");

    const response = await app.request(`/surfaces/${created.object_id}`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        object_id: created.object_id,
        surface_id: "surface://get"
      }
    });
  });

  it("returns 404 when surface does not exist", async () => {
    const { app } = createTestContext();

    const response = await app.request(`/surfaces/${MISSING_SURFACE_ID}`);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Resource not found"
    });
  });

  it("updates surface status", async () => {
    const { app } = createTestContext();
    const workspace = await createWorkspace(app, "surface-transition");
    const created = await createSurface(app, workspace.workspace_id, "surface://status", "conversation");

    const response = await app.request(`/surfaces/${created.object_id}/status`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        next_status: SurfaceStatus.WEAKLY_BOUND,
        reason: "anchor_degradation"
      })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        object_id: created.object_id,
        surface_status: SurfaceStatus.WEAKLY_BOUND
      }
    });
  });

  it("emits C-4 drift events on surface status transitions", async () => {
    const { app, eventLogRepo } = createTestContext();
    const workspace = await createWorkspace(app, "surface-drift-route");
    const created = await createSurface(app, workspace.workspace_id, "surface://drift", "conversation");

    const response = await app.request(`/surfaces/${created.object_id}/status`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        next_status: SurfaceStatus.WEAKLY_BOUND,
        reason: "anchor_degradation"
      })
    });

    expect(response.status).toBe(200);
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

  it("streams surface.drift_lease_released over workspace SSE on status transitions", async () => {
    const { app, eventLogRepo, sseManager } = createTestContext();
    const workspace = await createWorkspace(app, "surface-drift-release-route");
    const created = await createSurface(
      app,
      workspace.workspace_id,
      "surface://drift-release",
      "conversation"
    );

    const stream = createSseClient(
      await app.request(`/workspaces/${workspace.workspace_id}/events`)
    );
    await waitForCondition(() => sseManager.connectionCount(undefined, workspace.workspace_id) === 1);
    await stream.readEvent();

    const response = await app.request(`/surfaces/${created.object_id}/status`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        next_status: SurfaceStatus.WEAKLY_BOUND,
        reason: "anchor_degradation"
      })
    });

    expect(response.status).toBe(200);
    await expect(eventLogRepo.queryByWorkspace(workspace.workspace_id)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event_type: PhaseCEventType.SURFACE_DRIFT_LEASE_RELEASED,
          payload_json: expect.objectContaining({
            workspace_id: workspace.workspace_id,
            released_by: "user"
          })
        })
      ])
    );

    const streamedEvents: ParsedSseEvent[] = [];
    for (let index = 0; index < 8; index += 1) {
      const event = await stream.readEvent();
      streamedEvents.push(event);
      if (event.event === PhaseCEventType.SURFACE_DRIFT_LEASE_RELEASED) {
        break;
      }
    }

    const streamedEventTypes = streamedEvents.map((event) => event.event);
    expect(streamedEventTypes).toEqual(
      expect.arrayContaining([
        PhaseCEventType.SURFACE_DRIFT_LEASE_ACQUIRED,
        PhaseCEventType.SURFACE_DRIFT_DETECTED,
        PhaseCEventType.SURFACE_DRIFT_ALERT,
        PhaseCEventType.SURFACE_DRIFT_LEASE_RELEASED
      ])
    );
    expect(
      streamedEventTypes.indexOf(PhaseCEventType.SURFACE_DRIFT_LEASE_RELEASED)
    ).toBeGreaterThan(
      streamedEventTypes.indexOf(PhaseCEventType.SURFACE_DRIFT_LEASE_ACQUIRED)
    );
    expect(
      streamedEvents.find((event) => event.event === PhaseCEventType.SURFACE_DRIFT_LEASE_RELEASED)
    ).toMatchObject({
      data: expect.objectContaining({
        workspace_id: workspace.workspace_id,
        released_by: "user"
      })
    });

    await stream.close();
    await waitForCondition(() => sseManager.connectionCount(undefined, workspace.workspace_id) === 0);
  });

  it("returns 400 for invalid status transition", async () => {
    const { app } = createTestContext();
    const workspace = await createWorkspace(app, "surface-invalid-transition");
    const created = await createSurface(app, workspace.workspace_id, "surface://terminal", "conversation");

    const revoke = await app.request(`/surfaces/${created.object_id}/status`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        next_status: SurfaceStatus.REVOKED,
        reason: "policy_revoked"
      })
    });
    expect(revoke.status).toBe(200);

    const response = await app.request(`/surfaces/${created.object_id}/status`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        next_status: SurfaceStatus.ACTIVE,
        reason: "re_anchor"
      })
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Invalid surface status transition: revoked -> active"
    });
  });

  it("creates and lists anchors for a surface", async () => {
    const { app } = createTestContext();
    const workspace = await createWorkspace(app, "surface-anchor-create");
    const createdSurface = await createSurface(app, workspace.workspace_id, "surface://anchor", "conversation");

    const createResponse = await app.request(`/surfaces/${createdSurface.object_id}/anchors`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        anchor_kind: "path_fragment",
        anchor_value: "apps/core-daemon/src"
      })
    });

    expect(createResponse.status).toBe(201);
    const createdBody = (await createResponse.json()) as {
      readonly data: {
        readonly object_id: string;
      };
    };

    const listResponse = await app.request(`/surfaces/${createdSurface.object_id}/anchors`);

    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toMatchObject({
      success: true,
      data: [
        expect.objectContaining({
          object_id: createdBody.data.object_id,
          surface_id: "surface://anchor"
        })
      ]
    });
  });

  it("deletes anchor", async () => {
    const { app } = createTestContext();
    const workspace = await createWorkspace(app, "surface-anchor-delete");
    const createdSurface = await createSurface(app, workspace.workspace_id, "surface://anchor-del", "conversation");

    const createAnchorResponse = await app.request(`/surfaces/${createdSurface.object_id}/anchors`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        anchor_kind: "path_fragment",
        anchor_value: "apps/core-daemon/src"
      })
    });

    const createdAnchorBody = (await createAnchorResponse.json()) as {
      readonly data: {
        readonly object_id: string;
      };
    };

    const deleteResponse = await app.request(`/surface-anchors/${createdAnchorBody.data.object_id}`, {
      method: "DELETE"
    });

    expect(deleteResponse.status).toBe(200);
    await expect(deleteResponse.json()).resolves.toMatchObject({ success: true });
  });

  it("returns 404 when deleting missing anchor", async () => {
    const { app } = createTestContext();

    const response = await app.request(`/surface-anchors/${MISSING_ANCHOR_ID}`, {
      method: "DELETE"
    });

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
  const surfaceIdentityRepo = new SqliteSurfaceIdentityRepo(database);
  const surfaceAnchorRepo = new SqliteSurfaceAnchorRepo(database);
  const runHotStateService = new RunHotStateService({ runRepo, eventLogRepo });
  const sseManager = new SseManager(eventLogRepo);

  const eventPublisher = new EventPublisher({
    eventLogRepo,
    runHotStateService,
    sseBroadcaster: sseManager
  });
  const driftLeaseRepo = new SqliteDriftLeaseRepo(database);

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

  const surfaceService = new SurfaceService({
    surfaceIdentityRepo,
    surfaceAnchorRepo,
    sseBroadcaster: sseManager,
    surfaceDriftService: new SurfaceDriftService({
      leaseRepo: driftLeaseRepo,
      eventPublisher
    })
  });

  return {
    app: createApp({
      workspaceService,
      runService,
      conversationService: createNoopConversationService("surface route tests") as any,
      engineBindingService: createStubEngineBindingService() as any,
      runHotStateService,
      sseManager,
      signalService: createUnusedSignalService("surface route tests") as any,
      evidenceService: createUnusedEvidenceService("surface route tests") as any,
      memoryService: createUnusedMemoryService("surface route tests") as any,
      slotService: createUnusedSlotService("surface route tests") as any,
      surfaceService,
      synthesisService: createUnusedSynthesisService("surface route tests") as any,
      claimService: createUnusedClaimService("surface route tests") as any,
      proposalService: createUnusedProposalService("surface route tests") as any
    }),
    database,
    surfaceService,
    eventLogRepo,
    sseManager
  };
}

async function createWorkspace(
  app: ReturnType<typeof createApp>,
  name: string
): Promise<{
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
  const body = (await response.json()) as {
    readonly data: {
      readonly workspace_id: string;
    };
  };

  return body.data;
}

async function createSurface(
  app: ReturnType<typeof createApp>,
  workspaceId: string,
  surfaceId: string,
  surfaceKind: string
): Promise<{
  readonly object_id: string;
}> {
  const response = await app.request(`/workspaces/${workspaceId}/surfaces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      surface_id: surfaceId,
      surface_kind: surfaceKind
    })
  });

  expect(response.status).toBe(201);
  const body = (await response.json()) as {
    readonly data: {
      readonly object_id: string;
    };
  };

  return body.data;
}

type ParsedSseEvent = Readonly<{
  id: string;
  event: string;
  data: Record<string, unknown> | null;
}>;

function createSseClient(response: Response): SseTestClient {
  if (response.body === null) {
    throw new Error("Expected SSE response body");
  }

  return new SseTestClient(response.body.getReader());
}

class SseTestClient {
  private readonly decoder = new TextDecoder();
  private buffer = "";

  public constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  public async readEvent(timeoutMs = 2000): Promise<ParsedSseEvent> {
    while (true) {
      const delimiter = this.buffer.indexOf("\n\n");
      if (delimiter >= 0) {
        const frame = this.buffer.slice(0, delimiter);
        this.buffer = this.buffer.slice(delimiter + 2);
        return parseSseFrame(frame);
      }

      const chunk = await readWithTimeout(this.reader, timeoutMs);
      if (chunk.done) {
        throw new Error("SSE stream closed before next event");
      }

      this.buffer += this.decoder.decode(chunk.value, { stream: true });
    }
  }

  public async close(): Promise<void> {
    await this.reader.cancel();
  }
}

async function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for SSE chunk after ${timeoutMs}ms`));
    }, timeoutMs);

    reader.read().then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function parseSseFrame(frame: string): ParsedSseEvent {
  let id = "";
  let event = "message";
  const dataLines: string[] = [];

  for (const rawLine of frame.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.startsWith("id:")) {
      id = line.slice(3).trim();
      continue;
    }
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trim());
    }
  }

  const dataText = dataLines.join("\n");

  return {
    id,
    event,
    data: dataText.length === 0 ? null : (JSON.parse(dataText) as Record<string, unknown>)
  };
}

async function waitForCondition(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();

  while (!condition()) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`Condition was not met within ${timeoutMs}ms`);
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
