import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { CoreError } from "@do-soul/alaya-core";
import { registerRunRoutes } from "../../routes/runs.js";
import { registerSignalRoutes } from "../../routes/signals.js";
import { registerWorkspaceRoutes } from "../../routes/workspaces.js";
import { registerErrorHandler } from "../../middleware/error-handler.js";
import {
  runRouteServices,
  signalRouteServices,
  workspaceRouteServices
} from "../support/route-service-stubs.js";

describe("route list pagination", () => {
  it("paginates GET /workspaces/:id/runs", async () => {
    const app = new Hono();
    registerRunRoutes(app, runRouteServices({
      runService: {
        create: vi.fn(),
        listByWorkspace: vi.fn(async (_workspaceId, page) => {
          expect(page).toEqual({ limit: 1, offset: 2 });
          return [{ run_id: "r3" }];
        }),
        countByWorkspace: vi.fn(async () => 3),
        getById: vi.fn()
      },
      conversationService: {},
      runHotStateService: {}
    }));

    const response = await app.request("/workspaces/ws-1/runs?limit=1&offset=2");

    expect(response.status).toBe(200);
    expect(response.headers.get("x-total-count")).toBe("3");
    expect(response.headers.get("x-limit")).toBe("1");
    expect(response.headers.get("x-offset")).toBe("2");
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: [{ run_id: "r3" }]
    });
  });

  it("rejects excessive list offsets before calling the route service", async () => {
    const app = new Hono();
    const listByWorkspace = vi.fn();
    registerErrorHandler(app, { error: vi.fn() });
    registerRunRoutes(app, runRouteServices({
      runService: {
        create: vi.fn(),
        listByWorkspace,
        countByWorkspace: vi.fn(),
        getById: vi.fn()
      },
      conversationService: {},
      runHotStateService: {}
    }));

    const response = await app.request("/workspaces/ws-1/runs?offset=1000001");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Invalid request"
    });
    expect(listByWorkspace).not.toHaveBeenCalled();
  });

  it("rejects PATCH /runs/:id scalar JSON before calling the run service", async () => {
    const app = new Hono();
    const rename = vi.fn();
    registerErrorHandler(app, { error: vi.fn() });
    registerRunRoutes(app, runRouteServices({
      runService: {
        create: vi.fn(),
        listByWorkspace: vi.fn(),
        getById: vi.fn(),
        rename
      },
      conversationService: {},
      runHotStateService: {}
    }));

    const response = await app.request("/runs/run-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "null"
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Invalid request body"
    });
    expect(rename).not.toHaveBeenCalled();
  });

  it("paginates GET /runs/:id/messages", async () => {
    const app = new Hono();
    registerRunRoutes(app, runRouteServices({
      runService: {
        create: vi.fn(),
        listByWorkspace: vi.fn(),
        countByWorkspace: vi.fn(),
        getById: vi.fn(async () => ({ run_id: "run-1", workspace_id: "ws-1" }))
      },
      workspaceService: { getById: vi.fn(async () => ({ workspace_id: "ws-1" })) },
      conversationService: {
        listMessages: vi.fn(async (_runId, page) => {
          expect(page).toEqual({ limit: 1, offset: 1 });
          return [{ message_id: "m2" }];
        }),
        countMessages: vi.fn(async () => 2)
      },
      runHotStateService: {}
    }));

    const response = await app.request("/runs/run-1/messages?limit=1&offset=1");

    expect(response.status).toBe(200);
    expect(response.headers.get("x-total-count")).toBe("2");
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: [{ message_id: "m2" }]
    });
  });

  it("paginates GET /runs/:id/signals", async () => {
    const app = new Hono();
    registerSignalRoutes(app, signalRouteServices({
      runService: { getById: vi.fn(async () => ({ run_id: "run-1" })) },
      signalService: {
        listByRun: vi.fn(async (_runId, page) => {
          expect(page).toEqual({ limit: 2, offset: 1 });
          return [{ signal_id: "s2" }, { signal_id: "s3" }];
        }),
        countByRun: vi.fn(async () => 3)
      }
    }));

    const response = await app.request("/runs/run-1/signals?limit=2&offset=1");

    expect(response.status).toBe(200);
    expect(response.headers.get("x-total-count")).toBe("3");
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: [{ signal_id: "s2" }, { signal_id: "s3" }]
    });
  });

  it("paginates GET /workspaces", async () => {
    const app = new Hono();
    registerWorkspaceRoutes(app, workspaceRouteServices({
      workspaceService: {
        create: vi.fn(),
        list: vi.fn(async (page) => {
          expect(page).toEqual({ limit: 2, offset: 1 });
          return [
            { workspace_id: "ws-2", repo_path: null },
            { workspace_id: "ws-3", repo_path: null }
          ];
        }),
        count: vi.fn(async () => 3),
        getById: vi.fn()
      }
    }));

    const response = await app.request("/workspaces?limit=2&offset=1");

    expect(response.status).toBe(200);
    expect(response.headers.get("x-total-count")).toBe("3");
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: [
        { workspace_id: "ws-2", repo_path: null },
        { workspace_id: "ws-3", repo_path: null }
      ]
    });
  });
});

