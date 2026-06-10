import { describe, expect, it, vi } from "vitest";
import {
  DirectionBias,
  ManifestationPreference,
  PathGovernanceClass,
  StabilityClass,
  type PathGraphSnapshot,
  type PathRelation
} from "@do-soul/alaya-protocol";
import { GraphContractService } from "../../graph-contract-service.js";

describe("GraphContractService", () => {
  it("derives a read-only path graph contract from active PathRelation data", async () => {
    const relation = createPathRelation();
    const service = new GraphContractService({
      pathRelationRepo: {
        findActive: vi.fn(async () => [relation])
      },
      snapshotHistory: {
        findHistory: vi.fn(async () => [createSnapshot("latest", 2), createSnapshot("baseline", 1)])
      },
      now: () => new Date("2026-05-02T00:00:00.000Z")
    });

    const graph = await service.derive("workspace-1");

    expect(graph).toMatchObject({
      contract_version: 1,
      workspace_id: "workspace-1",
      generated_at: "2026-05-02T00:00:00.000Z",
      topology: {
        total_nodes: 2,
        total_edges: 1,
        max_out_degree: 1,
        max_in_degree: 1,
        avg_degree: 1,
        strongly_connected_components: 2
      },
      snapshot_trend: {
        snapshot_count: 2,
        latest_snapshot_id: "latest",
        baseline_snapshot_id: "baseline",
        edge_count_trend: "growing",
        avg_strength_trend: "stable"
      }
    });
    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toMatchObject({
      id: "path-1",
      relation_kind: "supports",
      strength: 0.55,
      direction_bias: DirectionBias.SOURCE_TO_TARGET,
      stability_class: StabilityClass.NORMAL,
      governance_class: PathGovernanceClass.RECALL_ALLOWED,
      effect_vector: relation.effect_vector,
      created_at: relation.created_at,
      updated_at: relation.updated_at
    });
    expect(graph.edges[0]!.source_anchor).toEqual(relation.anchors.source_anchor);
    expect(graph.edges[0]!.target_anchor).toEqual(relation.anchors.target_anchor);
    expect(graph.edges[0]!.relation.lifecycle).toEqual(relation.lifecycle);
    expect(graph.edges[0]!.relation.legitimacy.evidence_basis).toEqual(["evidence-1", "evidence-2"]);
  });

  it("omits optional snapshot trend when history reads fail", async () => {
    const service = new GraphContractService({
      pathRelationRepo: {
        findActive: vi.fn(async () => [])
      },
      snapshotHistory: {
        findHistory: vi.fn(async () => {
          throw new Error("history unavailable");
        })
      },
      now: () => new Date("2026-05-02T00:00:00.000Z")
    });

    const graph = await service.derive("workspace-1");

    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
    expect(graph.topology).toEqual({
      total_nodes: 0,
      total_edges: 0,
      max_out_degree: 0,
      max_in_degree: 0,
      avg_degree: 0,
      strongly_connected_components: 0
    });
    expect(graph.snapshot_trend).toBeUndefined();
  });

  it("rereads the active PathRelation set for every derivation", async () => {
    let relations = [createPathRelation()];
    const service = new GraphContractService({
      pathRelationRepo: {
        findActive: vi.fn(async () => relations)
      },
      now: () => new Date("2026-05-02T00:00:00.000Z")
    });

    await expect(service.derive("workspace-1")).resolves.toMatchObject({
      topology: {
        total_edges: 1,
        strongly_connected_components: 2
      }
    });

    relations = [
      createPathRelation(),
      createPathRelation({
        path_id: "path-2",
        anchors: {
          source_anchor: {
            kind: "object_facet",
            object_id: "object-2",
            facet_key: "status"
          },
          target_anchor: {
            kind: "object",
            object_id: "object-1"
          }
        }
      })
    ];

    await expect(service.derive("workspace-1")).resolves.toMatchObject({
      topology: {
        total_edges: 2,
        strongly_connected_components: 1
      }
    });

    relations = [];

    await expect(service.derive("workspace-1")).resolves.toMatchObject({
      topology: {
        total_edges: 0,
        strongly_connected_components: 0
      }
    });
  });
});

function createPathRelation(overrides: Partial<PathRelation> = {}): PathRelation {
  return {
    path_id: "path-1",
    workspace_id: "workspace-1",
    anchors: {
      source_anchor: {
        kind: "object",
        object_id: "object-1"
      },
      target_anchor: {
        kind: "object_facet",
        object_id: "object-2",
        facet_key: "status"
      }
    },
    constitution: {
      relation_kind: "supports",
      why_this_relation_exists: ["reinforced_by_history", "governed_path"]
    },
    effect_vector: {
      salience: 0.7,
      recall_bias: 0.6,
      verification_bias: 0.4,
      unfinishedness_bias: 0.2,
      default_manifestation_preference: ManifestationPreference.STANCE_BIAS
    },
    plasticity_state: {
      strength: 0.55,
      direction_bias: DirectionBias.SOURCE_TO_TARGET,
      stability_class: StabilityClass.NORMAL,
      support_events_count: 3,
      contradiction_events_count: 1,
      last_reinforced_at: "2026-05-02T00:00:00.000Z",
      last_weakened_at: "2026-05-02T00:00:00.000Z"
    },
    lifecycle: {
      retirement_rule: "retire_after_cooldown",
      cooldown_rule: "7d_without_support",
      override_rule: "manual_override"
    },
    legitimacy: {
      evidence_basis: ["evidence-1", "evidence-2"],
      governance_class: PathGovernanceClass.RECALL_ALLOWED
    },
    created_at: "2026-05-02T00:00:00.000Z",
    updated_at: "2026-05-02T00:00:00.000Z",
    ...overrides
  };
}

function createSnapshot(snapshotId: string, activePaths: number): PathGraphSnapshot {
  return {
    snapshot_id: snapshotId,
    workspace_id: "workspace-1",
    total_active_paths: activePaths,
    strength_distribution: {
      very_weak: 0,
      weak: 0,
      moderate: activePaths,
      strong: 0,
      very_strong: 0
    },
    stability_distribution: {
      volatile: 0,
      normal: activePaths,
      stable: 0,
      pinned: 0
    },
    governance_distribution: {
      hint_only: 0,
      attention_only: 0,
      recall_allowed: activePaths,
      strictly_governed: 0
    },
    connectivity: {
      unique_source_anchors: activePaths,
      unique_target_anchors: activePaths,
      max_out_degree: activePaths,
      max_in_degree: activePaths,
      isolated_anchors: 0
    },
    paths_reinforced_since_last: 0,
    paths_weakened_since_last: 0,
    paths_created_since_last: activePaths,
    snapshot_at: "2026-05-02T00:00:00.000Z"
  };
}
