import { describe, expect, it } from "vitest";
import type { MemoryEntry, PathRelation } from "@do-soul/alaya-protocol";
import { deriveSeedFuelInventory } from "../../recall/fuel/seed-fuel-inventory.js";
import { createPathRelation } from "./recall-service-test-fixtures.js";

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
    expect(inventory.facet_anchors_total).toBeGreaterThan(0);
    expect(inventory.support_bearing_candidates).toBe(1);
    expect(inventory.path_candidates_total).toBe(0);
  });

  it("counts answers_with path candidates without treating cache presence as support fuel", () => {
    const entries = [
      memoryEntry({ object_id: "seed-memory", evidence_refs: [] }),
      memoryEntry({ object_id: "answer-memory", evidence_refs: [] })
    ];
    const paths: readonly PathRelation[] = [
      createPathRelation({
        path_id: "path-answer",
        sourceId: "seed-memory",
        targetId: "answer-memory",
        relationKind: "answers_with",
        strength: 1,
        recallBias: 1
      })
    ];

    const inventory = deriveSeedFuelInventory({ entries, paths });
    expect(inventory.path_candidates_total).toBe(1);
    expect(inventory.support_bearing_candidates).toBe(0);
  });
});
