import { describe, expect, it, vi } from "vitest";
import type { PathGraphSnapshot, PathRelation } from "@do-soul/alaya-protocol";
import {
  PathGraphSnapshotter,
  reviewPathGraphSnapshotHistory
} from "../garden/path-graph-snapshotter.js";

describe("PathGraphSnapshotter", () => {
  it("uses findActive and builds a zeroed snapshot for an empty workspace", async () => {
    const pathRelationRepo = {
      findActive: vi.fn(async () => [] as const),
      findByWorkspace: vi.fn(async () => {
        throw new Error("findByWorkspace should not be used for active snapshot reads");
      })
    };
    const snapshotter = new PathGraphSnapshotter({
      pathRelationRepo,
      now: () => new Date("2026-04-17T01:00:00.000Z")
    });

    await expect(snapshotter.buildSnapshot("workspace-1")).resolves.toEqual({
      snapshot_id: "path-graph-snapshot:workspace-1:2026-04-17T01:00:00.000Z",
      workspace_id: "workspace-1",
      total_active_paths: 0,
      strength_distribution: {
        very_weak: 0,
        weak: 0,
        moderate: 0,
        strong: 0,
        very_strong: 0
      },
      stability_distribution: {
        volatile: 0,
        normal: 0,
        stable: 0,
        pinned: 0
      },
      governance_distribution: {
        hint_only: 0,
        attention_only: 0,
        recall_allowed: 0,
        strictly_governed: 0
      },
      connectivity: {
        unique_source_anchors: 0,
        unique_target_anchors: 0,
        max_out_degree: 0,
        max_in_degree: 0,
        isolated_anchors: 0
      },
      paths_reinforced_since_last: 0,
      paths_weakened_since_last: 0,
      paths_created_since_last: 0,
      snapshot_at: "2026-04-17T01:00:00.000Z"
    });
    expect(pathRelationRepo.findActive).toHaveBeenCalledWith("workspace-1");
    expect(pathRelationRepo.findByWorkspace).not.toHaveBeenCalled();
  });

  it("computes distributions, connectivity, and first-snapshot lifecycle counts from active paths", async () => {
    const relations = [
      createPathRelationFixture({
        path_id: "path-weak",
        anchors: {
          source_anchor: { kind: "object", object_id: "anchor-a" },
          target_anchor: { kind: "object", object_id: "anchor-b" }
        },
        plasticity_state: {
          strength: 0.15,
          direction_bias: "source_to_target",
          stability_class: "volatile",
          support_events_count: 1,
          contradiction_events_count: 0,
          last_reinforced_at: "2026-04-17T00:01:00.000Z"
        },
        legitimacy: {
          evidence_basis: ["evidence-1"],
          governance_class: "hint_only"
        }
      }),
      createPathRelationFixture({
        path_id: "path-moderate",
        anchors: {
          source_anchor: { kind: "object", object_id: "anchor-a" },
          target_anchor: { kind: "object", object_id: "anchor-c" }
        },
        plasticity_state: {
          strength: 0.55,
          direction_bias: "source_to_target",
          stability_class: "normal",
          support_events_count: 0,
          contradiction_events_count: 1,
          last_weakened_at: "2026-04-17T00:02:00.000Z"
        },
        legitimacy: {
          evidence_basis: ["evidence-2"],
          governance_class: "attention_only"
        }
      }),
      createPathRelationFixture({
        path_id: "path-strong",
        anchors: {
          source_anchor: { kind: "object", object_id: "anchor-d" },
          target_anchor: { kind: "object", object_id: "anchor-a" }
        },
        plasticity_state: {
          strength: 0.92,
          direction_bias: "source_to_target",
          stability_class: "pinned",
          support_events_count: 4,
          contradiction_events_count: 0,
          last_reinforced_at: "2026-04-17T00:03:00.000Z"
        },
        legitimacy: {
          evidence_basis: ["evidence-3"],
          governance_class: "strictly_governed"
        }
      })
    ] as const;
    const snapshotter = new PathGraphSnapshotter({
      pathRelationRepo: {
        findActive: vi.fn(async () => relations)
      },
      now: () => new Date("2026-04-17T01:00:00.000Z")
    });

    await expect(snapshotter.buildSnapshot("workspace-1")).resolves.toEqual({
      snapshot_id: "path-graph-snapshot:workspace-1:2026-04-17T01:00:00.000Z",
      workspace_id: "workspace-1",
      total_active_paths: 3,
      strength_distribution: {
        very_weak: 1,
        weak: 0,
        moderate: 1,
        strong: 0,
        very_strong: 1
      },
      stability_distribution: {
        volatile: 1,
        normal: 1,
        stable: 0,
        pinned: 1
      },
      governance_distribution: {
        hint_only: 1,
        attention_only: 1,
        recall_allowed: 0,
        strictly_governed: 1
      },
      connectivity: {
        unique_source_anchors: 2,
        unique_target_anchors: 3,
        max_out_degree: 2,
        max_in_degree: 1,
        isolated_anchors: 3
      },
      paths_reinforced_since_last: 3,
      paths_weakened_since_last: 3,
      paths_created_since_last: 3,
      snapshot_at: "2026-04-17T01:00:00.000Z"
    });
  });

  it("derives since-last deltas from current active relations and resets reserved retirement metrics", async () => {
    const previousSnapshot = createSnapshotFixture({
      snapshot_id: "snapshot-previous",
      total_active_paths: 3,
      snapshot_at: "2026-04-17T00:30:00.000Z"
    });
    const relations = [
      createPathRelationFixture({
        path_id: "path-existing",
        created_at: "2026-04-17T00:10:00.000Z",
        updated_at: "2026-04-17T00:40:00.000Z",
        plasticity_state: {
          strength: 0.45,
          direction_bias: "source_to_target",
          stability_class: "normal",
          support_events_count: 3,
          contradiction_events_count: 1,
          last_reinforced_at: "2026-04-17T00:35:00.000Z",
          last_weakened_at: "2026-04-17T00:36:00.000Z"
        }
      }),
      createPathRelationFixture({
        path_id: "path-created",
        created_at: "2026-04-17T00:50:00.000Z",
        updated_at: "2026-04-17T00:50:00.000Z",
        anchors: {
          source_anchor: { kind: "object", object_id: "anchor-created" },
          target_anchor: { kind: "object", object_id: "anchor-target" }
        },
        plasticity_state: {
          strength: 0.88,
          direction_bias: "source_to_target",
          stability_class: "stable",
          support_events_count: 1,
          contradiction_events_count: 0,
          last_reinforced_at: "2026-04-17T00:50:00.000Z"
        },
        legitimacy: {
          evidence_basis: ["evidence-created"],
          governance_class: "recall_allowed"
        }
      }),
      createPathRelationFixture({
        path_id: "path-existing-2",
        created_at: "2026-04-17T00:20:00.000Z",
        updated_at: "2026-04-17T00:25:00.000Z",
        anchors: {
          source_anchor: { kind: "object", object_id: "anchor-existing-2" },
          target_anchor: { kind: "object", object_id: "anchor-existing-3" }
        },
        plasticity_state: {
          strength: 0.22,
          direction_bias: "source_to_target",
          stability_class: "volatile",
          support_events_count: 1,
          contradiction_events_count: 0,
          last_reinforced_at: "2026-04-17T00:21:00.000Z"
        }
      })
    ] as const;
    const snapshotter = new PathGraphSnapshotter({
      pathRelationRepo: {
        findActive: vi.fn(async () => relations)
      },
      now: () => new Date("2026-04-17T01:00:00.000Z")
    });

    const snapshot = await snapshotter.buildSnapshot("workspace-1", previousSnapshot);

    expect(snapshot.paths_created_since_last).toBe(1);
    expect(snapshot.paths_reinforced_since_last).toBe(2);
    expect(snapshot.paths_weakened_since_last).toBe(1);
    expect(snapshot.total_active_paths).toBe(3);
  });
});

