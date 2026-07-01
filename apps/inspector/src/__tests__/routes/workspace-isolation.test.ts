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

describe("inspector workspace isolation", () => {
  it("graph route proxies only the bound workspace and rejects cross-workspace access", async () => {
    const calls: string[] = [];
    const app = createBoundApp(async (input) => {
      calls.push(String(input));
      return Response.json({ success: true, data: { nodes: [] } });
    });

    const allowed = await authenticatedRequest(app, `/api/graph/${BOUND_WORKSPACE}`);
    const forbidden = await authenticatedRequest(app, `/api/graph/${OTHER_WORKSPACE}`);

    expect(allowed.status).toBe(200);
    expect(forbidden.status).toBe(403);
    await expect(forbidden.json()).resolves.toEqual({ error: "workspace_forbidden" });
    expect(calls).toEqual([`${DAEMON_URL}/workspaces/${BOUND_WORKSPACE}/path-graph`]);
  });

  it("memory-entries route scopes list queries to the bound workspace", async () => {
    const calls: string[] = [];
    const app = createBoundApp(async (input) => {
      calls.push(String(input));
      return Response.json({ success: true, data: [] }, { headers: { "x-total-count": "0" } });
    });

    const allowed = await authenticatedRequest(
      app,
      `/api/memory-entries/${BOUND_WORKSPACE}?dimension=preference&limit=25&offset=0`
    );
    const forbidden = await authenticatedRequest(app, `/api/memory-entries/${OTHER_WORKSPACE}`);

    expect(allowed.status).toBe(200);
    expect(forbidden.status).toBe(403);
    await expect(forbidden.json()).resolves.toEqual({ error: "workspace_forbidden" });
    expect(calls).toEqual([
      `${DAEMON_URL}/workspaces/${BOUND_WORKSPACE}/memories?dimension=preference&limit=25&offset=0`
    ]);
  });

  it("pointer fetch route scopes evidence reads to the bound workspace", async () => {
    const calls: string[] = [];
    const app = createBoundApp(async (input) => {
      calls.push(String(input));
      return Response.json({ success: true, data: { object_id: "evidence-1" } });
    });

    const allowed = await authenticatedRequest(app, `/api/pointers/${BOUND_WORKSPACE}/evidence%2F1`);
    const forbidden = await authenticatedRequest(app, `/api/pointers/${OTHER_WORKSPACE}/evidence-1`);

    expect(allowed.status).toBe(200);
    expect(forbidden.status).toBe(403);
    await expect(forbidden.json()).resolves.toEqual({ error: "workspace_forbidden" });
    expect(calls).toEqual([`${DAEMON_URL}/workspaces/${BOUND_WORKSPACE}/evidence/evidence%2F1`]);
  });

  it("recall-stats route rejects mismatched workspace before proxying", async () => {
    const calls: string[] = [];
    const app = createBoundApp(async (input) => {
      calls.push(String(input));
      return Response.json({ success: true, data: { total_recalls: 0 } });
    });

    const allowed = await authenticatedRequest(
      app,
      `/api/recall-stats/${BOUND_WORKSPACE}?since=2026-05-01T00:00:00Z&excludeAgentTargets=inspector`
    );
    const forbidden = await authenticatedRequest(app, `/api/recall-stats/${OTHER_WORKSPACE}`);

    expect(allowed.status).toBe(200);
    expect(forbidden.status).toBe(403);
    await expect(forbidden.json()).resolves.toEqual({ error: "workspace_forbidden" });
    expect(calls).toEqual([
      `${DAEMON_URL}/workspaces/${BOUND_WORKSPACE}/recall-stats?since=2026-05-01T00%3A00%3A00Z&excludeAgentTargets=inspector`
    ]);
  });
});
