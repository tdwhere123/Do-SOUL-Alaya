import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { registerPathGraphRoutes } from "../../routes/path-graph.js";
import {
  GraphContractService,
  type GraphContractServicePathRelationRepoPort
} from "@do-soul/alaya-core";
import type { PathRelation, SoulPathGraphContract } from "@do-soul/alaya-protocol";

// anti-patterns-lint-allow: per-file PathRelation fixture builders are the
// repo convention (soul-graph-service.test.ts, graph-contract-service.test.ts
// each define their own); there is no exported shared builder to reuse, and
// exporting one would couple unrelated test files.
function makePathRelation(overrides: {
  readonly pathId: string;
  readonly sourceObjectId: string;
  readonly targetObjectId: string;
}): Readonly<PathRelation> {
  return Object.freeze({
    path_id: overrides.pathId,
    workspace_id: "ws-1",
    anchors: {
      source_anchor: { kind: "object", object_id: overrides.sourceObjectId },
      target_anchor: { kind: "object", object_id: overrides.targetObjectId }
    },
    constitution: {
      relation_kind: "supports",
      why_this_relation_exists: ["test edge"]
    },
    effect_vector: {
      salience: 0.5,
      recall_bias: 0.5,
      verification_bias: 0,
      unfinishedness_bias: 0,
      default_manifestation_preference: "stance_bias"
    },
    plasticity_state: {
      strength: 0.7,
      direction_bias: "source_to_target",
      stability_class: "stable",
      support_events_count: 2,
      contradiction_events_count: 0,
      last_reinforced_at: "2026-05-05T02:00:00.000Z"
    },
    lifecycle: { status: "active", retirement_rule: "default" },
    legitimacy: { evidence_basis: ["evidence-1"], governance_class: "recall_allowed" },
    created_at: "2026-05-05T01:00:00.000Z",
    updated_at: "2026-05-05T02:00:00.000Z"
  }) as Readonly<PathRelation>;
}

describe("path graph routes", () => {
  it("serves a BuiltPathGraph derived from the workspace path_relations plane", async () => {
    const app = new Hono();
    const relations = [
      makePathRelation({ pathId: "path-1", sourceObjectId: "mem-1", targetObjectId: "mem-2" }),
      makePathRelation({ pathId: "path-2", sourceObjectId: "mem-2", targetObjectId: "mem-3" })
    ];
    const pathRelationRepo: GraphContractServicePathRelationRepoPort = {
      findActive: vi.fn(async (workspaceId: string) =>
        workspaceId === "ws-1" ? relations : []
      )
    };
    const graphContractService = new GraphContractService({ pathRelationRepo });
    const workspaceService = {
      getById: vi.fn(async () => ({ workspace_id: "ws-1" }))
    };

    registerPathGraphRoutes(app, { workspaceService, graphContractService });

    const response = await app.request("/workspaces/ws-1/path-graph");

    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean; data: SoulPathGraphContract };
    expect(body.success).toBe(true);
    expect(workspaceService.getById).toHaveBeenCalledWith("ws-1");
    expect(pathRelationRepo.findActive).toHaveBeenCalledWith("ws-1");

    const graph = body.data;
    expect(graph.contract_version).toBe(1);
    expect(graph.workspace_id).toBe("ws-1");
    // 3 distinct object anchors (mem-1, mem-2, mem-3) → 3 nodes.
    expect(graph.nodes).toHaveLength(3);
    // 2 active path relations → 2 edges, ids carry the path_id.
    expect(graph.edges.map((edge) => edge.id).sort()).toEqual(["path-1", "path-2"]);
    expect(graph.topology.total_nodes).toBe(3);
    expect(graph.topology.total_edges).toBe(2);
    const firstEdge = graph.edges.find((edge) => edge.id === "path-1");
    expect(firstEdge?.relation_kind).toBe("supports");
    expect(firstEdge?.strength).toBe(0.7);
    expect(firstEdge?.relation.plasticity_state.last_reinforced_at).toBe(
      "2026-05-05T02:00:00.000Z"
    );
  });

  it("is workspace-scoped: an empty workspace yields an empty graph", async () => {
    const app = new Hono();
    const pathRelationRepo: GraphContractServicePathRelationRepoPort = {
      findActive: vi.fn(async () => [])
    };
    const graphContractService = new GraphContractService({ pathRelationRepo });
    const workspaceService = { getById: vi.fn(async () => ({ workspace_id: "ws-2" })) };

    registerPathGraphRoutes(app, { workspaceService, graphContractService });

    const response = await app.request("/workspaces/ws-2/path-graph");

    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean; data: SoulPathGraphContract };
    expect(pathRelationRepo.findActive).toHaveBeenCalledWith("ws-2");
    expect(body.data.nodes).toHaveLength(0);
    expect(body.data.edges).toHaveLength(0);
    expect(body.data.topology.total_nodes).toBe(0);
    expect(body.data.topology.total_edges).toBe(0);
  });
});
