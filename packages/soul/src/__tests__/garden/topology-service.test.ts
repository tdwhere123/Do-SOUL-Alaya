import { describe, expect, it, vi } from "vitest";
import type { PathGraphSnapshot, PathRelation } from "@do-soul/alaya-protocol";
import { TopologyService } from "../../garden/topology-service.js";

describe("TopologyService", () => {
  it("returns an empty derived view without snapshot history", async () => {
    const service = new TopologyService({
      pathRelationRepo: {
        findActive: vi.fn(async () => [] as const)
      },
      now: () => new Date("2026-04-21T08:00:00.000Z")
    });

    await expect(service.explore("workspace-1")).resolves.toEqual({
      exploration_id: "topology-explore:workspace-1:2026-04-21T08:00:00.000Z",
      workspace_id: "workspace-1",
      total_nodes: 0,
      total_edges: 0,
      max_out_degree: 0,
      max_in_degree: 0,
      avg_degree: 0,
      strongly_connected_components: 0,
      explored_at: "2026-04-21T08:00:00.000Z"
    });
  });

  it("derives degrees, SCCs, and trend overlay from active relations and snapshot history", async () => {
    const service = new TopologyService({
      pathRelationRepo: {
        findActive: vi.fn(async () => [
          createPathRelationFixture({
            path_id: "path-a",
            anchors: {
              source_anchor: { kind: "object", object_id: "anchor-a" },
              target_anchor: { kind: "object", object_id: "anchor-b" }
            },
            plasticity_state: {
              strength: 0.4,
              direction_bias: "source_to_target",
              stability_class: "normal",
              support_events_count: 2,
              contradiction_events_count: 0,
              last_reinforced_at: "2026-04-21T07:00:00.000Z"
            },
            legitimacy: {
              evidence_basis: ["evidence-a"],
              governance_class: "attention_only"
            }
          }),
          createPathRelationFixture({
            path_id: "path-b",
            anchors: {
              source_anchor: { kind: "object", object_id: "anchor-b" },
              target_anchor: { kind: "object", object_id: "anchor-a" }
            },
            plasticity_state: {
              strength: 0.7,
              direction_bias: "source_to_target",
              stability_class: "stable",
              support_events_count: 3,
              contradiction_events_count: 0,
              last_reinforced_at: "2026-04-21T07:30:00.000Z"
            },
            legitimacy: {
              evidence_basis: ["evidence-b"],
              governance_class: "recall_allowed"
            }
          }),
          createPathRelationFixture({
            path_id: "path-c",
            anchors: {
              source_anchor: { kind: "object", object_id: "anchor-a" },
              target_anchor: { kind: "object", object_id: "anchor-c" }
            },
            plasticity_state: {
              strength: 0.9,
              direction_bias: "source_to_target",
              stability_class: "pinned",
              support_events_count: 5,
              contradiction_events_count: 0,
              last_reinforced_at: "2026-04-21T07:45:00.000Z"
            },
            legitimacy: {
              evidence_basis: ["evidence-c"],
              governance_class: "strictly_governed"
            }
          })
        ] as const)
      },
      snapshotHistory: {
        getHistory: vi.fn(async () => [
          createSnapshotFixture({
            snapshot_id: "snapshot-latest",
            total_active_paths: 3,
            strength_distribution: {
              very_weak: 0,
              weak: 1,
              moderate: 1,
              strong: 0,
              very_strong: 1
            },
            snapshot_at: "2026-04-21T07:55:00.000Z"
          }),
          createSnapshotFixture({
            snapshot_id: "snapshot-oldest",
            total_active_paths: 1,
            strength_distribution: {
              very_weak: 1,
              weak: 0,
              moderate: 0,
              strong: 0,
              very_strong: 0
            },
            snapshot_at: "2026-04-21T07:00:00.000Z"
          })
        ] as const)
      },
      now: () => new Date("2026-04-21T08:00:00.000Z")
    });

    await expect(service.explore("workspace-1")).resolves.toEqual({
      exploration_id: "topology-explore:workspace-1:2026-04-21T08:00:00.000Z",
      workspace_id: "workspace-1",
      total_nodes: 3,
      total_edges: 3,
      max_out_degree: 2,
      max_in_degree: 1,
      avg_degree: 2,
      strongly_connected_components: 2,
      trend: {
        snapshot_count: 2,
        edge_count_trend: "growing",
        avg_strength_trend: "increasing"
      },
      explored_at: "2026-04-21T08:00:00.000Z"
    });
  });

  it("reflects the current active PathRelation state on each exploration", async () => {
    let relations: readonly Readonly<PathRelation>[] = [
      createPathRelationFixture({
        path_id: "path-a",
        anchors: {
          source_anchor: { kind: "object", object_id: "anchor-a" },
          target_anchor: { kind: "object", object_id: "anchor-b" }
        }
      })
    ];

    const service = new TopologyService({
      pathRelationRepo: {
        findActive: vi.fn(async () => relations)
      },
      now: () => new Date("2026-04-21T08:00:00.000Z")
    });

    await expect(service.explore("workspace-1")).resolves.toMatchObject({
      total_nodes: 2,
      total_edges: 1,
      max_out_degree: 1,
      max_in_degree: 1,
      strongly_connected_components: 2
    });

    relations = [
      ...relations,
      createPathRelationFixture({
        path_id: "path-b",
        anchors: {
          source_anchor: { kind: "object", object_id: "anchor-b" },
          target_anchor: { kind: "object", object_id: "anchor-a" }
        }
      })
    ];

    await expect(service.explore("workspace-1")).resolves.toMatchObject({
      total_nodes: 2,
      total_edges: 2,
      max_out_degree: 1,
      max_in_degree: 1,
      strongly_connected_components: 1
    });

    relations = [];

    await expect(service.explore("workspace-1")).resolves.toMatchObject({
      total_nodes: 0,
      total_edges: 0,
      strongly_connected_components: 0
    });
  });

  it("drops the optional trend overlay when snapshot history is unavailable", async () => {
    const service = new TopologyService({
      pathRelationRepo: {
        findActive: vi.fn(async () => [
          createPathRelationFixture({
            path_id: "path-a",
            anchors: {
              source_anchor: { kind: "object", object_id: "anchor-a" },
              target_anchor: { kind: "object", object_id: "anchor-b" }
            }
          })
        ] as const)
      },
      snapshotHistory: {
        getHistory: vi.fn(async () => {
          throw new Error("snapshot repo unavailable");
        })
      },
      now: () => new Date("2026-04-21T08:00:00.000Z")
    });

    await expect(service.explore("workspace-1")).resolves.toMatchObject({
      workspace_id: "workspace-1",
      total_nodes: 2,
      total_edges: 1,
      strongly_connected_components: 2,
      trend: undefined
    });
  });
});