describe("reviewPathGraphSnapshotHistory", () => {
  it("returns a history review note when isolated anchors increase", () => {
    const review = reviewPathGraphSnapshotHistory("workspace-1", [
      createSnapshotFixture({
        snapshot_id: "snapshot-latest",
        connectivity: {
          unique_source_anchors: 3,
          unique_target_anchors: 3,
          max_out_degree: 2,
          max_in_degree: 2,
          isolated_anchors: 4
        },
        snapshot_at: "2026-04-17T00:15:00.000Z"
      }),
      createSnapshotFixture({
        snapshot_id: "snapshot-previous",
        connectivity: {
          unique_source_anchors: 3,
          unique_target_anchors: 3,
          max_out_degree: 2,
          max_in_degree: 2,
          isolated_anchors: 2
        },
        snapshot_at: "2026-04-17T00:00:00.000Z"
      })
    ]);

    expect(review).toEqual({
      summary: "Path graph isolation drift detected for workspace-1",
      detail_json: {
        latest_snapshot_id: "snapshot-latest",
        previous_snapshot_id: "snapshot-previous",
        latest_snapshot_at: "2026-04-17T00:15:00.000Z",
        previous_snapshot_at: "2026-04-17T00:00:00.000Z",
        isolated_anchor_delta: 2,
        isolated_anchor_count: 4,
        total_active_paths: 3
      }
    });
  });

  it("ignores retired-count changes when isolated anchors do not increase", () => {
    const review = reviewPathGraphSnapshotHistory("workspace-1", [
      createSnapshotFixture({
        snapshot_id: "snapshot-latest",
        connectivity: {
          unique_source_anchors: 2,
          unique_target_anchors: 3,
          max_out_degree: 2,
          max_in_degree: 1,
          isolated_anchors: 2
        },
        snapshot_at: "2026-04-17T00:15:00.000Z"
      }),
      createSnapshotFixture({
        snapshot_id: "snapshot-previous",
        connectivity: {
          unique_source_anchors: 2,
          unique_target_anchors: 3,
          max_out_degree: 2,
          max_in_degree: 1,
          isolated_anchors: 2
        },
        snapshot_at: "2026-04-17T00:00:00.000Z"
      })
    ]);

    expect(review).toBeNull();
  });
});

