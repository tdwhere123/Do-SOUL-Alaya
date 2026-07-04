import { describe, expect, it, vi } from "vitest";
import {
  CORRELATION_ID_HEADER,
  createApp,
  MAX_REQUEST_BODY_BYTES,
  REQUEST_ID_HEADER,
  type CoreDaemonLifecycleState,
  type CoreDaemonServices
} from "../../runtime/app.js";
import { createRequestProtection } from "../../runtime/daemon-runtime-support.js";
import { appConfigServiceStub } from "../support/app-config-service-stub.js";
import {
  configRouteServices,
  conflictMatrixRouteServices
} from "../support/route-service-stubs.js";

const testRequestProtection = {
  allowedOrigin: "http://localhost",
  requestToken: "test-token"
} as const;

function createProtectedTestApp(
  services: CoreDaemonServices = {},
  lifecycle?: CoreDaemonLifecycleState
) {
  return createApp(
    {
      ...services,
      requestProtection: services.requestProtection ?? testRequestProtection
    },
    lifecycle
  );
}

function withTestAuthHeaders(headers: Record<string, string> = {}): Record<string, string> {
  return {
    "x-request-token": testRequestProtection.requestToken,
    "x-alaya-desktop": "1",
    ...headers
  };
}

describe("createApp", () => {
  it("rejects unprotected routes when request protection is not configured", async () => {
    const app = createApp();

    const response = await app.request("/unknown", {
      headers: {
        "x-alaya-desktop": "1"
      }
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Request protection is not configured"
    });
  });

  it("requires a timing-safe request token for protected routes", async () => {
    const app = createApp({
      requestProtection: {
        allowedOrigin: "http://localhost:5173",
        requestToken: "secret-token"
      }
    });

    const missing = await app.request("/unknown", {
      method: "POST",
      headers: {
        origin: "http://localhost:5173"
      }
    });
    expect(missing.status).toBe(403);
    await expect(missing.json()).resolves.toEqual({
      success: false,
      error: "X-Request-Token is required"
    });

    const wrong = await app.request("/unknown", {
      method: "POST",
      headers: {
        origin: "http://localhost:5173",
        "x-request-token": "wrong-token"
      }
    });
    expect(wrong.status).toBe(403);
    await expect(wrong.json()).resolves.toEqual({
      success: false,
      error: "Invalid X-Request-Token"
    });

    // A wrong-length token is rejected via the length-independent constant-time
    // compare rather than an early length-based return.
    const wrongLength = await app.request("/unknown", {
      method: "POST",
      headers: {
        origin: "http://localhost:5173",
        "x-request-token": "secret-token-with-extra-length"
      }
    });
    expect(wrongLength.status).toBe(403);
    await expect(wrongLength.json()).resolves.toEqual({
      success: false,
      error: "Invalid X-Request-Token"
    });
  });

  it("requires a request token for non-health GET routes", async () => {
    const app = createApp({
      requestProtection: {
        allowedOrigin: "http://localhost:5173",
        requestToken: "secret-token"
      }
    });

    const missing = await app.request("/unknown", {
      headers: {
        origin: "http://localhost:5173"
      }
    });

    expect(missing.status).toBe(403);
    await expect(missing.json()).resolves.toEqual({
      success: false,
      error: "X-Request-Token is required"
    });

    const authenticated = await app.request("/unknown", {
      headers: {
        "x-request-token": "secret-token",
        "x-alaya-desktop": "1"
      }
    });

    expect(authenticated.status).toBe(404);
  });

  it("propagates request and correlation ids on authenticated responses", async () => {
    const app = createApp({
      requestProtection: {
        allowedOrigin: "http://localhost:5173",
        requestToken: "secret-token"
      }
    });

    const response = await app.request("/unknown", {
      headers: {
        "x-request-token": "secret-token",
        "x-alaya-desktop": "1",
        "x-request-id": "req-123"
      }
    });

    expect(response.status).toBe(404);
    expect(response.headers.get(REQUEST_ID_HEADER)).toBe("req-123");
    expect(response.headers.get(CORRELATION_ID_HEADER)).toBe("req-123");
  });

  it("accepts trimmed allowed-origin values after startup normalization", async () => {
    const app = createApp({
      requestProtection: createRequestProtection({
        ALLOWED_ORIGIN: " http://localhost:5173 ",
        ALAYA_REQUEST_TOKEN: "secret-token"
      })
    });

    const response = await app.request("/unknown", {
      headers: {
        origin: "http://localhost:5173",
        "x-request-token": "secret-token"
      }
    });

    expect(response.status).toBe(404);
  });

  it("serves an unauthenticated liveness probe at GET /health", async () => {
    const app = createApp({
      requestProtection: {
        allowedOrigin: "http://localhost:5173",
        requestToken: "secret-token"
      }
    });

    const response = await app.request("/health");

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(body.service).toBe("alaya-core-daemon");
    expect(typeof body.version).toBe("string");
    expect(typeof body.uptime_s).toBe("number");
  });

  it("keeps liveness green while the daemon is draining", async () => {
    const drainState = { isDraining: true };
    const app = createApp({}, { drainState, inFlight: { count: 0 } });

    const response = await app.request("/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "ok" });
  });

  it("registers typed route service bags on the Hono app", async () => {
    const patchRuntimeEmbeddingConfig = vi.fn(
      async (patch: unknown): Promise<Readonly<{
        config_version: 1;
        embedding_enabled: boolean;
        model_id: string | null;
        provider_url: string | null;
        secret_ref: string | null;
      }>> => ({
        config_version: 1,
        embedding_enabled: false,
        model_id: null,
        provider_url: null,
        secret_ref: null,
        ...(patch as {
          embedding_enabled?: boolean;
          model_id?: string | null;
          provider_url?: string | null;
          secret_ref?: string | null;
        })
      })
    );
    const app = createProtectedTestApp({
      routes: {
        config: configRouteServices({
          configService: appConfigServiceStub({
            patchRuntimeEmbeddingConfig
          })
        })
      }
    });

    const response = await app.request("/config/runtime/embedding-supplement", {
      method: "PATCH",
      headers: withTestAuthHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ embedding_enabled: true })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        config_version: 1,
        embedding_enabled: true,
        model_id: null,
        provider_url: null,
        secret_ref: null
      },
      requires_daemon_restart: true
    });
    expect(patchRuntimeEmbeddingConfig).toHaveBeenCalledWith({ embedding_enabled: true });
  });

  it("rejects non-object config patch bodies before dispatching to the config service", async () => {
    const patchManifestationBudgetConfig = vi.fn(async (patch: unknown) => patch);
    const app = createProtectedTestApp({
      routes: {
        config: configRouteServices({
          workspaceService: {
            getById: vi.fn(async () => ({ workspace_id: "workspace-1" }))
          },
          configService: appConfigServiceStub({
            patchManifestationBudgetConfig
          })
        })
      }
    });

    const response = await app.request("/workspaces/workspace-1/config/manifestation-budget", {
      method: "PATCH",
      headers: withTestAuthHeaders({ "content-type": "application/json" }),
      body: JSON.stringify([])
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Config patch body must be a JSON object"
    });
    expect(patchManifestationBudgetConfig).not.toHaveBeenCalled();
  });

  it("rejects oversized non-file mutation bodies", async () => {
    const patchRuntimeEmbeddingConfig = vi.fn(async () => ({
      embedding_enabled: true,
      model_id: "text-embedding-3-small",
      provider_url: null,
      secret_ref: null
    }));
    const app = createProtectedTestApp({
      routes: {
        config: configRouteServices({
          configService: appConfigServiceStub({
            patchRuntimeEmbeddingConfig
          })
        })
      }
    });
    const response = await app.request(
      createChunkedJsonRequest(
        "http://localhost/config/runtime/embedding-supplement",
        "PATCH",
        JSON.stringify({ payload: "x".repeat(MAX_REQUEST_BODY_BYTES) }),
        withTestAuthHeaders()
      )
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Request body exceeds the 10 MB limit"
    });
    expect(patchRuntimeEmbeddingConfig).not.toHaveBeenCalled();
    expect(response.headers.get(REQUEST_ID_HEADER)).toBeTruthy();
  });

  it("rejects chunked oversized DELETE bodies before route dispatch", async () => {
    const deleteEdge = vi.fn(async () => undefined);
    const app = createProtectedTestApp({
      routes: {
        conflictMatrix: conflictMatrixRouteServices({
          workspaceService: {
            getById: vi.fn(async () => ({ workspace_id: "ws-1" }))
          },
          arbitrationService: {
            deleteEdge,
            createEdge: vi.fn(),
            listEdgesByWorkspace: vi.fn(),
            rebuildConflictMatrix: vi.fn()
          }
        })
      }
    });

    const response = await app.request(
      createChunkedJsonRequest(
        "http://localhost/workspaces/ws-1/conflict-matrix-edges/edge-1",
        "DELETE",
        JSON.stringify({ payload: "x".repeat(MAX_REQUEST_BODY_BYTES) }),
        withTestAuthHeaders()
      )
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Request body exceeds the 10 MB limit"
    });
    expect(deleteEdge).not.toHaveBeenCalled();
  });

  it("rejects unexpected small DELETE bodies before route dispatch", async () => {
    const deleteEdge = vi.fn(async () => undefined);
    const app = createProtectedTestApp({
      routes: {
        conflictMatrix: conflictMatrixRouteServices({
          workspaceService: {
            getById: vi.fn(async () => ({ workspace_id: "ws-1" }))
          },
          arbitrationService: {
            deleteEdge,
            createEdge: vi.fn(),
            listEdgesByWorkspace: vi.fn(),
            rebuildConflictMatrix: vi.fn()
          }
        })
      }
    });

    const response = await app.request(
      createChunkedJsonRequest(
        "http://localhost/workspaces/ws-1/conflict-matrix-edges/edge-1",
        "DELETE",
        JSON.stringify({ payload: "x" }),
        withTestAuthHeaders()
      )
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Request body is not allowed for this route"
    });
    expect(deleteEdge).not.toHaveBeenCalled();
  });

  it("rejects streaming DELETE bodies without waiting for EOF", async () => {
    const deleteEdge = vi.fn(async () => undefined);
    const app = createProtectedTestApp({
      routes: {
        conflictMatrix: conflictMatrixRouteServices({
          workspaceService: {
            getById: vi.fn(async () => ({ workspace_id: "ws-1" }))
          },
          arbitrationService: {
            deleteEdge,
            createEdge: vi.fn(),
            listEdgesByWorkspace: vi.fn(),
            rebuildConflictMatrix: vi.fn()
          }
        })
      }
    });

    const response = await withResponseTimeout(
      app.request(
        createNeverEndingChunkedJsonRequest(
          "http://localhost/workspaces/ws-1/conflict-matrix-edges/edge-1",
          "DELETE",
          JSON.stringify({ payload: "x" }),
          withTestAuthHeaders()
        )
      )
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Request body is not allowed for this route"
    });
    expect(deleteEdge).not.toHaveBeenCalled();
  });

  it("treats an empty attached DELETE stream as no body and dispatches the route", async () => {
    const deleteEdge = vi.fn(async () => undefined);
    const app = createProtectedTestApp({
      routes: {
        conflictMatrix: conflictMatrixRouteServices({
          workspaceService: {
            getById: vi.fn(async () => ({ workspace_id: "ws-1" }))
          },
          arbitrationService: {
            deleteEdge,
            createEdge: vi.fn(),
            listEdgesByWorkspace: vi.fn(),
            rebuildConflictMatrix: vi.fn()
          }
        })
      }
    });

    const response = await app.request(
      createEmptyChunkedJsonRequest(
        "http://localhost/workspaces/ws-1/conflict-matrix-edges/edge-1",
        "DELETE",
        withTestAuthHeaders()
      )
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true, data: null });
    expect(deleteEdge).toHaveBeenCalledWith("edge-1", "ws-1");
  });
});

