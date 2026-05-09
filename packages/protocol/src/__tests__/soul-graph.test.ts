import { describe, expect, it } from "vitest";
import {
  DEFAULT_SOUL_GRAPH_DEPTH,
  DEFAULT_SOUL_GRAPH_LIMIT,
  MAX_SOUL_GRAPH_LIMIT,
  MIN_SOUL_GRAPH_DEPTH,
  parseSoulGraphDepth,
  parseSoulGraphLimit,
  SoulPathGraphContractSchema,
  SoulGraphEdgeSchema,
  SoulGraphNodeSchema,
  SoulGraphOriginPlaneSchema,
  SoulGraphSchema
} from "../soul/graph.js";
import {
  DirectionBias,
  ManifestationPreference,
  PathGovernanceClass,
  StabilityClass
} from "../soul/path-relation.js";

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
      origin_plane: "project",
      origin_kind: "user_memory",
      evidence_refs: ["evidence:1"],
      rationale: "User explicitly confirmed this preference.",
      confidence: 0.72,
      last_used_at: "2026-04-24T12:00:00.000Z",
      last_hit_at: "2026-04-25T12:00:00.000Z",
      influence_count: 14
    });
    const edge = SoulGraphEdgeSchema.parse({
      id: "edge:memory-1:scope-project",
      kind: "belongs_to",
      source_id: "memory:memory-1",
      target_id: "scope:project",
      weight: 0.6,
      strength_normalized: 0.6,
      stability_class: "stable",
      last_reinforced_at: "2026-04-24T12:00:00.000Z",
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

  it("keeps graph metadata additive and strict", () => {
    expect(
      SoulGraphNodeSchema.parse({
        id: "memory:legacy",
        kind: "memory",
        label: "Legacy client-visible node"
      })
    ).toEqual({
      id: "memory:legacy",
      kind: "memory",
      label: "Legacy client-visible node"
    });
    expect(
      SoulGraphEdgeSchema.parse({
        id: "edge:legacy",
        kind: "references",
        source_id: "memory:1",
        target_id: "memory:2"
      })
    ).toEqual({
      id: "edge:legacy",
      kind: "references",
      source_id: "memory:1",
      target_id: "memory:2"
    });

    expect(() =>
      SoulGraphNodeSchema.parse({
        id: "memory:bad",
        kind: "memory",
        label: "bad",
        origin_kind: "manual"
      })
    ).toThrow();
    expect(() =>
      SoulGraphEdgeSchema.parse({
        id: "edge:bad",
        kind: "references",
        source_id: "memory:1",
        target_id: "memory:2",
        strength_normalized: 1.2
      })
    ).toThrow();
    expect(() =>
      SoulGraphNodeSchema.parse({
        id: "memory:bad",
        kind: "memory",
        label: "bad",
        unexpected: true
      })
    ).toThrow();
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

  it("parses the path graph contract without losing PathRelation fidelity", () => {
    const relation = createPathRelation();
    const parsed = SoulPathGraphContractSchema.parse({
      contract_version: 1,
      workspace_id: "workspace-1",
      generated_at: "2026-05-02T00:00:00.000Z",
      nodes: [
        {
          id: "[\"object\",\"object-1\"]",
          anchor: relation.anchors.source_anchor,
          label: "[\"object\",\"object-1\"]",
          out_degree: 1,
          in_degree: 0
        },
        {
          id: "[\"object_facet\",\"object-2\",\"status\"]",
          anchor: relation.anchors.target_anchor,
          label: "[\"object_facet\",\"object-2\",\"status\"]",
          out_degree: 0,
          in_degree: 1
        }
      ],
      edges: [
        {
          id: relation.path_id,
          source_id: "[\"object\",\"object-1\"]",
          target_id: "[\"object_facet\",\"object-2\",\"status\"]",
          source_anchor: relation.anchors.source_anchor,
          target_anchor: relation.anchors.target_anchor,
          relation_kind: relation.constitution.relation_kind,
          strength: relation.plasticity_state.strength,
          direction_bias: relation.plasticity_state.direction_bias,
          stability_class: relation.plasticity_state.stability_class,
          governance_class: relation.legitimacy.governance_class,
          effect_vector: relation.effect_vector,
          relation,
          created_at: relation.created_at,
          updated_at: relation.updated_at
        }
      ],
      topology: {
        total_nodes: 2,
        total_edges: 1,
        max_out_degree: 1,
        max_in_degree: 1,
        avg_degree: 1,
        strongly_connected_components: 2
      },
      snapshot_trend: {
        snapshot_count: 1,
        latest_snapshot_id: "snapshot-1",
        baseline_snapshot_id: "snapshot-1",
        latest_snapshot_at: "2026-05-02T00:00:00.000Z",
        baseline_snapshot_at: "2026-05-02T00:00:00.000Z",
        edge_count_trend: "stable",
        avg_strength_trend: "stable",
        latest_snapshot: createSnapshot()
      }
    });

    const edge = parsed.edges[0]!;
    expect(edge.relation_kind).toBe("supports");
    expect(edge.source_anchor).toEqual(relation.anchors.source_anchor);
    expect(edge.target_anchor).toEqual(relation.anchors.target_anchor);
    expect(edge.strength).toBe(0.55);
    expect(edge.direction_bias).toBe(DirectionBias.SOURCE_TO_TARGET);
    expect(edge.stability_class).toBe(StabilityClass.NORMAL);
    expect(edge.governance_class).toBe(PathGovernanceClass.RECALL_ALLOWED);
    expect(edge.relation.lifecycle).toEqual(relation.lifecycle);
    expect(edge.relation.legitimacy.evidence_basis).toEqual(["evidence-1", "evidence-2"]);
    expect(edge.created_at).toBe(relation.created_at);
    expect(edge.updated_at).toBe(relation.updated_at);
  });
});

function createPathRelation() {
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
    updated_at: "2026-05-02T00:00:00.000Z"
  } as const;
}

function createSnapshot() {
  return {
    snapshot_id: "snapshot-1",
    workspace_id: "workspace-1",
    total_active_paths: 1,
    total_retired_paths: 0,
    strength_distribution: {
      very_weak: 0,
      weak: 0,
      moderate: 1,
      strong: 0,
      very_strong: 0
    },
    stability_distribution: {
      volatile: 0,
      normal: 1,
      stable: 0,
      pinned: 0
    },
    governance_distribution: {
      hint_only: 0,
      attention_only: 0,
      recall_allowed: 1,
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
    paths_retired_since_last: 0,
    paths_created_since_last: 1,
    snapshot_at: "2026-05-02T00:00:00.000Z"
  } as const;
}
