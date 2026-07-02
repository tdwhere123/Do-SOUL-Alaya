import { describe, expect, it } from "vitest";
import { createInspectorApp } from "../../runtime/app.js";
import { authenticatedRequest } from "../app/routes-test-utils.js";

const BOUND_WORKSPACE = "ws-bound";
const OTHER_WORKSPACE = "ws-other";
const DAEMON_URL = "http://daemon.local";

function createBoundApp(fetchImpl: NonNullable<Parameters<typeof createInspectorApp>[0]["fetchImpl"]>) {
  return createInspectorApp({
    token: "token",
    workspaceId: BOUND_WORKSPACE,
    daemonUrl: DAEMON_URL,
    fetchImpl
  });
}

describe("inspector runtime config workspace guard (I1)", () => {
  it("rejects GET embedding-supplement and garden-compute for a mismatched workspace", async () => {
    const calls: string[] = [];
    const app = createBoundApp(async (input) => {
      calls.push(String(input));
      return Response.json({ success: true, data: { enabled: false } });
    });

    const embeddingAllowed = await authenticatedRequest(
      app,
      `/api/config/${BOUND_WORKSPACE}/embedding-supplement`
    );
    const embeddingForbidden = await authenticatedRequest(
      app,
      `/api/config/${OTHER_WORKSPACE}/embedding-supplement`
    );
    const gardenAllowed = await authenticatedRequest(app, `/api/config/${BOUND_WORKSPACE}/garden-compute`);
    const gardenForbidden = await authenticatedRequest(app, `/api/config/${OTHER_WORKSPACE}/garden-compute`);

    expect(embeddingAllowed.status).toBe(200);
    expect(embeddingForbidden.status).toBe(403);
    expect(gardenAllowed.status).toBe(200);
    expect(gardenForbidden.status).toBe(403);
    await expect(embeddingForbidden.json()).resolves.toEqual({ error: "workspace_forbidden" });
    await expect(gardenForbidden.json()).resolves.toEqual({ error: "workspace_forbidden" });
    expect(calls).toEqual([
      `${DAEMON_URL}/config/runtime/embedding-supplement`,
      `${DAEMON_URL}/config/runtime/garden-compute`
    ]);
  });

  it("rejects PATCH runtime embedding-supplement and garden-compute without a bound workspace", async () => {
    const calls: string[] = [];
    const app = createInspectorApp({
      token: "token",
      daemonUrl: DAEMON_URL,
      fetchImpl: async (input) => {
        calls.push(String(input));
        return Response.json({ success: true, data: { ok: true } });
      }
    });

    const embedding = await authenticatedRequest(app, "/api/config/runtime/embedding-supplement", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true })
    });
    const garden = await authenticatedRequest(app, "/api/config/runtime/garden-compute", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "default" })
    });

    expect(embedding.status).toBe(500);
    expect(garden.status).toBe(500);
    await expect(embedding.json()).resolves.toEqual({ error: "workspace_binding_missing" });
    await expect(garden.json()).resolves.toEqual({ error: "workspace_binding_missing" });
    expect(calls).toEqual([]);
  });

  it("proxies PATCH runtime embedding-supplement and garden-compute for the bound workspace", async () => {
    const calls: Array<{ readonly url: string; readonly method: string }> = [];
    const app = createBoundApp(async (input, init) => {
      calls.push({ url: String(input), method: init?.method ?? "GET" });
      return Response.json({ success: true, data: { ok: true } });
    });

    const embedding = await authenticatedRequest(app, "/api/config/runtime/embedding-supplement", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true })
    });
    const garden = await authenticatedRequest(app, "/api/config/runtime/garden-compute", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "default" })
    });

    expect(embedding.status).toBe(200);
    expect(garden.status).toBe(200);
    expect(calls).toEqual([
      { url: `${DAEMON_URL}/config/runtime/embedding-supplement`, method: "PATCH" },
      { url: `${DAEMON_URL}/config/runtime/garden-compute`, method: "PATCH" }
    ]);
  });
});
