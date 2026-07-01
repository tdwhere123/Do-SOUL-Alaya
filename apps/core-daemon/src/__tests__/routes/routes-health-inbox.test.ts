import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { CoreError } from "@do-soul/alaya-core";
import { registerHealthInboxRoutes } from "../../routes/health-inbox.js";
import { registerErrorHandler } from "../../middleware/error-handler.js";

function buildApp(services: Parameters<typeof registerHealthInboxRoutes>[1]): Hono {
  const app = new Hono();
  registerErrorHandler(app, { error: vi.fn() });
  registerHealthInboxRoutes(app, services);
  return app;
}

function makeGroup(overrides: Record<string, unknown>) {
  return {
    group_id: "g-1",
    workspace_id: "ws1",
    target_object_id: "mem-1",
    target_object_kind: "memory_entry",
    cause_kind: "orphan_radar" as const,
    severity: "warn" as const,
    confidence: 0.8,
    first_seen_at: "2026-05-10T00:00:00.000Z",
    last_seen_at: "2026-05-15T00:00:00.000Z",
    count: 3,
    suggested_actions: ["relink"] as readonly string[],
    resolution_state: "pending" as const,
    resolved_at: null,
    resolved_by: null,
    ...overrides
  };
}

describe("health-inbox route", () => {
  it("returns grouped HealthIssueGroup rows for the workspace", async () => {
    const rows = [
      makeGroup({ group_id: "g-1", cause_kind: "orphan_radar" }),
      makeGroup({ group_id: "g-2", cause_kind: "green_revoked" }),
      makeGroup({ group_id: "g-3", cause_kind: "evidence_failure" }),
      makeGroup({ group_id: "g-4", cause_kind: "orphan_radar" }),
      makeGroup({ group_id: "g-5", cause_kind: "evidence_failure" })
    ];
    const findByWorkspace = vi.fn().mockReturnValue(rows);
    const getById = vi.fn().mockResolvedValue({ workspace_id: "ws1" });
    const app = buildApp({
      workspaceService: { getById },
      healthIssueGroupRepo: { findByWorkspace }
    });

    const response = await app.request("/workspaces/ws1/health-inbox?state=pending");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      success: boolean;
      data: { workspace_id: string; total_count: number; groups: readonly unknown[] };
    };
    expect(body.success).toBe(true);
    expect(body.data.workspace_id).toBe("ws1");
    expect(body.data.total_count).toBe(5);
    expect(body.data.groups.length).toBe(5);
    expect(getById).toHaveBeenCalledWith("ws1");
    expect(findByWorkspace).toHaveBeenCalledWith("ws1", {
      state: "pending",
      limit: 200
    });
  });

  it("forwards causeKind + limit query params", async () => {
    const findByWorkspace = vi.fn().mockReturnValue([]);
    const getById = vi.fn().mockResolvedValue({ workspace_id: "ws1" });
    const app = buildApp({
      workspaceService: { getById },
      healthIssueGroupRepo: { findByWorkspace }
    });
    const response = await app.request(
      "/workspaces/ws1/health-inbox?state=resolved&causeKind=green_revoked&limit=42"
    );
    expect(response.status).toBe(200);
    expect(findByWorkspace).toHaveBeenCalledWith("ws1", {
      state: "resolved",
      causeKind: "green_revoked",
      limit: 42
    });
  });

  it("ignores unknown enum values gracefully", async () => {
    const findByWorkspace = vi.fn().mockReturnValue([]);
    const getById = vi.fn().mockResolvedValue({ workspace_id: "ws1" });
    const app = buildApp({
      workspaceService: { getById },
      healthIssueGroupRepo: { findByWorkspace }
    });
    const response = await app.request(
      "/workspaces/ws1/health-inbox?state=bogus&causeKind=nope"
    );
    expect(response.status).toBe(200);
    expect(findByWorkspace).toHaveBeenCalledWith("ws1", { limit: 200 });
  });

  it("returns 404 when workspace is not found", async () => {
    const findByWorkspace = vi.fn();
    const getById = vi.fn().mockRejectedValue(
      new CoreError("NOT_FOUND", "workspace ws-missing not found")
    );
    const app = buildApp({
      workspaceService: { getById },
      healthIssueGroupRepo: { findByWorkspace }
    });
    const response = await app.request("/workspaces/ws-missing/health-inbox");
    expect(response.status).toBe(404);
    expect(findByWorkspace).not.toHaveBeenCalled();
  });
});
