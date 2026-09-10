import { describe, expect, it } from "vitest";
import { InformationIndexSchema, type Derivation, type FieldSnapshot, type IndexEntry } from "@do-soul/alaya-protocol";
import { projectAcceptingIndex } from "../../../../recall/conditional-field/index/project-accepting-index.js";
import { productStateNodeId } from "../../../../recall/conditional-field/reference/bind-max-min.js";
import { defaultBudget, defaultView, productKey, SNAPSHOT_ID } from "../reference/deployment.fixture.js";

describe("founded membership under an exhausted explanation allowance", () => {
  it("delivers the member through the retained explanation path before expanding its entire forest", () => {
    const state = productKey("member");
    const snapshot: FieldSnapshot = { schema_version: 1, query_id: "query", snapshot_id: SNAPSHOT_ID,
      values: [{ schema_version: 1, state, milligrades: 1000, accepting: true }],
      seeds: [{ schema_version: 1, state, milligrades: 1000 }], retained_transitions: [], facets: [] };
    const forest = new Map<string, Derivation>();
    forest.set("leaf", { schema_version: 1, derivation_id: "leaf", kind: "leaf", provenance_layout: "local_leaves.v1",
      children: [], observation_ids: ["member"], leaf_ids: ["member"], source_revisions: ["rev"], association_milligrades: 1000 });
    let root = "leaf";
    for (let index = 0; index < 50; index += 1) {
      const id = `shared-${index}`;
      forest.set(id, { schema_version: 1, derivation_id: id, kind: "and", provenance_layout: "local_leaves.v1",
        children: [root, "leaf"], observation_ids: [], leaf_ids: [], source_revisions: [] });
      root = id;
    }
    let canonical: readonly IndexEntry[] = [];
    let remaining = -1;
    let proofWork = 0;
    const result = projectAcceptingIndex({ snapshot, query_id: "query", snapshot_id: SNAPSHOT_ID, result_version: "v1",
      view: defaultView(), budget: defaultBudget({ work_units: 4, finalization_reserve: 4, min_envelope: 0, page_budget: 1 }),
      derivation_forest: forest, output_derivation_roots: new Map([[productStateNodeId(state), [root]]]),
      grounding_complete: true, remaining_reserve: 4, remaining_memory_bytes: 1_000_000,
      expires_at: "2099-01-01T00:00:00.000Z",
      observer: { outcome: { schema_version: 1, status: "exhausted" }, open_regions: [] },
      on_semantic_entries: (entries) => { canonical = entries; },
      on_explanation_progress: (_progress, _bytes, work) => { proofWork += work; },
      finalize_payload: (entries, available) => ({ remaining: available - entries.length, complete: true }),
      on_remaining_reserve: (available) => { remaining = available; }
    });
    expect(result.entries.map((entry) => entry.object_id)).toEqual(["member"]);
    expect(canonical[0]?.explanation_ids).toEqual([root]);
    expect(result.completeness.payload).not.toBe("complete");
    expect(remaining).toBeGreaterThanOrEqual(0);
    expect(1 + proofWork + result.entries.length + remaining).toBe(4);
  });

  it.each([true, false])("keeps an oversized shared forest encodable with retained proof progress=%s", (retainedProgress) => {
    const state = productKey("member");
    const snapshot: FieldSnapshot = { schema_version: 1, query_id: "query", snapshot_id: SNAPSHOT_ID,
      values: [{ schema_version: 1, state, milligrades: 1000, accepting: true }],
      seeds: [{ schema_version: 1, state, milligrades: 1000 }], retained_transitions: [], facets: [] };
    const forest = new Map<string, Derivation>();
    forest.set("leaf", { schema_version: 1, derivation_id: "leaf", kind: "leaf", provenance_layout: "local_leaves.v1",
      children: [], observation_ids: ["member"], leaf_ids: ["member"], source_revisions: ["rev"], association_milligrades: 1000 });
    let root = "leaf";
    for (let index = 0; index < 1000; index += 1) {
      const id = `shared-${index}`;
      forest.set(id, { schema_version: 1, derivation_id: id, kind: "and", provenance_layout: "local_leaves.v1",
        children: [root, "leaf"], observation_ids: [], leaf_ids: [], source_revisions: [] });
      root = id;
    }
    const result = projectAcceptingIndex({ snapshot, query_id: "query", snapshot_id: SNAPSHOT_ID, result_version: "v1",
      view: defaultView(), budget: defaultBudget({ work_units: 20_000, finalization_reserve: 20_000,
        min_envelope: 0, page_budget: 1, memory_bytes: 10_000_000 }),
      derivation_forest: forest, output_derivation_roots: new Map([[productStateNodeId(state), [root]]]),
      grounding_complete: true, remaining_reserve: 20_000, remaining_memory_bytes: 10_000_000,
      expires_at: "2099-01-01T00:00:00.000Z",
      observer: { outcome: { schema_version: 1, status: "exhausted" }, open_regions: [] },
      ...(retainedProgress ? { on_explanation_progress: () => undefined } : {})
    });
    expect(result.entries.map((entry) => entry.object_id)).toEqual(["member"]);
    const parsed = InformationIndexSchema.safeParse(result);
    expect(parsed.success, parsed.success ? undefined : JSON.stringify(parsed.error.issues)).toBe(true);
    if ((result.explanations?.length ?? 0) < forest.size) expect(result.completeness.payload).not.toBe("complete");
  });
});
