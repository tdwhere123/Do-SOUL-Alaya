import { afterEach, describe, expect, it } from "vitest";
import type { ReadableStreamDefaultReader, ReadableStreamReadResult } from "node:stream/web";
import {
  PhaseCEventType,
  WorkerBaselineLockSchema,
  WorkspaceKind,
  ZeroDayPolicySchema,
  type ZeroDayPolicy
} from "@do-what/protocol";
import {
  RunService,
  ZeroDaySecurityLayer
} from "@do-what/core";
import {
  SqliteEngineBindingRepo,
  SqliteEventLogRepo,
  SqliteRunRepo,
  SqliteWorkspaceRepo,
  initDatabase,
  type StorageDatabase
} from "@do-what/storage";
import { createApp } from "../app.js";
import { createSecurityStatusBootstrapServices } from "../security-status-bootstrap.js";
import {
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

interface TestContext {
  readonly app: ReturnType<typeof createApp>;
  readonly database: StorageDatabase;
  readonly eventLogRepo: SqliteEventLogRepo;
  readonly sseManager: SseManager;
  readonly workspaceService: ReturnType<
    typeof createSecurityStatusBootstrapServices
  >["workspaceService"];
  createUnsecuredWorkspace(name: string): Promise<WorkspaceResponseBody["data"]>;
  reevaluateWorkspaceSecurity(workspaceId: string): Promise<void>;
  setPolicies(policies: readonly ZeroDayPolicy[]): void;
}

interface CreateTestContextOptions {
  readonly failWorkspaceSecurityInitialize?: boolean;
  readonly failWorkspaceSecurityInitializeCode?: string;
}

interface WorkspaceResponseBody {
  readonly success: true;
  readonly data: {
    readonly workspace_id: string;
  };
}

interface ParsedSseEvent {
  readonly id: string;
  readonly event: string;
  readonly data: unknown;
}

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

describe("security status routes", () => {
  it("returns the baseline security status for an existing workspace", async () => {
    const { app, eventLogRepo } = createTestContext();
    const workspace = await createWorkspace(app, "security-route");

    const response = await app.request(`/workspaces/${workspace.workspace_id}/security-status`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        workspace_id: workspace.workspace_id,
        posture: "baseline",
        zero_day_active: false,
        active_security_locks: 0,
        active_protections: []
      }
    });

    const events = await eventLogRepo.queryByEntity("workspace", workspace.workspace_id);
    expect(events.map((entry) => entry.event_type)).toEqual([
      "workspace.created",
      PhaseCEventType.SECURITY_PASSTHROUGH_STATUS_CHANGED
    ]);
  });

  it("does not re-emit the initialization posture when the workspace is loaded again", async () => {
    const { app, eventLogRepo } = createTestContext();
    const workspace = await createWorkspace(app, "security-route-idempotent");

    const getResponse = await app.request(`/workspaces/${workspace.workspace_id}`);
    expect(getResponse.status).toBe(200);

    const routeResponse = await app.request(`/workspaces/${workspace.workspace_id}/security-status`);
    expect(routeResponse.status).toBe(200);

    const events = await eventLogRepo.queryByEntity("workspace", workspace.workspace_id);
    expect(events.map((entry) => entry.event_type)).toEqual([
      "workspace.created",
      PhaseCEventType.SECURITY_PASSTHROUGH_STATUS_CHANGED
    ]);
  });

  it("preserves delegated workspace update methods on the secured wrapper", async () => {
    const { workspaceService } = createTestContext();
    const workspace = await workspaceService.create({
      name: "security-route-engine-class",
      root_path: "/tmp/security-route-engine-class",
      workspace_kind: WorkspaceKind.LOCAL_REPO
    });

    const updated = await workspaceService.updateDefaultEngineClass(
      workspace.workspace_id,
      "conversation_engine"
    );

    expect(updated.default_engine_class).toBe("conversation_engine");
  });

  it("broadcasts posture changes over workspace SSE when zero-day policy reevaluation observes a new status", async () => {
    const { app, sseManager, setPolicies, reevaluateWorkspaceSecurity } = createTestContext();
    const workspace = await createWorkspace(app, "security-route-sse");

    const response = await app.request(`/workspaces/${workspace.workspace_id}/events`);
    expect(response.status).toBe(200);

    const stream = createSseClient(response);
    await waitForCondition(() => sseManager.connectionCount(undefined, workspace.workspace_id) === 1);

    const connected = await stream.readEvent();
    expect(connected.event).toBe("connected");

    setPolicies([
      ZeroDayPolicySchema.parse({
        policy_id: "policy-hard-stop",
        kind: "hard_stop",
        target: "operator-stop",
        reason: "lock everything down",
        effective_at: "2026-04-15T00:00:00.000Z",
        expires_at: null
      })
    ]);

    await reevaluateWorkspaceSecurity(workspace.workspace_id);

    const event = await stream.readEvent();
    expect(event.event).toBe(PhaseCEventType.SECURITY_PASSTHROUGH_STATUS_CHANGED);
    expect(event.data).toMatchObject({
      workspace_id: workspace.workspace_id,
      posture: "locked_down",
      active_security_locks: 1,
      reason: "worker.baseline_evaluated"
    });

    const statusResponse = await app.request(`/workspaces/${workspace.workspace_id}/security-status`);
    expect(statusResponse.status).toBe(200);
    await expect(statusResponse.json()).resolves.toMatchObject({
      success: true,
      data: {
        workspace_id: workspace.workspace_id,
        posture: "locked_down",
        active_security_locks: 1
      }
    });

    await stream.close();
    await waitForCondition(() => sseManager.connectionCount(undefined, workspace.workspace_id) === 0);
  });

  it("real bootstrap wiring delivers the initialization event during workspace SSE connection setup", async () => {
    const { app, eventLogRepo, sseManager, createUnsecuredWorkspace } = createTestContext();
    const workspace = await createUnsecuredWorkspace("security-route-connect-race");

    const response = await app.request(`/workspaces/${workspace.workspace_id}/events`);
    expect(response.status).toBe(200);

    const stream = createSseClient(response);
    await waitForCondition(() => sseManager.connectionCount(undefined, workspace.workspace_id) === 1);

    const connected = await stream.readEvent();
    expect(connected.event).toBe("connected");

    const statusChanged = await stream.readEvent();
    expect(statusChanged.event).toBe(PhaseCEventType.SECURITY_PASSTHROUGH_STATUS_CHANGED);
    expect(statusChanged.data).toMatchObject({
      workspace_id: workspace.workspace_id,
      posture: "baseline",
      active_security_locks: 0,
      reason: "workspace_initialized"
    });

    const events = await eventLogRepo.queryByEntity("workspace", workspace.workspace_id);
    expect(events.map((entry) => entry.event_type)).toEqual([
      "workspace.created",
      PhaseCEventType.SECURITY_PASSTHROUGH_STATUS_CHANGED
    ]);

    await stream.close();
    await waitForCondition(() => sseManager.connectionCount(undefined, workspace.workspace_id) === 0);
  });

  it("delivers initialization failure diagnostics during workspace SSE connection setup", async () => {
    const { app, sseManager, createUnsecuredWorkspace } = createTestContext({
      failWorkspaceSecurityInitialize: true
    });
    const workspace = await createUnsecuredWorkspace("security-route-connect-failure");

    const response = await app.request(`/workspaces/${workspace.workspace_id}/events`);
    expect(response.status).toBe(200);

    const stream = createSseClient(response);
    await waitForCondition(() => sseManager.connectionCount(undefined, workspace.workspace_id) === 1);

    const connected = await stream.readEvent();
    expect(connected.event).toBe("connected");

    const initializationFailed = await stream.readEvent();
    expect(initializationFailed.event).toBe(
      PhaseCEventType.SECURITY_PASSTHROUGH_INITIALIZATION_FAILED
    );
    expect(initializationFailed.data).toMatchObject({
      workspace_id: workspace.workspace_id,
      operation: "get_by_id",
      reason: "simulated-security-initialize-failure",
      error_code: "Error"
    });

    await stream.close();
    await waitForCondition(() => sseManager.connectionCount(undefined, workspace.workspace_id) === 0);
  });

  it("returns 404 for a missing workspace", async () => {
    const { app } = createTestContext();

    const response = await app.request("/workspaces/ws_missing/security-status");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Resource not found"
    });
  });

  it("keeps workspace creation successful and records a bootstrap failure witness when security initialization fails", async () => {
    const { app, database, eventLogRepo } = createTestContext({
      failWorkspaceSecurityInitialize: true
    });

    const response = await app.request("/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "security-init-failure",
        root_path: "/tmp/security-init-failure",
        workspace_kind: WorkspaceKind.LOCAL_REPO
      })
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        workspace_id: expect.any(String)
      }
    });
    expect(
      (database.connection.prepare("SELECT COUNT(*) AS count FROM workspaces").get() as {
        readonly count: number;
      }).count
    ).toBe(1);
    await expect(eventLogRepo.queryByType("workspace.created")).resolves.toHaveLength(1);
    await expect(eventLogRepo.queryByType("workspace.deleted")).resolves.toEqual([]);
    await expect(
      eventLogRepo.queryByType(PhaseCEventType.SECURITY_PASSTHROUGH_STATUS_CHANGED)
    ).resolves.toEqual([]);
    await expect(
      eventLogRepo.queryByType(PhaseCEventType.SECURITY_PASSTHROUGH_INITIALIZATION_FAILED)
    ).resolves.toEqual([
      expect.objectContaining({
        payload_json: expect.objectContaining({
          operation: "create",
          reason: "simulated-security-initialize-failure",
          error_code: "Error"
        })
      })
    ]);
  });

  it("prefers runtime error codes over generic constructor names in bootstrap failure witnesses", async () => {
    const { app, eventLogRepo, createUnsecuredWorkspace } = createTestContext({
      failWorkspaceSecurityInitialize: true,
      failWorkspaceSecurityInitializeCode: "ENOENT"
    });
    const workspace = await createUnsecuredWorkspace("security-init-coded-failure");

    const response = await app.request(`/workspaces/${workspace.workspace_id}`);

    expect(response.status).toBe(200);
    await expect(
      eventLogRepo.queryByType(PhaseCEventType.SECURITY_PASSTHROUGH_INITIALIZATION_FAILED)
    ).resolves.toEqual([
      expect.objectContaining({
        payload_json: expect.objectContaining({
          operation: "get_by_id",
          reason: "simulated-security-initialize-failure",
          error_code: "ENOENT"
        })
      })
    ]);
  });

  it("keeps getById non-fatal and records a bootstrap failure witness when initialization fails on read", async () => {
    const { app, eventLogRepo, createUnsecuredWorkspace } = createTestContext({
      failWorkspaceSecurityInitialize: true
    });
    const workspace = await createUnsecuredWorkspace("security-init-get-failure");

    const response = await app.request(`/workspaces/${workspace.workspace_id}`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        workspace_id: workspace.workspace_id
      }
    });
    await expect(
      eventLogRepo.queryByType(PhaseCEventType.SECURITY_PASSTHROUGH_INITIALIZATION_FAILED)
    ).resolves.toEqual([
      expect.objectContaining({
        payload_json: expect.objectContaining({
          operation: "get_by_id",
          reason: "simulated-security-initialize-failure",
          error_code: "Error"
        })
      })
    ]);
  });

  it("keeps list non-fatal and records bootstrap failure witnesses when initialization fails on listing", async () => {
    const { app, eventLogRepo, createUnsecuredWorkspace } = createTestContext({
      failWorkspaceSecurityInitialize: true
    });
    await createUnsecuredWorkspace("security-init-list-failure");

    const response = await app.request("/workspaces");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true
    });
    await expect(
      eventLogRepo.queryByType(PhaseCEventType.SECURITY_PASSTHROUGH_INITIALIZATION_FAILED)
    ).resolves.toEqual([
      expect.objectContaining({
        payload_json: expect.objectContaining({
          operation: "list",
          reason: "simulated-security-initialize-failure",
          error_code: "Error"
        })
      })
    ]);
  });
});

