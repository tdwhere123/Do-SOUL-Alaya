import { describe, expect, it } from "vitest";
import type { MemoryEntry, PathRelation } from "@do-soul/alaya-protocol";
import { deriveSeedFuelInventory } from "../../longmemeval/seed-fuel-inventory.js";

function memoryEntry(
  overrides: Partial<MemoryEntry> & Pick<MemoryEntry, "object_id">
): MemoryEntry {
  const { object_id, ...rest } = overrides;
  return {
    object_kind: "memory_entry",
    dimension: "fact",
    source_kind: "garden_compile",
    formation_kind: "derived",
    scope_class: "session",
    content: "Alice moved to Berlin for her new job.",
    domain_tags: ["location"],
    evidence_refs: [],
    workspace_id: "ws-1",
    run_id: "run-1",
    surface_id: null,
    storage_tier: "hot",
    activation_score: null,
    retention_score: null,
    manifestation_state: "full_eligible",
    retention_state: null,
    decay_profile: null,
    confidence: 0.9,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: null,
    contradiction_count: null,
    superseded_by: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    object_id,
    ...rest
  } as MemoryEntry;
}

describe("deriveSeedFuelInventory", () => {
  it("counts objects, evidence refs, facet anchors, and support-bearing candidates", () => {
    const inventory = deriveSeedFuelInventory({
      entries: [
        memoryEntry({
          object_id: "mem-a",
          evidence_refs: ["ev-a", "ev-b"],
          facet_tags: [{ facet: "location_place", value: "Berlin" }]
        }),
        memoryEntry({
          object_id: "mem-b",
          content: "She prefers tea over coffee.",
          evidence_refs: []
        })
      ]
    });

    expect(inventory.objects_total).toBe(2);
    expect(inventory.evidence_refs_total).toBe(2);
    expect(inventory.facet_anchors_total).toBe(3);
    expect(inventory.support_bearing_candidates).toBe(1);
    expect(inventory.path_candidates_total).toBe(0);
  });

  it("counts answers_with path candidates without treating cache presence as support fuel", () => {
    const entries = [
      memoryEntry({ object_id: "seed-memory", evidence_refs: [] }),
      memoryEntry({ object_id: "answer-memory", evidence_refs: [] })
    ];
    const paths: readonly PathRelation[] = [
      pathRelation({
        path_id: "path-answer",
        source_id: "seed-memory",
        target_id: "answer-memory"
      })
    ];

    const inventory = deriveSeedFuelInventory({ entries, paths });
    expect(inventory.path_candidates_total).toBe(1);
    expect(inventory.support_bearing_candidates).toBe(0);
  });

  it("preserves path facet anchors during bench-local inventory derivation", () => {
    const entries = [memoryEntry({ object_id: "seed-memory", content: "plain note", domain_tags: [] })];
    const paths = [
      pathRelation({
        path_id: "path-facet",
        source_id: "seed-memory",
        target_id: "answer-memory",
        source_anchor: { kind: "object_facet", object_id: "seed-memory", facet_key: "location_place" }
      })
    ];

    const inventory = deriveSeedFuelInventory({ entries, paths });
    expect(inventory.facet_anchors_total).toBe(1);
  });

  it("does not count answer paths blocked by direction bias", () => {
    const entries = [
      memoryEntry({ object_id: "seed-memory", evidence_refs: [] }),
      memoryEntry({ object_id: "answer-memory", evidence_refs: [] })
    ];
    const paths = [
      pathRelation({
        path_id: "path-reverse-only",
        source_id: "seed-memory",
        target_id: "answer-memory",
        direction_bias: "target_to_source"
      })
    ];

    const inventory = deriveSeedFuelInventory({ entries, paths });
    expect(inventory.path_candidates_total).toBe(1);
    const seedOnlyInventory = deriveSeedFuelInventory({ entries: entries.slice(0, 1), paths });
    expect(seedOnlyInventory.path_candidates_total).toBe(0);
  });
});

function pathRelation(input: {
  readonly path_id: string;
  readonly source_id: string;
  readonly target_id: string;
  readonly direction_bias?: PathRelation["plasticity_state"]["direction_bias"];
  readonly source_anchor?: PathRelation["anchors"]["source_anchor"];
}): PathRelation {
  return {
    path_id: input.path_id,
    workspace_id: "ws-1",
    anchors: {
      source_anchor: input.source_anchor ?? { kind: "object", object_id: input.source_id },
      target_anchor: { kind: "object", object_id: input.target_id }
    },
    constitution: {
      relation_kind: "answers_with",
      why_this_relation_exists: ["test"]
    },
    effect_vector: {
      salience: 1,
      recall_bias: 1,
      verification_bias: 0,
      unfinishedness_bias: 0,
      default_manifestation_preference: "lens_entry"
    },
    plasticity_state: {
      strength: 1,
      direction_bias: input.direction_bias ?? "source_to_target",
      stability_class: "stable",
      support_events_count: 1,
      contradiction_events_count: 0
    },
    lifecycle: {
      status: "active",
      retirement_rule: "default"
    },
    legitimacy: {
      evidence_basis: [],
      governance_class: "recall_allowed"
    },
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z"
  };
}
