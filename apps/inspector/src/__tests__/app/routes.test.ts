import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createInspectorApp,
  INSPECTOR_ROUTE_SURFACE,
  MAX_INSPECTOR_REQUEST_BODY_BYTES
} from "../../runtime/app.js";

import {
  authenticatedRequest,
  createChunkedJsonRequest,
  createEmptyChunkedJsonRequest,
  createNeverEndingChunkedJsonRequest,
  withResponseTimeout
} from "./routes-test-utils.js";

describe("inspector routes", () => {
  it("pins the frozen backend route surface", () => {
    expect([...INSPECTOR_ROUTE_SURFACE]).toEqual([
      "GET /api/config/:workspaceId/soul",
      "PATCH /api/config/:workspaceId/soul",
      "GET /api/config/:workspaceId/strategy",
      "PATCH /api/config/:workspaceId/strategy",
      "GET /api/config/:workspaceId/environment",
      "PATCH /api/config/:workspaceId/environment",
      "GET /api/config/:workspaceId/embedding-supplement",
      "PATCH /api/config/runtime/embedding-supplement",
      "GET /api/config/:workspaceId/garden-compute",
      "PATCH /api/config/runtime/garden-compute",
      "GET /api/config/:workspaceId/manifestation-budget",
      "PATCH /api/config/:workspaceId/manifestation-budget",
      "GET /api/bench-summary",
      "GET /api/bench-trend",
      "GET /api/embedding-status/:workspaceId",
      "GET /api/graph/:workspaceId",
      "GET /api/workspaces/:workspaceId/health-inbox",
      "GET /api/memory-entries/:workspaceId",
      "GET /api/pointers/:workspaceId/:objectId",
      "GET /api/recall-stats/:workspaceId",
      "GET /api/status",
      // Inspector loopback routes share the attached-agent proposal review
      // workflow for pending-proposals listing plus accept/reject.
      "GET /api/proposals/:workspaceId/pending",
      "POST /api/proposals/:workspaceId/:proposalId/review",
      "POST /api/proposals/:workspaceId/memory/:memoryId/keep",
      "POST /api/proposals/:workspaceId/memory/:memoryId/rewrite",
      "POST /api/proposals/:workspaceId/memory/:memoryId/downgrade",
      "POST /api/proposals/:workspaceId/memory/:memoryId/retire",
      "POST /api/workspaces/:workspaceId/soul/memory/:memoryId/proposals/promote-strictly-governed",
      "POST /api/soul/search/:workspaceId"
    ]);
  });


  it("proxies config, graph, status, and embedding-supplement routes to daemon HTTP without importing daemon code", async () => {
    const calls: { url: string; method: string; body: string | null }[] = [];
    const app = createInspectorApp({
      token: "token",
      workspaceId: "ws1",
      daemonUrl: "http://daemon.local",
      staticRoot: await mkdtemp(path.join(tmpdir(), "inspector-static-")),
      fetchImpl: async (input, init) => {
        calls.push({
          url: String(input),
          method: init?.method ?? "GET",
          body: init?.body === undefined ? null : String(init.body)
        });
        return Response.json({ success: true, data: { ok: true } });
      }
    });

    await authenticatedRequest(app, "/api/config/ws1/soul");
    await authenticatedRequest(app, "/api/config/ws1/embedding-supplement");
    await authenticatedRequest(app, "/api/config/runtime/embedding-supplement", {
      method: "PATCH",
      body: JSON.stringify({
        secret_ref_mode: "paste",
        secret_value: "sk-test-plaintext-secret"
      }),
      headers: { "content-type": "application/json" }
    });
    await authenticatedRequest(app, "/api/config/ws1/garden-compute");
    await authenticatedRequest(app, "/api/config/runtime/garden-compute", {
      method: "PATCH",
      body: JSON.stringify({
        provider_kind: "official_api",
        secret_ref_mode: "env",
        secret_value: "ALAYA_OFFICIAL_GARDEN_API_KEY"
      }),
      headers: { "content-type": "application/json" }
    });
    await authenticatedRequest(app, "/api/config/ws1/manifestation-budget");
    await authenticatedRequest(app, "/api/config/ws1/manifestation-budget", {
      method: "PATCH",
      body: JSON.stringify({ stance_bias_cap: 8 }),
      headers: { "content-type": "application/json" }
    });
    await authenticatedRequest(app, "/api/config/ws1/strategy", {
      method: "PATCH",
      body: JSON.stringify({ auto_approve_readonly: true }),
      headers: { "content-type": "application/json" }
    });
    await authenticatedRequest(app, "/api/graph/ws1");
    await authenticatedRequest(
      app,
      "/api/recall-stats/ws1?since=2026-05-01T00:00:00Z&until=2026-05-08T00:00:00Z&excludeAgentTargets=inspector,cli"
    );
    await authenticatedRequest(app, "/api/status");

    expect(calls).toEqual([
      { url: "http://daemon.local/workspaces/ws1/config/soul", method: "GET", body: null },
      { url: "http://daemon.local/config/runtime/embedding-supplement", method: "GET", body: null },
      {
        url: "http://daemon.local/config/runtime/embedding-supplement",
        method: "PATCH",
        body: "{\"secret_ref_mode\":\"paste\",\"secret_value\":\"sk-test-plaintext-secret\"}"
      },
      { url: "http://daemon.local/config/runtime/garden-compute", method: "GET", body: null },
      {
        url: "http://daemon.local/config/runtime/garden-compute",
        method: "PATCH",
        body: "{\"provider_kind\":\"official_api\",\"secret_ref_mode\":\"env\",\"secret_value\":\"ALAYA_OFFICIAL_GARDEN_API_KEY\"}"
      },
      {
        url: "http://daemon.local/workspaces/ws1/config/manifestation-budget",
        method: "GET",
        body: null
      },
      {
        url: "http://daemon.local/workspaces/ws1/config/manifestation-budget",
        method: "PATCH",
        body: "{\"stance_bias_cap\":8}"
      },
      {
        url: "http://daemon.local/workspaces/ws1/config/strategy",
        method: "PATCH",
        body: "{\"auto_approve_readonly\":true}"
      },
      { url: "http://daemon.local/workspaces/ws1/path-graph", method: "GET", body: null },
      {
        url: "http://daemon.local/workspaces/ws1/recall-stats?since=2026-05-01T00%3A00%3A00Z&until=2026-05-08T00%3A00%3A00Z&excludeAgentTargets=inspector%2Ccli",
        method: "GET",
        body: null
      },
      { url: "http://daemon.local/status", method: "GET", body: null }
    ]);
  });


  it("loads embedding-supplement config from the daemon runtime config endpoint", async () => {
    const app = createInspectorApp({
      token: "token",
      workspaceId: "ws1",
      daemonUrl: "http://daemon.local",
      staticRoot: await mkdtemp(path.join(tmpdir(), "inspector-static-")),
      fetchImpl: async (input) => {
        if (String(input).endsWith("/workspaces/ws1/embedding-status")) {
          return Response.json({
            success: true,
            data: {
              workspace_id: "ws1",
              embedding_enabled: false,
              provider_configured: false,
              model_id: "text-embedding-3-small",
              storage_available: true,
              effective_mode: "keyword_only",
              degraded_reason: null,
              checked_at: "2026-05-01T00:00:00.000Z"
            }
          });
        }
        return Response.json({
          success: true,
          data: {
            provider_url: "https://embedding.example.test/v1",
            secret_ref: "file:/home/alaya/.config/alaya/secrets/openai",
            model_id: "text-embedding-3-small",
            embedding_enabled: true
          }
        });
      }
    });

    const response = await authenticatedRequest(app, "/api/config/ws1/embedding-supplement");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        provider_url: "https://embedding.example.test/v1",
        secret_ref: "file:/home/alaya/.config/alaya/secrets/openai",
        model_id: "text-embedding-3-small",
        embedding_enabled: true
      }
    });
  });


  it("sanitizes daemon upstream errors", async () => {
    const app = createInspectorApp({
      token: "token",
      workspaceId: "ws1",
      daemonUrl: "http://daemon.local",
      fetchImpl: async () => Response.json({ error: "/secret/path" }, { status: 503 })
    });

    const response = await authenticatedRequest(app, "/api/status");

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "daemon_503" });
  });


  it("returns daemon unavailable when the daemon fetch fails", async () => {
    const app = createInspectorApp({
      token: "token",
      workspaceId: "ws1",
      daemonUrl: "http://daemon.local",
      fetchImpl: async () => {
        throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5173"), {
          code: "ECONNREFUSED"
        });
      }
    });

    const response = await authenticatedRequest(app, "/api/graph/ws1");

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "daemon_unavailable" });
  });


  it("returns daemon timeout when the daemon fetch hangs", async () => {
    const app = createInspectorApp({
      token: "token",
      workspaceId: "ws1",
      daemonUrl: "http://daemon.local",
      daemonTimeoutMs: 5,
      fetchImpl: async () => await new Promise<Response>(() => {})
    });

    const response = await authenticatedRequest(app, "/api/graph/ws1", {
      headers: { "x-request-id": "req-timeout" }
    });

    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({ error: "daemon_timeout" });
    expect(response.headers.get("x-request-id")).toBe("req-timeout");
    expect(response.headers.get("x-correlation-id")).toBe("req-timeout");
  });


  it("returns daemon timeout when the daemon response body stalls after headers", async () => {
    const app = createInspectorApp({
      token: "token",
      workspaceId: "ws1",
      daemonUrl: "http://daemon.local",
      daemonTimeoutMs: 5,
      fetchImpl: async (_input, init) => {
        const signal = init?.signal;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("{\"partial\":"));
            signal?.addEventListener("abort", () => {
              controller.error(Object.assign(new Error("aborted"), { name: "AbortError" }));
            });
          }
        });
        return new Response(body, {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-request-id": "daemon-body-timeout"
          }
        });
      }
    });

    const response = await authenticatedRequest(app, "/api/graph/ws1");

    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({ error: "daemon_timeout" });
    expect(response.headers.get("x-request-id")).toBe("daemon-body-timeout");
    expect(response.headers.get("x-correlation-id")).toBe("daemon-body-timeout");
  });


  it("sets cache headers for static assets and the html shell", async () => {
    const staticRoot = await mkdtemp(path.join(tmpdir(), "inspector-static-cache-"));
    await mkdir(path.join(staticRoot, "assets"), { recursive: true });
    await writeFile(path.join(staticRoot, "assets", "app.js"), 'console.log("ok");', "utf8");
    await writeFile(path.join(staticRoot, "index.html"), "<!doctype html><html></html>", "utf8");

    const app = createInspectorApp({
      token: "token",
      workspaceId: "ws1",
      daemonUrl: "http://daemon.local",
      staticRoot,
      fetchImpl: async () => Response.json({}, { status: 500 })
    });

    const assetResponse = await authenticatedRequest(app, "/assets/app.js");
    expect(assetResponse.status).toBe(200);
    expect(assetResponse.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");

    const htmlResponse = await authenticatedRequest(app, "/");
    expect(htmlResponse.status).toBe(200);
    expect(htmlResponse.headers.get("cache-control")).toBe("no-cache");
  });


  it("forwards request ids to the daemon and preserves them on the inspector response", async () => {
    let forwardedRequestId: string | null = null;
    const app = createInspectorApp({
      token: "token",
      workspaceId: "ws1",
      daemonUrl: "http://daemon.local",
      fetchImpl: async (_input, init) => {
        const headers = new Headers(init?.headers);
        forwardedRequestId = headers.get("x-request-id");
        return new Response(JSON.stringify({ success: true, data: { ok: true } }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-request-id": headers.get("x-request-id") ?? "missing"
          }
        });
      }
    });

    const response = await authenticatedRequest(app, "/api/status", {
      headers: { "x-request-id": "req-123" }
    });

    expect(response.status).toBe(200);
    expect(forwardedRequestId).toBe("req-123");
    expect(response.headers.get("x-request-id")).toBe("req-123");
    expect(response.headers.get("x-correlation-id")).toBe("req-123");
  });


  it("rejects oversized inspector mutation bodies before proxying", async () => {
    let called = false;
    const app = createInspectorApp({
      token: "token",
      workspaceId: "ws1",
      daemonUrl: "http://daemon.local",
      fetchImpl: async () => {
        called = true;
        return Response.json({ success: true, data: { ok: true } });
      }
    });

    const response = await app.request(
      createChunkedJsonRequest(
        "http://localhost/api/proposals/ws1/memory/mem-1/rewrite",
        JSON.stringify({ new_content: "x".repeat(MAX_INSPECTOR_REQUEST_BODY_BYTES) })
      )
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "request_body_too_large" });
    expect(called).toBe(false);
    expect(response.headers.get("x-request-id")).toBeTruthy();
  });


  it("rejects chunked oversized bodies on no-body inspector proposal actions before proxying", async () => {
    let called = false;
    const app = createInspectorApp({
      token: "token",
      workspaceId: "ws1",
      daemonUrl: "http://daemon.local",
      fetchImpl: async () => {
        called = true;
        return Response.json({ success: true, data: { ok: true } });
      }
    });

    const response = await app.request(
      createChunkedJsonRequest(
        "http://localhost/api/proposals/ws1/memory/mem-1/keep",
        JSON.stringify({ payload: "x".repeat(MAX_INSPECTOR_REQUEST_BODY_BYTES) })
      )
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "request_body_too_large" });
    expect(called).toBe(false);
  });


  it("rejects unexpected small bodies on no-body inspector proposal actions before proxying", async () => {
    let called = false;
    const app = createInspectorApp({
      token: "token",
      workspaceId: "ws1",
      daemonUrl: "http://daemon.local",
      fetchImpl: async () => {
        called = true;
        return Response.json({ success: true, data: { ok: true } });
      }
    });

    const response = await app.request(
      createChunkedJsonRequest(
        "http://localhost/api/proposals/ws1/memory/mem-1/keep",
        JSON.stringify({ payload: "x" })
      )
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
    expect(called).toBe(false);
  });

});
