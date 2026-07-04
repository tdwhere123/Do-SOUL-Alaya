import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { CoreError } from "@do-soul/alaya-core";
import { registerRecallStatsRoutes } from "../../routes/memory/recall-stats.js";
import { registerErrorHandler } from "../../middleware/error-handler.js";

const SAMPLE_STATS = {
  window: {
    workspace_id: "ws1",
    since: "2026-05-07T00:00:00.000Z",
    until: null,
    excluded_agent_targets: ["inspector", "cli", "tools-cli"]
  },
  recall: {
    total: 42,
    unique_sessions: 12,
    unique_runs: 9,
    null_run: 1,
    miss_count: 4,
    miss_ratio: 0.0952,
    p50_pointer_count: 3,
    p50_latency_ms: 120
  },
  embedding: {
    total_queries: 3,
    returned_candidate_count: 5,
    p50_latency_ms: 280,
    p95_latency_ms: 900,
    p99_latency_ms: 1250,
    latency_buckets: [
      { label: "<=150ms", count: 1 },
      { label: "<=300ms", count: 1 },
      { label: "<=800ms", count: 0 },
      { label: "<=1100ms", count: 0 },
      { label: ">1100ms", count: 1 }
    ]
  },
  usage: {
    total: 30,
    used: 18,
    skipped: 8,
    not_applicable: 4,
    used_ratio: 0.6,
    follow_through_ratio: 0.714
  }
};

function buildApp(services: Parameters<typeof registerRecallStatsRoutes>[1]): Hono {
  const app = new Hono();
  registerErrorHandler(app, { error: vi.fn() });
  registerRecallStatsRoutes(app, services);
  return app;
}

describe("recall-stats route", () => {
  it("forwards parsed query into the service and returns the envelope", async () => {
    const getStats = vi.fn().mockResolvedValue(SAMPLE_STATS);
    const getById = vi.fn().mockResolvedValue({ workspace_id: "ws1" });
    const app = buildApp({
      workspaceService: { getById },
      recallUtilizationService: { getStats }
    });

    const response = await app.request(
      "/workspaces/ws1/recall-stats?since=2026-05-07T00:00:00.000Z&until=2026-05-14T00:00:00.000Z&excludeAgentTargets=inspector,cli"
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: SAMPLE_STATS });
    expect(getById).toHaveBeenCalledWith("ws1");
    expect(getStats).toHaveBeenCalledWith({
      workspaceId: "ws1",
      since: "2026-05-07T00:00:00.000Z",
      until: "2026-05-14T00:00:00.000Z",
      excludeAgentTargets: ["inspector", "cli"]
    });
  });

  it("normalizes empty / missing query params to null and undefined", async () => {
    const getStats = vi.fn().mockResolvedValue(SAMPLE_STATS);
    const getById = vi.fn().mockResolvedValue({ workspace_id: "ws1" });
    const app = buildApp({
      workspaceService: { getById },
      recallUtilizationService: { getStats }
    });

    const response = await app.request(
      "/workspaces/ws1/recall-stats?since=&excludeAgentTargets="
    );
    expect(response.status).toBe(200);
    expect(getStats).toHaveBeenCalledWith({
      workspaceId: "ws1",
      since: null,
      until: null,
      excludeAgentTargets: undefined
    });
  });

  it("returns 404 when the workspace is not found", async () => {
    const getStats = vi.fn();
    const getById = vi.fn().mockRejectedValue(
      new CoreError("NOT_FOUND", "workspace ws-missing not found")
    );
    const app = buildApp({
      workspaceService: { getById },
      recallUtilizationService: { getStats }
    });

    const response = await app.request("/workspaces/ws-missing/recall-stats");
    expect(response.status).toBe(404);
    expect(getStats).not.toHaveBeenCalled();
  });
});