function createTestContext(options: CreateTestContextOptions = {}): TestContext {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);

  const workspaceRepo = new SqliteWorkspaceRepo(database);
  const runRepo = new SqliteRunRepo(database);
  const bindingRepo = new SqliteEngineBindingRepo(database);
  const eventLogRepo = new SqliteEventLogRepo(database);
  const sseManager = new SseManager(eventLogRepo);

  let policies: readonly ZeroDayPolicy[] = [];
  let now = "2026-04-15T08:00:00.000Z";
  const baseZeroDayLayer = new ZeroDaySecurityLayer({
    loadPolicies: async () => policies,
    now: () => now,
    policyEvaluationCacheTtlMs: 50
  });
  const zeroDayLayer = options.failWorkspaceSecurityInitialize
    ? {
        getSecurityStatus: async (workspaceId: string) =>
          await baseZeroDayLayer.getSecurityStatus(workspaceId),
        initializeWorkspaceSecurity: async () => {
          const error = new Error("simulated-security-initialize-failure") as Error & {
            code?: string;
          };
          error.code = options.failWorkspaceSecurityInitializeCode;
          throw error;
        },
        subscribeStatusEvaluations: (observer: Parameters<
          ZeroDaySecurityLayer["subscribeStatusEvaluations"]
        >[0]) => baseZeroDayLayer.subscribeStatusEvaluations(observer)
      }
    : baseZeroDayLayer;
  const {
    eventPublisher,
    runHotStateService,
    rawWorkspaceService,
    securityStatusService,
    workspaceService: securedWorkspaceService
  } = createSecurityStatusBootstrapServices({
    workspaceRepo,
    runRepo,
    eventLogRepo,
    sseBroadcaster: sseManager,
    zeroDayLayer
  });
  const runService = new RunService({
    workspaceRepo,
    runRepo,
    bindingRepo,
    eventPublisher,
    isPrincipalCodingEngineAvailable: () => false
  });

  return {
    app: createApp({
      workspaceService: securedWorkspaceService,
      securityStatusService,
      runService,
      conversationService: createNoopConversationService("security status tests") as any,
      engineBindingService: createStubEngineBindingService() as any,
      runHotStateService,
      sseManager,
      signalService: createUnusedSignalService("security status tests") as any,
      evidenceService: createUnusedEvidenceService("security status tests") as any,
      memoryService: createUnusedMemoryService("security status tests") as any,
      slotService: createUnusedSlotService("security status tests") as any,
      surfaceService: createUnusedSurfaceService("security status tests") as any,
      synthesisService: createUnusedSynthesisService("security status tests") as any,
      claimService: createUnusedClaimService("security status tests") as any,
      proposalService: createUnusedProposalService("security status tests") as any
    }),
    database,
    eventLogRepo,
    sseManager,
    workspaceService: securedWorkspaceService,
    createUnsecuredWorkspace: async (name) => {
      const workspace = await rawWorkspaceService.create({
        name,
        root_path: `/tmp/${name}`,
        workspace_kind: WorkspaceKind.LOCAL_REPO
      });

      return {
        workspace_id: workspace.workspace_id
      };
    },
    reevaluateWorkspaceSecurity: async (workspaceId) => {
      now = "2026-04-15T08:00:00.051Z";
      await zeroDayLayer.augmentLock(
        WorkerBaselineLockSchema.parse({
          lock_id: `lock-${workspaceId}`,
          workspace_id: workspaceId,
          hard_constraint_refs: [],
          denied_tool_categories: [],
          hazard_object_refs: [],
          hard_stop_refs: [],
          assembled_at: "2026-04-15T08:00:00.000Z"
        })
      );
    },
    setPolicies: (nextPolicies) => {
      policies = nextPolicies;
    }
  };
}

async function createWorkspace(
  app: ReturnType<typeof createApp>,
  name: string
): Promise<WorkspaceResponseBody["data"]> {
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
  const body = (await response.json()) as WorkspaceResponseBody;
  return body.data;
}

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

async function readWithTimeout<T>(
  reader: ReadableStreamDefaultReader<T>,
  timeoutMs: number
): Promise<ReadableStreamReadResult<T>> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`Timed out waiting for SSE event after ${timeoutMs}ms`));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

function parseSseFrame(frame: string): ParsedSseEvent {
  const id = frame
    .split("\n")
    .find((line) => line.startsWith("id:"))
    ?.slice(3)
    .trim();
  const event = frame
    .split("\n")
    .find((line) => line.startsWith("event:"))
    ?.slice(6)
    .trim();
  const dataLine = frame
    .split("\n")
    .find((line) => line.startsWith("data:"))
    ?.slice(5)
    .trim();

  if (id === undefined || event === undefined || dataLine === undefined) {
    throw new Error(`Malformed SSE frame: ${frame}`);
  }

  return {
    id,
    event,
    data: JSON.parse(dataLine) as unknown
  };
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now();

  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for condition after ${timeoutMs}ms`);
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