describe("run route workspace isolation", () => {
  it("rejects GET /runs/:id when the run workspace is not accessible", async () => {
    const app = new Hono();
    const getById = vi.fn(async () => ({ run_id: "run-foreign", workspace_id: "ws-foreign" }));
    const services = createRunIsolationServices({
      runService: { getById }
    });
    registerErrorHandler(app, { error: vi.fn() });
    registerRunRoutes(app, services);

    const response = await app.request("/runs/run-foreign");

    expect(response.status).toBe(404);
    expect(getById).toHaveBeenCalledTimes(1);
    expect(services.workspaceService.getById).toHaveBeenCalledWith("ws-foreign");
  });

  it("rejects PATCH /runs/:id before rename when the run workspace is not accessible", async () => {
    const app = new Hono();
    const rename = vi.fn();
    const services = createRunIsolationServices({
      runService: {
        getById: vi.fn(async () => ({ run_id: "run-foreign", workspace_id: "ws-foreign" })),
        rename
      }
    });
    registerErrorHandler(app, { error: vi.fn() });
    registerRunRoutes(app, services);

    const response = await app.request("/runs/run-foreign", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Renamed" })
    });

    expect(response.status).toBe(404);
    expect(rename).not.toHaveBeenCalled();
    expect(services.workspaceService.getById).toHaveBeenCalledWith("ws-foreign");
  });

  it("rejects POST /runs/:id/messages/stream before streaming when the run workspace is not accessible", async () => {
    const app = new Hono();
    const sendMessageStreaming = vi.fn();
    const services = createRunIsolationServices({
      runService: {
        getById: vi.fn(async () => ({ run_id: "run-foreign", workspace_id: "ws-foreign" }))
      },
      conversationService: { sendMessageStreaming }
    });
    registerErrorHandler(app, { error: vi.fn() });
    registerRunRoutes(app, services);

    const response = await app.request("/runs/run-foreign/messages/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "hello" })
    });

    expect(response.status).toBe(404);
    expect(sendMessageStreaming).not.toHaveBeenCalled();
    expect(services.workspaceService.getById).toHaveBeenCalledWith("ws-foreign");
  });
});

function createRunIsolationServices(overrides: {
  readonly runService?: Record<string, unknown>;
  readonly conversationService?: Record<string, unknown>;
} = {}) {
  return runRouteServices({
    runService: {
      create: vi.fn(),
      listByWorkspace: vi.fn(),
      countByWorkspace: vi.fn(),
      getById: vi.fn(async () => ({ run_id: "run-foreign", workspace_id: "ws-foreign" })),
      ...overrides.runService
    },
    workspaceService: {
      getById: vi.fn(async () => {
        throw new CoreError("NOT_FOUND", "workspace not found");
      })
    },
    conversationService: {
      listMessages: vi.fn(),
      countMessages: vi.fn(),
      sendMessage: vi.fn(),
      sendMessageStreaming: vi.fn(),
      ...overrides.conversationService
    },
    runHotStateService: {}
  });
}