function createPathRelationFixture(overrides: Partial<PathRelation> = {}): PathRelation {
  return {
    path_id: "path-1",
    workspace_id: "workspace-1",
    anchors: {
      source_anchor: { kind: "object", object_id: "anchor-source" },
      target_anchor: { kind: "object", object_id: "anchor-target" }
    },
    constitution: {
      relation_kind: "supports",
      why_this_relation_exists: ["baseline fixture"]
    },
    effect_vector: {
      salience: 0.4,
      recall_bias: 0.3,
      verification_bias: 0.2,
      unfinishedness_bias: 0.1,
      default_manifestation_preference: "stance_bias"
    },
    plasticity_state: {
      strength: 0.6,
      direction_bias: "source_to_target",
      stability_class: "normal",
      support_events_count: 1,
      contradiction_events_count: 0,
      last_reinforced_at: "2026-04-21T07:00:00.000Z"
    },
    lifecycle: {
      retirement_rule: "never"
    },
    legitimacy: {
      evidence_basis: ["evidence-1"],
      governance_class: "attention_only"
    },
    created_at: "2026-04-21T06:00:00.000Z",
    updated_at: "2026-04-21T07:00:00.000Z",
    ...overrides
  };
}

function createSnapshotFixture(overrides: Partial<PathGraphSnapshot> = {}): PathGraphSnapshot {
  return {
    snapshot_id: "snapshot-1",
    workspace_id: "workspace-1",
    total_active_paths: 1,
    strength_distribution: {
      very_weak: 0,
      weak: 1,
      moderate: 0,
      strong: 0,
      very_strong: 0
    },
    stability_distribution: {
      volatile: 1,
      normal: 0,
      stable: 0,
      pinned: 0
    },
    governance_distribution: {
      hint_only: 1,
      attention_only: 0,
      recall_allowed: 0,
      strictly_governed: 0
    },
    connectivity: {
      unique_source_anchors: 1,
      unique_target_anchors: 1,
      max_out_degree: 1,
      max_in_degree: 1,
      isolated_anchors: 0
    },
    paths_reinforced_since_last: 0,
    paths_weakened_since_last: 0,
    paths_created_since_last: 1,
    snapshot_at: "2026-04-21T07:00:00.000Z",
    ...overrides
  };
}
