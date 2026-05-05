import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createInspectorApp, INSPECTOR_ROUTE_SURFACE } from "../app.js";

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
      "GET /api/graph/:workspaceId",
      "GET /api/status",
      // A1 (HITL daemon backbone) — Inspector loopback for the new
      // pending-proposals listing tool plus accept/reject.
      "GET /api/proposals/:workspaceId/pending",
      "POST /api/proposals/:workspaceId/:proposalId/review"
    ]);
  });

  it("proxies config, graph, status, and embedding-supplement routes to daemon HTTP without importing daemon code", async () => {
    const calls: { url: string; method: string; body: string | null }[] = [];
    const app = createInspectorApp({
      token: "token",
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

    await app.request("/api/config/ws1/soul?token=token");
    await app.request("/api/config/ws1/embedding-supplement?token=token");
    await app.request("/api/config/runtime/embedding-supplement?token=token", {
      method: "PATCH",
      body: JSON.stringify({
        secret_ref_mode: "paste",
        secret_value: "sk-test-plaintext-secret"
      }),
      headers: { "content-type": "application/json" }
    });
    await app.request("/api/config/ws1/strategy?token=token", {
      method: "PATCH",
      body: JSON.stringify({ auto_approve_readonly: true }),
      headers: { "content-type": "application/json" }
    });
    await app.request("/api/graph/ws1?token=token");
    await app.request("/api/status?token=token");

    expect(calls).toEqual([
      { url: "http://daemon.local/workspaces/ws1/config/soul", method: "GET", body: null },
      { url: "http://daemon.local/config/runtime/embedding-supplement", method: "GET", body: null },
      {
        url: "http://daemon.local/config/runtime/embedding-supplement",
        method: "PATCH",
        body: "{\"secret_ref_mode\":\"paste\",\"secret_value\":\"sk-test-plaintext-secret\"}"
      },
      {
        url: "http://daemon.local/workspaces/ws1/config/strategy",
        method: "PATCH",
        body: "{\"auto_approve_readonly\":true}"
      },
      { url: "http://daemon.local/workspaces/ws1/soul/graph", method: "GET", body: null },
      { url: "http://daemon.local/status", method: "GET", body: null }
    ]);
  });

  it("loads embedding-supplement config from the daemon runtime config endpoint", async () => {
    const app = createInspectorApp({
      token: "token",
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

    const response = await app.request("/api/config/ws1/embedding-supplement?token=token");

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
      daemonUrl: "http://daemon.local",
      fetchImpl: async () => Response.json({ error: "/secret/path" }, { status: 503 })
    });

    const response = await app.request("/api/status?token=token");

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "daemon_503" });
  });

  it("sanitizes daemon validation errors for embedding paste requests", async () => {
    const plaintext = "sk-test-leaked-secret";
    const app = createInspectorApp({
      token: "token",
      daemonUrl: "http://daemon.local",
      fetchImpl: async () => Response.json({ error: `validation failed: ${plaintext}` }, { status: 400 })
    });

    const response = await app.request("/api/config/runtime/embedding-supplement?token=token", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        secret_ref_mode: "paste",
        secret_value: plaintext
      })
    });

    expect(response.status).toBe(400);
    const bodyText = await response.text();
    expect(bodyText).toBe("{\"error\":\"daemon_400\"}");
    expect(bodyText).not.toContain(plaintext);
    expect(bodyText).not.toContain("validation failed");
  });

  it("sanitizes local handler errors without echoing stack or plaintext", async () => {
    const plaintext = "sk-test-plaintext-secret";
    const app = createInspectorApp({
      token: "token",
      daemonUrl: "http://daemon.local",
      fetchImpl: async () => {
        throw new Error(`boom ${plaintext}`);
      }
    });

    const response = await app.request("/api/config/runtime/embedding-supplement?token=token", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        secret_ref_mode: "paste",
        secret_value: plaintext
      })
    });

    expect(response.status).toBe(500);
    const bodyText = await response.text();
    expect(bodyText).toBe("{\"error\":\"internal_error\"}");
    expect(bodyText).not.toContain(plaintext);
    expect(bodyText).not.toContain("Error:");
  });

  it("serves static files, rejects traversal, and tolerates a missing frontend bundle", async () => {
    const staticRoot = await mkdtemp(path.join(tmpdir(), "inspector-static-"));
    await mkdir(path.join(staticRoot, "assets"));
    await writeFile(path.join(staticRoot, "index.html"), "<html>ok</html>", "utf8");
    await writeFile(path.join(staticRoot, "assets", "app.js"), "console.log('ok');", "utf8");
    const app = createInspectorApp({ token: "token", staticRoot });

    expect((await app.request("/")).status).toBe(401);
    expect((await app.request("/api/status")).status).toBe(401);
    expect(await (await app.request("/?token=token")).text()).toContain("<html>ok</html>");
    expect(await (await app.request("/assets/app.js")).text()).toContain("console.log");
    expect((await app.request("/..%2F..%2Fetc%2Fpasswd?token=token")).status).toBe(404);

    const missingApp = createInspectorApp({
      token: "token",
      staticRoot: await mkdtemp(path.join(tmpdir(), "inspector-static-missing-"))
    });
    const missingResponse = await missingApp.request("/?token=token");
    expect(missingResponse.status).toBe(503);
    expect(await missingResponse.json()).toEqual({ error: "frontend_bundle_missing" });
  });

  // A1 (HITL daemon backbone) — Inspector forwards proposal review
  // calls to the daemon's workspace-scoped HTTP wrapper around the MCP
  // handler. The Inspector backend itself never imports daemon code.
  it("proxies pending-proposals listing and accept/reject through to the daemon", async () => {
    const calls: {
      url: string;
      method: string;
      body: string | null;
      requestToken: string | null;
      desktop: string | null;
    }[] = [];
    const app = createInspectorApp({
      token: "token",
      daemonUrl: "http://daemon.local",
      staticRoot: await mkdtemp(path.join(tmpdir(), "inspector-static-")),
      env: {
        ALAYA_REQUEST_TOKEN: "daemon-request-token",
        ALAYA_REVIEWER_TOKEN: "review-token",
        ALAYA_REVIEWER_IDENTITY: "user:local-reviewer"
      },
      fetchImpl: async (input, init) => {
        const headers = new Headers(init?.headers);
        calls.push({
          url: String(input),
          method: init?.method ?? "GET",
          body: init?.body === undefined ? null : String(init.body),
          requestToken: headers.get("x-request-token"),
          desktop: headers.get("x-alaya-desktop")
        });
        return Response.json({ success: true, data: { ok: true } });
      }
    });

    await app.request("/api/proposals/ws1/pending?token=token&limit=10");
    await app.request("/api/proposals/ws1/prop-1/review?token=token", {
      method: "POST",
      body: JSON.stringify({
        verdict: "accept",
        reason: "looks right",
        reviewer_identity: "user:payload"
      }),
      headers: { "content-type": "application/json" }
    });

    expect(calls).toEqual([
      {
        url: "http://daemon.local/workspaces/ws1/proposals/pending?limit=10",
        method: "GET",
        body: null,
        requestToken: null,
        desktop: null
      },
      {
        url: "http://daemon.local/workspaces/ws1/proposals/prop-1/review",
        method: "POST",
        body: "{\"verdict\":\"accept\",\"reason\":\"looks right\",\"reviewer_identity\":\"user:local-reviewer\",\"reviewer_token\":\"review-token\"}",
        requestToken: "daemon-request-token",
        desktop: "1"
      }
    ]);
  });
});
