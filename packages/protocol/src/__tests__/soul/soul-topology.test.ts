import { describe, expect, it } from "vitest";
import type { TopologyExplorationResult } from "../../index.js";

const validTimestamp = "2026-04-21T08:00:00.000Z";

describe("SOUL topology protocol schemas", () => {
  it("parses topology trend and exploration results", async () => {
    const protocol = (await import("../../" + "index.js")) as Record<string, unknown>;
    const TopologyTrendSchema = protocol.TopologyTrendSchema as { parse: (value: unknown) => unknown };
    const TopologyExplorationResultSchema = protocol.TopologyExplorationResultSchema as {
      parse: (value: unknown) => unknown;
    };

    const trend = {
      snapshot_count: 3,
      edge_count_trend: "growing",
      avg_strength_trend: "increasing"
    } as const;
    const result: TopologyExplorationResult = {
      exploration_id: "topology-explore:workspace-1:2026-04-21T08:00:00.000Z",
      workspace_id: "workspace-1",
      total_nodes: 2,
      total_edges: 1,
      max_out_degree: 1,
      max_in_degree: 1,
      avg_degree: 1,
      strongly_connected_components: 2,
      trend,
      explored_at: validTimestamp
    };

    expect(TopologyTrendSchema.parse(trend)).toEqual(trend);
    expect(TopologyExplorationResultSchema.parse(result)).toEqual(result);
  });

  it("rejects malformed topology shapes", async () => {
    const protocol = (await import("../../" + "index.js")) as Record<string, unknown>;
    const TopologyTrendSchema = protocol.TopologyTrendSchema as { parse: (value: unknown) => unknown };
    const TopologyExplorationResultSchema = protocol.TopologyExplorationResultSchema as {
      parse: (value: unknown) => unknown;
    };

    expect(() =>
      TopologyTrendSchema.parse({
        snapshot_count: 3,
        edge_count_trend: "upward",
        avg_strength_trend: "increasing"
      })
    ).toThrow();

    expect(() =>
      TopologyExplorationResultSchema.parse({
        exploration_id: "topology-explore:workspace-1:2026-04-21T08:00:00.000Z",
        workspace_id: "workspace-1",
        total_nodes: 2,
        total_edges: 1,
        max_out_degree: 1,
        max_in_degree: 1,
        avg_degree: 1,
        strongly_connected_components: 2,
        trend: {
          snapshot_count: 3,
          edge_count_trend: "upward",
          avg_strength_trend: "increasing"
        },
        explored_at: validTimestamp
      })
    ).toThrow();
  });
});
