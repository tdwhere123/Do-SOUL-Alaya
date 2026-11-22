import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import {
  EventPublisher,
  WorkspaceService
} from "@do-soul/alaya-core";
import { WorkspaceKind, WorkspaceState } from "@do-soul/alaya-protocol";
import {
  initDatabase,
  SqliteEventLogRepo,
  SqliteRunRepo,
  SqliteWorkspaceRepo
} from "@do-soul/alaya-storage";
import { registerWorkspaceRoutes, type WorkspaceRouteServices } from "../../routes/workspace/workspaces.js";
import { createApp } from "../../runtime/app.js";
import { routeServices } from "../support/route-service-stubs.js";

const PROCESS_TOKEN = "process-all-token";
const MULTI_WS_TOKEN = "multi-ws-token";
const SINGLE_WS_TOKEN = "single-ws-token";
const EMPTY_WS_TOKEN = "empty-ws-token";
const WHITESPACE_WS_TOKEN = "whitespace-ws-token";

const databases = new Set<ReturnType<typeof initDatabase>>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }
  databases.clear();
});

function headersFor(token: string): Record<string, string> {
  return {
    "x-request-token": token,
    "x-alaya-desktop": "1"
  };
}

function createWorkspaceListApp() {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);
  const workspaceRepo = new SqliteWorkspaceRepo(database);
  const runRepo = new SqliteRunRepo(database);
  const eventLogRepo = new SqliteEventLogRepo(database);
  const eventPublisher = new EventPublisher({
    eventLogRepo,
    runHotStateService: { apply: () => undefined },
    runtimeNotifier: { notify: () => undefined, notifyEntry: () => undefined }
  });
  const workspaceService = new WorkspaceService({
    workspaceRepo,
    runRepo,
    eventPublisher
  });

  for (const workspaceId of ["ws-1", "ws-2", "ws-3", "ws-4", "ws-5"]) {
    workspaceRepo.create({
      workspace_id: workspaceId,
      name: `Workspace ${workspaceId}`,
      root_path: `/tmp/secret-root/${workspaceId}`,
      workspace_kind: WorkspaceKind.DOCS_ONLY,
      repo_path: null,
      default_engine_binding: null,
      default_engine_class: null,
      workspace_state: WorkspaceState.ACTIVE
    });
  }

  const app = createApp({
    requestProtection: {
      allowedOrigin: "http://localhost:5173",
      requestToken: PROCESS_TOKEN,
      boundWorkspaceIds: "*",
      allowDesktopOriginlessRequests: true,
      workspaceTokens: [
        { token: MULTI_WS_TOKEN, workspaceIds: ["ws-1", "ws-3", "ws-4", "ws-5"] },
        { token: SINGLE_WS_TOKEN, workspaceIds: ["ws-3"] },
        { token: EMPTY_WS_TOKEN, workspaceIds: [] },
        { token: WHITESPACE_WS_TOKEN, workspaceIds: [" ws-3 "] }
      ]
    },
    routes: {
      workspaces: {
        workspaceService,
        engineBindingService: routeServices<WorkspaceRouteServices["engineBindingService"]>({}),
        codingEngineAvailable: false
      }
    }
  });

  return { app, database, workspaceService };
}

describe("GET /workspaces SQL-level RequestTokenGrant filtering", () => {
  it("paginates restricted multi-workspace grants in SQL before LIMIT/OFFSET", async () => {
    const { app } = createWorkspaceListApp();

    const response = await app.request("/workspaces?limit=2&offset=1", {
      headers: headersFor(MULTI_WS_TOKEN)
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-total-count")).toBe("4");
    expect(response.headers.get("x-limit")).toBe("2");
    expect(response.headers.get("x-offset")).toBe("1");
    const payload = (await response.json()) as {
      readonly success: boolean;
      readonly data: ReadonlyArray<{ readonly workspace_id: string; readonly root_path: string }>;
    };
    expect(payload.success).toBe(true);
    expect(payload.data.map((workspace) => workspace.workspace_id)).toEqual(["ws-3", "ws-4"]);
    expect(JSON.stringify(payload)).not.toContain("/tmp/secret-root/ws-2");
  });

  it("restricts single-workspace tokens to their single authorized workspace", async () => {
    const { app } = createWorkspaceListApp();

    const firstPage = await app.request("/workspaces?limit=10&offset=0", {
      headers: headersFor(SINGLE_WS_TOKEN)
    });
    expect(firstPage.status).toBe(200);
    expect(firstPage.headers.get("x-total-count")).toBe("1");
    const firstPayload = (await firstPage.json()) as {
      readonly data: ReadonlyArray<{ readonly workspace_id: string }>;
    };
    expect(firstPayload.data.map((workspace) => workspace.workspace_id)).toEqual(["ws-3"]);

    const secondPage = await app.request("/workspaces?limit=10&offset=1", {
      headers: headersFor(SINGLE_WS_TOKEN)
    });
    expect(secondPage.status).toBe(200);
    expect(secondPage.headers.get("x-total-count")).toBe("1");
    await expect(secondPage.json()).resolves.toEqual({ success: true, data: [] });
  });

  it("returns an immediate empty page for an empty-grant token without scanning SQLite", async () => {
    const { app, database } = createWorkspaceListApp();
    const prepareSpy = vi.spyOn(database.connection, "prepare");

    const response = await app.request("/workspaces?limit=10&offset=0", {
      headers: headersFor(EMPTY_WS_TOKEN)
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-total-count")).toBe("0");
    await expect(response.json()).resolves.toEqual({ success: true, data: [] });
    expect(prepareSpy).not.toHaveBeenCalled();
  });

  it("allows unrestricted wildcard tokens to paginate across all workspaces", async () => {
    const { app } = createWorkspaceListApp();

    const response = await app.request("/workspaces?limit=3&offset=1", {
      headers: headersFor(PROCESS_TOKEN)
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-total-count")).toBe("5");
    const payload = (await response.json()) as {
      readonly data: ReadonlyArray<{ readonly workspace_id: string }>;
    };
    expect(payload.data.map((workspace) => workspace.workspace_id)).toEqual([
      "ws-2",
      "ws-3",
      "ws-4"
    ]);
  });

  it("matches workspaceIds strictly without trimming so list and getById stay aligned", async () => {
    const { app } = createWorkspaceListApp();

    const listResponse = await app.request("/workspaces?limit=10&offset=0", {
      headers: headersFor(WHITESPACE_WS_TOKEN)
    });
    expect(listResponse.status).toBe(200);
    expect(listResponse.headers.get("x-total-count")).toBe("0");
    await expect(listResponse.json()).resolves.toEqual({ success: true, data: [] });

    const getResponse = await app.request("/workspaces/ws-3", {
      headers: headersFor(WHITESPACE_WS_TOKEN)
    });
    expect(getResponse.status).toBe(403);
  });

  it("fails closed when GET /workspaces executes without a requestTokenGrant in context", async () => {
    const { workspaceService } = createWorkspaceListApp();
    const unauthenticatedApp = new Hono();
    registerWorkspaceRoutes(unauthenticatedApp, {
      workspaceService,
      engineBindingService: routeServices<WorkspaceRouteServices["engineBindingService"]>({}),
      codingEngineAvailable: false
    });

    const response = await unauthenticatedApp.request("/workspaces?limit=10&offset=0");
    expect(response.status).toBe(200);
    expect(response.headers.get("x-total-count")).toBe("0");
    await expect(response.json()).resolves.toEqual({ success: true, data: [] });
  });
});