function createChunkedJsonRequest(
  url: string,
  method: "PATCH" | "DELETE",
  bodyText: string,
  extraHeaders: Record<string, string> = {}
): Request {
  const bytes = new TextEncoder().encode(bodyText);
  let sent = false;

  return new Request(url, {
    method,
    headers: {
      "content-type": "application/json",
      ...extraHeaders
    },
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) {
          controller.close();
          return;
        }
        sent = true;
        controller.enqueue(bytes);
        controller.close();
      }
    }),
    duplex: "half"
  });
}

function createNeverEndingChunkedJsonRequest(
  url: string,
  method: "PATCH" | "DELETE",
  bodyText: string,
  extraHeaders: Record<string, string> = {}
): Request {
  const bytes = new TextEncoder().encode(bodyText);
  let sent = false;

  return new Request(url, {
    method,
    headers: {
      "content-type": "application/json",
      ...extraHeaders
    },
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) {
          return;
        }
        sent = true;
        controller.enqueue(bytes);
      }
    }),
    duplex: "half"
  });
}

function createEmptyChunkedJsonRequest(
  url: string,
  method: "PATCH" | "DELETE",
  extraHeaders: Record<string, string> = {}
): Request {
  return new Request(url, {
    method,
    headers: {
      "content-type": "application/json",
      ...extraHeaders
    },
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.close();
      }
    }),
    duplex: "half"
  });
}

async function withResponseTimeout(
  responsePromise: Response | Promise<Response>,
  timeoutMs = 200
): Promise<Response> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      responsePromise,
      new Promise<Response>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`response timed out after ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
