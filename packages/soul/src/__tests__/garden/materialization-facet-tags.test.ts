import { describe, expect, it } from "vitest";
import type { CandidateMemorySignal } from "@do-soul/alaya-protocol";
import { buildMemoryInput } from "../../garden/materialization-router/inputs.js";

// Write-side producer for the facet_overlap recall stream: buildMemoryInput
// derives facet_tags from distilled content only when the flag is on; off must
// stay byte-identical to the flat write (no facet_tags key).
function createSignal(distilledFact: string): CandidateMemorySignal {
  return {
    signal_id: "signal-1",
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    source: "model_tool",
    signal_kind: "potential_claim",
    signal_state: "triaged",
    object_kind: "fact",
    scope_hint: null,
    domain_tags: [],
    confidence: 0.8,
    evidence_refs: [],
    source_memory_refs: [],
    supersedes_refs: [],
    exception_to_refs: [],
    contradicts_refs: [],
    incompatible_with_refs: [],
    raw_payload: { distilled_fact: distilledFact },
    source_observation: null,
    created_at: "2026-03-21T00:00:00.000Z"
  };
}

describe("buildMemoryInput facet_tags producer", () => {
  it("derives content facets when the flag is on", () => {
    const signal = createSignal("She works at a company and likes spicy food.");
    const input = buildMemoryInput(signal, [], undefined, true);
    const facets = (input.facet_tags ?? []).map((tag) => tag.facet);
    expect(facets).toContain("occupation_work");
    expect(facets).toContain("preference_like");
    expect(facets).toContain("food_dining");
  });

  it("emits no facet_tags key when the flag is off (byte-identical to flat write)", () => {
    const signal = createSignal("She works at a company and likes spicy food.");
    const off = buildMemoryInput(signal, [], undefined, false);
    const flat = buildMemoryInput(signal, [], undefined);
    expect("facet_tags" in off).toBe(false);
    expect(off).toEqual(flat);
  });

  it("emits no facet_tags key when on but content has no facet keywords", () => {
    const signal = createSignal("xyzzy qux blorp");
    const input = buildMemoryInput(signal, [], undefined, true);
    expect("facet_tags" in input).toBe(false);
  });
});