function createSnapshotFixture(overrides: Partial<PathGraphSnapshot> = {}): PathGraphSnapshot {
  return {
    snapshot_id: "snapshot-1",
    workspace_id: "workspace-1",
    total_active_paths: 3,
    strength_distribution: {
      very_weak: 0,
      weak: 1,
      moderate: 1,
      strong: 1,
      very_strong: 0
    },
    stability_distribution: {
      volatile: 1,
      normal: 1,
      stable: 1,
      pinned: 0
    },
    governance_distribution: {
      hint_only: 1,
      attention_only: 1,
      recall_allowed: 1,
      strictly_governed: 0
    },
    connectivity: {
      unique_source_anchors: 2,
      unique_target_anchors: 3,
      max_out_degree: 2,
      max_in_degree: 1,
      isolated_anchors: 2
    },
    paths_reinforced_since_last: 2,
    paths_weakened_since_last: 1,
    paths_created_since_last: 3,
    snapshot_at: "2026-04-17T00:05:00.000Z",
    ...overrides
  };
}

function createPathRelationFixture(overrides: Partial<PathRelation> = {}): PathRelation {
  return {
    path_id: "path-1",
    workspace_id: "workspace-1",
    anchors: {
      source_anchor: { kind: "object", object_id: "source-1" },
      target_anchor: { kind: "object", object_id: "target-1" }
    },
    constitution: {
      relation_kind: "supports",
      why_this_relation_exists: ["fixture"]
    },
    effect_vector: {
      salience: 0.3,
      recall_bias: 0.4,
      verification_bias: 0.2,
      unfinishedness_bias: 0.1,
      default_manifestation_preference: "stance_bias"
    },
    plasticity_state: {
      strength: 0.3,
      direction_bias: "source_to_target",
      stability_class: "volatile",
      support_events_count: 1,
      contradiction_events_count: 0,
      last_reinforced_at: "2026-04-17T00:01:00.000Z"
    },
    lifecycle: {
      retirement_rule: "retire_after_cooldown"
    },
    legitimacy: {
      evidence_basis: ["evidence-1"],
      governance_class: "hint_only"
    },
    created_at: "2026-04-17T00:00:00.000Z",
    updated_at: "2026-04-17T00:00:00.000Z",
    ...overrides
  };
}
