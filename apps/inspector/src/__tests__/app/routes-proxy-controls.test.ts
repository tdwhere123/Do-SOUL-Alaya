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
  it("rejects streaming no-body inspector proposal actions without waiting for EOF", async () => {
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

    const response = await withResponseTimeout(
      app.request(
        createNeverEndingChunkedJsonRequest(
          "http://localhost/api/proposals/ws1/memory/mem-1/keep",
          JSON.stringify({ payload: "x" })
        )
      )
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
    expect(called).toBe(false);
  });


  it("treats an empty attached no-body inspector stream as no body and still proxies", async () => {
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
      createEmptyChunkedJsonRequest("http://localhost/api/proposals/ws1/memory/mem-1/keep")
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: { ok: true } });
    expect(called).toBe(true);
  });


  it("sanitizes daemon validation errors for embedding paste requests", async () => {
    const plaintext = "sk-test-leaked-secret";
    const app = createInspectorApp({
      token: "token",
      workspaceId: "ws1",
      daemonUrl: "http://daemon.local",
      fetchImpl: async () => Response.json({ error: `validation failed: ${plaintext}` }, { status: 400 })
    });

    const response = await authenticatedRequest(app, "/api/config/runtime/embedding-supplement", {
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


  it("sanitizes daemon fetch failures without echoing stack or plaintext", async () => {
    const plaintext = "sk-test-plaintext-secret";
    const app = createInspectorApp({
      token: "token",
      workspaceId: "ws1",
      daemonUrl: "http://daemon.local",
      fetchImpl: async () => {
        throw new Error(`boom ${plaintext}`);
      }
    });

    const response = await authenticatedRequest(app, "/api/config/runtime/embedding-supplement", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        secret_ref_mode: "paste",
        secret_value: plaintext
      })
    });

    expect(response.status).toBe(503);
    const bodyText = await response.text();
    expect(bodyText).toBe("{\"error\":\"daemon_unavailable\"}");
    expect(bodyText).not.toContain(plaintext);
    expect(bodyText).not.toContain("Error:");
  });


  it("serves static files, rejects traversal, and tolerates a missing frontend bundle", async () => {
    const staticRoot = await mkdtemp(path.join(tmpdir(), "inspector-static-"));
    await mkdir(path.join(staticRoot, "assets"));
    await writeFile(path.join(staticRoot, "index.html"), "<html>ok</html>", "utf8");
    await writeFile(path.join(staticRoot, "assets", "app.js"), "console.log('ok');", "utf8");
    const app = createInspectorApp({ token: "token", staticRoot });

    expect((await app.request("/")).status).toBe(200);
    expect((await app.request("/api/status")).status).toBe(401);
    expect((await app.request("/api/status?token=token")).status).toBe(401);
    expect(await (await app.request("/?workspaceId=ws1#token=token")).text()).toContain("<html>ok</html>");
    expect(await (await app.request("/assets/app.js")).text()).toContain("console.log");
    expect((await app.request("/..%2F..%2Fetc%2Fpasswd")).status).toBe(404);

    const missingApp = createInspectorApp({
      token: "token",
      staticRoot: await mkdtemp(path.join(tmpdir(), "inspector-static-missing-"))
    });
    const missingResponse = await missingApp.request("/");
    expect(missingResponse.status).toBe(503);
    expect(await missingResponse.json()).toEqual({ error: "not_found" });
  });

  // Inspector forwards proposal review calls to the daemon's
  // workspace-scoped HTTP wrapper around the MCP handler. The Inspector
  // backend itself never imports daemon code.

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
      workspaceId: "ws1",
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

    await authenticatedRequest(app, "/api/proposals/ws1/pending?limit=10");
    await authenticatedRequest(app, "/api/proposals/ws1/prop-1/review", {
      method: "POST",
      body: JSON.stringify({
        verdict: "accept",
        reason: "looks right",
        reviewer_identity: "user:payload"
      }),
      headers: { "content-type": "application/json" }
    });
    await authenticatedRequest(app, "/api/proposals/ws1/memory/mem-1/rewrite", {
      method: "POST",
      body: JSON.stringify({ new_content: "rewritten memory" }),
      headers: { "content-type": "application/json" }
    });
    await authenticatedRequest(app, "/api/proposals/ws1/memory/mem-1/retire", {
      method: "POST"
    });

    expect(calls).toEqual([
      {
        url: "http://daemon.local/workspaces/ws1/proposals/pending?limit=10",
        method: "GET",
        body: null,
        requestToken: "daemon-request-token",
        desktop: "1"
      },
      {
        url: "http://daemon.local/workspaces/ws1/proposals/prop-1/review",
        method: "POST",
        body: "{\"verdict\":\"accept\",\"reason\":\"looks right\",\"reviewer_identity\":\"user:local-reviewer\",\"reviewer_token\":\"review-token\"}",
        requestToken: "daemon-request-token",
        desktop: "1"
      },
      {
        url: "http://daemon.local/workspaces/ws1/soul/memory/mem-1/proposals/rewrite",
        method: "POST",
        body: "{\"new_content\":\"rewritten memory\"}",
        requestToken: "daemon-request-token",
        desktop: "1"
      },
      {
        url: "http://daemon.local/workspaces/ws1/soul/memory/mem-1/proposals/retire",
        method: "POST",
        body: null,
        requestToken: "daemon-request-token",
        desktop: "1"
      }
    ]);
  });

  // Inspector forwards the Health Inbox projection GET and the
  // promote-to-strictly_governed proposal POST to the daemon's
  // workspace-scoped HTTP endpoints without importing daemon code.

  it("proxies health-inbox and promote-strictly-governed through to the daemon", async () => {
    const calls: {
      url: string;
      method: string;
      body: string | null;
      requestToken: string | null;
      desktop: string | null;
    }[] = [];
    const app = createInspectorApp({
      token: "token",
      workspaceId: "ws1",
      daemonUrl: "http://daemon.local",
      staticRoot: await mkdtemp(path.join(tmpdir(), "inspector-static-")),
      env: { ALAYA_REQUEST_TOKEN: "daemon-request-token" },
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

    await authenticatedRequest(app, "/api/workspaces/ws1/health-inbox?state=pending");
    await authenticatedRequest(
      app,
      "/api/workspaces/ws1/soul/memory/mem-1/proposals/promote-strictly-governed",
      {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "content-type": "application/json" }
      }
    );

    expect(calls).toEqual([
      {
        url: "http://daemon.local/workspaces/ws1/health-inbox?state=pending",
        method: "GET",
        body: null,
        requestToken: "daemon-request-token",
        desktop: "1"
      },
      {
        url: "http://daemon.local/workspaces/ws1/soul/memory/mem-1/proposals/promote-strictly-governed",
        method: "POST",
        body: "{}",
        requestToken: "daemon-request-token",
        desktop: "1"
      }
    ]);
  });


  it("rejects health-inbox and promote paths that do not match the launch workspace", async () => {
    const calls: string[] = [];
    const app = createInspectorApp({
      token: "token",
      workspaceId: "ws1",
      daemonUrl: "http://daemon.local",
      fetchImpl: async (input) => {
        calls.push(String(input));
        return Response.json({ success: true, data: { ok: true } });
      }
    });

    const healthInbox = await authenticatedRequest(app, "/api/workspaces/ws2/health-inbox");
    const promote = await authenticatedRequest(
      app,
      "/api/workspaces/ws2/soul/memory/mem-1/proposals/promote-strictly-governed",
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }
    );

    expect(healthInbox.status).toBe(403);
    expect(promote.status).toBe(403);
    await expect(healthInbox.json()).resolves.toEqual({ error: "workspace_forbidden" });
    await expect(promote.json()).resolves.toEqual({ error: "workspace_forbidden" });
    expect(calls).toEqual([]);
  });


  it("rejects workspace-scoped API paths that do not match the launch workspace", async () => {
    const calls: string[] = [];
    const app = createInspectorApp({
      token: "token",
      workspaceId: "ws1",
      daemonUrl: "http://daemon.local",
      fetchImpl: async (input) => {
        calls.push(String(input));
        return Response.json({ success: true, data: { ok: true } });
      }
    });

    const graph = await authenticatedRequest(app, "/api/graph/ws2");
    const graphWhitespace = await authenticatedRequest(app, "/api/graph/ws1%20");
    const config = await authenticatedRequest(app, "/api/config/ws2/strategy");
    const proposals = await authenticatedRequest(app, "/api/proposals/ws2/pending");
    const recallStats = await authenticatedRequest(app, "/api/recall-stats/ws2");
    const search = await authenticatedRequest(app, "/api/soul/search/ws2", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "memory" })
    });
    const memoryList = await authenticatedRequest(app, "/api/memory-entries/ws2");
    const pointer = await authenticatedRequest(app, "/api/pointers/ws2/evidence-1");

    expect(graph.status).toBe(403);
    expect(graphWhitespace.status).toBe(403);
    expect(config.status).toBe(403);
    expect(proposals.status).toBe(403);
    expect(recallStats.status).toBe(403);
    expect(search.status).toBe(403);
    expect(memoryList.status).toBe(403);
    expect(pointer.status).toBe(403);
    await expect(graph.json()).resolves.toEqual({ error: "workspace_forbidden" });
    await expect(graphWhitespace.json()).resolves.toEqual({ error: "workspace_forbidden" });
    await expect(recallStats.json()).resolves.toEqual({ error: "workspace_forbidden" });
    await expect(memoryList.json()).resolves.toEqual({ error: "workspace_forbidden" });
    await expect(pointer.json()).resolves.toEqual({ error: "workspace_forbidden" });
    expect(calls).toEqual([]);
  });


  it("proxies pointer fetch through the workspace-scoped daemon evidence path with URL-encoded object id", async () => {
    const calls: string[] = [];
    const app = createInspectorApp({
      token: "token",
      workspaceId: "ws1",
      daemonUrl: "http://daemon.local",
      fetchImpl: async (input) => {
        calls.push(String(input));
        return Response.json({ success: true, data: { object_id: "obj/1", gist: "g", excerpt: "e" } });
      }
    });
    const response = await authenticatedRequest(app, "/api/pointers/ws1/obj%2F1");
    expect(response.status).toBe(200);
    expect(calls).toEqual(["http://daemon.local/workspaces/ws1/evidence/obj%2F1"]);
  });


  it("forwards memory list filters/pagination query parameters and preserves pagination headers", async () => {
    const calls: string[] = [];
    const app = createInspectorApp({
      token: "token",
      workspaceId: "ws1",
      daemonUrl: "http://daemon.local",
      fetchImpl: async (input) => {
        calls.push(String(input));
        return Response.json(
          { success: true, data: [{ object_id: "m201" }] },
          {
            headers: {
              "x-total-count": "250",
              "x-limit": "200",
              "x-offset": "200"
            }
          }
        );
      }
    });

    const response = await authenticatedRequest(
      app,
      "/api/memory-entries/ws1?dimension=fact&scope_class=project&has_conflict=true&limit=200&offset=200"
    );

    expect(response.status).toBe(200);
    expect(calls).toEqual([
      "http://daemon.local/workspaces/ws1/memories?dimension=fact&scope_class=project&has_conflict=true&limit=200&offset=200"
    ]);
    expect(response.headers.get("x-total-count")).toBe("250");
    expect(response.headers.get("x-limit")).toBe("200");
    expect(response.headers.get("x-offset")).toBe("200");
  });

});
