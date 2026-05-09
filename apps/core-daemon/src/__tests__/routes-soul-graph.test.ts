import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { registerSoulGraphRoutes } from "../routes/soul-graph.js";
import type { SoulGraph } from "@do-soul/alaya-protocol";

describe("soul graph routes", () => {
  it("returns additive Inspector graph fields through the daemon route", async () => {
    const app = new Hono();
    const graph: SoulGraph = {
      workspace_id: "ws-1",
      nodes: [
        {
          id: "memory-1",
          kind: "memory",
          label: "Memory one",
          origin_kind: "user_memory",
          evidence_refs: ["evidence-1"],
          confidence: 0.8,
          last_used_at: "2026-05-05T01:00:00.000Z",
          influence_count: 3
        }
      ],
      edges: [
        {
          id: "path-1",
          kind: "references",
          source_id: "memory-1",
          target_id: "memory-2",
          weight: 0.7,
          strength_normalized: 0.7,
          stability_class: "stable",
          last_reinforced_at: "2026-05-05T02:00:00.000Z"
        }
      ],
      truncated: false,
      node_total: 1,
      edge_total: 1
    };
    const workspaceService = {
      getById: vi.fn(async () => ({ workspace_id: "ws-1" }))
    };
    const soulGraphService = {
      buildSoulGraph: vi.fn(async () => graph)
    };

    registerSoulGraphRoutes(app, { workspaceService, soulGraphService });

    const response = await app.request("/workspaces/ws-1/soul/graph");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true, data: graph });
    expect(workspaceService.getById).toHaveBeenCalledWith("ws-1");
    expect(soulGraphService.buildSoulGraph).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      depth: 2,
      limit: 500
    });
  });
});
