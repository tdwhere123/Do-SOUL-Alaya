import { describe, expect, it } from "vitest";
import {
  DEFAULT_SOUL_GRAPH_DEPTH,
  DEFAULT_SOUL_GRAPH_LIMIT,
  MAX_SOUL_GRAPH_LIMIT,
  MIN_SOUL_GRAPH_DEPTH,
  parseSoulGraphDepth,
  parseSoulGraphLimit,
  SoulGraphEdgeSchema,
  SoulGraphNodeSchema,
  SoulGraphOriginPlaneSchema,
  SoulGraphSchema
} from "../soul/graph.js";

describe("Soul graph protocol schemas", () => {
  it("parses graph nodes, edges, and graph envelopes", () => {
    const node = SoulGraphNodeSchema.parse({
      id: "memory:memory-1",
      kind: "memory",
      label: "Remember operator preferences",
      summary: "procedure · project",
      scope_id: "scope:project",
      workspace_id: "workspace-1",
      created_at: "2026-04-23T12:00:00.000Z",
      origin_plane: "project"
    });
    const edge = SoulGraphEdgeSchema.parse({
      id: "edge:memory-1:scope-project",
      kind: "belongs_to",
      source_id: "memory:memory-1",
      target_id: "scope:project",
      created_at: "2026-04-23T12:00:00.000Z"
    });

    expect(SoulGraphOriginPlaneSchema.parse("global")).toBe("global");
    expect(
      SoulGraphSchema.parse({
        workspace_id: "workspace-1",
        nodes: [
          node,
          {
            id: "scope:project",
            kind: "scope",
            label: "project"
          }
        ],
        edges: [edge],
        truncated: false,
        node_total: 2,
        edge_total: 1
      })
    ).toEqual({
      workspace_id: "workspace-1",
      nodes: [
        node,
        {
          id: "scope:project",
          kind: "scope",
          label: "project"
        }
      ],
      edges: [edge],
      truncated: false,
      node_total: 2,
      edge_total: 1
    });
  });

  it("rejects invalid kinds and origin planes", () => {
    expect(() =>
      SoulGraphNodeSchema.parse({
        id: "memory:memory-1",
        kind: "global_memory",
        label: "invalid"
      })
    ).toThrow();
    expect(() =>
      SoulGraphNodeSchema.parse({
        id: "memory:memory-1",
        kind: "memory",
        label: "invalid",
        origin_plane: "workspace_local"
      })
    ).toThrow();
    expect(() =>
      SoulGraphEdgeSchema.parse({
        id: "edge-1",
        kind: "supports",
        source_id: "memory:memory-1",
        target_id: "memory:memory-2"
      })
    ).toThrow();
  });

  it("parses soul graph query bounds from the shared protocol contract", () => {
    expect(parseSoulGraphDepth(undefined)).toBe(DEFAULT_SOUL_GRAPH_DEPTH);
    expect(parseSoulGraphDepth(String(MIN_SOUL_GRAPH_DEPTH))).toBe(MIN_SOUL_GRAPH_DEPTH);
    expect(parseSoulGraphLimit(undefined)).toBe(DEFAULT_SOUL_GRAPH_LIMIT);
    expect(parseSoulGraphLimit(String(MAX_SOUL_GRAPH_LIMIT))).toBe(MAX_SOUL_GRAPH_LIMIT);
    expect(() => parseSoulGraphDepth(4)).toThrow("depth must be an integer between 1 and 3");
    expect(() => parseSoulGraphLimit("2001")).toThrow("limit must be an integer between 1 and 2000");
  });
});
