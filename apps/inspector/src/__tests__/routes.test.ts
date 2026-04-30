import { mkdir, readFile, writeFile } from "node:fs/promises";
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
      "GET /api/status"
    ]);
  });

  it("proxies config, graph, and status routes to daemon HTTP without importing daemon code", async () => {
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
    await app.request("/api/config/ws1/strategy?token=token", {
      method: "PATCH",
      body: JSON.stringify({ auto_approve_readonly: true }),
      headers: { "content-type": "application/json" }
    });
    await app.request("/api/graph/ws1?token=token");
    await app.request("/api/status?token=token");

    expect(calls).toEqual([
      { url: "http://daemon.local/workspaces/ws1/config/soul", method: "GET", body: null },
      {
        url: "http://daemon.local/workspaces/ws1/config/strategy",
        method: "PATCH",
        body: "{\"auto_approve_readonly\":true}"
      },
      { url: "http://daemon.local/workspaces/ws1/soul/graph", method: "GET", body: null },
      { url: "http://daemon.local/status", method: "GET", body: null }
    ]);
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

  it("writes runtime embedding supplement env and audit without plaintext keys", async () => {
    const configDir = await mkdtemp(path.join(tmpdir(), "inspector-config-"));
    await writeFile(path.join(configDir, ".env"), "OPENAI_API_KEY=env:OLD\n", "utf8");
    const app = createInspectorApp({
      token: "token",
      env: { ALAYA_CONFIG_DIR: configDir },
      clock: () => "2026-04-30T00:00:00.000Z"
    });

    const response = await app.request("/api/config/runtime/embedding-supplement?token=token", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        embedding_enabled: true,
        secret_ref: "env:OPENAI_API_KEY",
        model_id: "text-embedding-3-small"
      })
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      requires_daemon_restart: true
    });
    const env = await readFile(path.join(configDir, ".env"), "utf8");
    expect(env).toContain("ALAYA_ENABLE_EMBEDDING_SUPPLEMENT=true");
    expect(env).toContain("OPENAI_API_KEY=env:OPENAI_API_KEY");
    expect(env).not.toContain("sk-");
    const audit = await readFile(
      path.join(configDir, "audit", "inspector-embedding-2026-04-30T00-00-00.000Z.json"),
      "utf8"
    );
    expect(audit).toContain("env:OPENAI_API_KEY");
    expect(audit).not.toContain("sk-");
  });

  it("serves static files, rejects traversal, and tolerates a missing frontend bundle", async () => {
    const staticRoot = await mkdtemp(path.join(tmpdir(), "inspector-static-"));
    await mkdir(path.join(staticRoot, "assets"));
    await writeFile(path.join(staticRoot, "index.html"), "<html>ok</html>", "utf8");
    await writeFile(path.join(staticRoot, "assets", "app.js"), "console.log('ok');", "utf8");
    const app = createInspectorApp({ token: "token", staticRoot });

    expect(await (await app.request("/?token=token")).text()).toContain("<html>ok</html>");
    expect(await (await app.request("/assets/app.js?token=token")).text()).toContain("console.log");
    expect((await app.request("/..%2F..%2Fetc%2Fpasswd?token=token")).status).toBe(404);

    const missingApp = createInspectorApp({
      token: "token",
      staticRoot: await mkdtemp(path.join(tmpdir(), "inspector-static-missing-"))
    });
    const missingResponse = await missingApp.request("/?token=token");
    expect(missingResponse.status).toBe(503);
    expect(await missingResponse.json()).toEqual({ error: "frontend_bundle_missing" });
  });
});
