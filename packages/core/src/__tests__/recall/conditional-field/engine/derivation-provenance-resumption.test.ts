import { describe, expect, it } from "vitest";
import type { Derivation } from "@do-soul/alaya-protocol";
import { localLeafIds, traceDerivationForest } from "../../../../recall/conditional-field/engine/derivation-provenance.js";

describe("shared derivation provenance", () => {
  it("resumes bounded postorder and reads each shared node once without trusting ancestor summaries", () => {
    const nodes = new Map<string, Derivation>([
      ["leaf", node("leaf", [], ["assertion-1"])],
      ["a", node("a", ["leaf"], ["forged-ancestor-summary"])],
      ["b", node("b", ["a"], [])],
      ["root", node("root", ["a", "b"], [])]
    ]);
    const reads = new Map<string, number>();
    const forest = { get(id: string) { reads.set(id, (reads.get(id) ?? 0) + 1); return nodes.get(id); } };
    let result = traceDerivationForest({ forest, roots: ["root"], maxVisits: 1 });
    for (let turn = 0; !result.complete && turn < 30; turn += 1) {
      expect(result.work).toBeLessThanOrEqual(1);
      result = traceDerivationForest({ forest, roots: ["root"], maxVisits: 1, progress: result.traversal });
    }
    expect(result.complete).toBe(true);
    expect(localLeafIds(result.traversal)).toEqual(new Set(["assertion-1"]));
    expect([...reads.values()]).toEqual([1, 1, 1, 1]);
    expect([...result.traversal.postorder.values()].map((entry) => entry.derivation_id)).toEqual(["leaf", "a", "b", "root"]);
  });

  it.each(["cycle", "missing"])("does not certify complete provenance for a %s", (kind) => {
    const forest = new Map<string, Derivation>([["a", node("a", ["b"], [])]]);
    if (kind === "cycle") forest.set("b", node("b", ["a"], []));
    const result = traceDerivationForest({ forest, roots: ["a"], maxVisits: 100 });
    expect(result.complete).toBe(false);
    expect(result.traversal.invalid).toBe(true);
    expect(localLeafIds(result.traversal).size).toBe(0);
  });
});

function node(id: string, children: readonly string[], leafIds: readonly string[]): Derivation {
  return { schema_version: 1, derivation_id: id, kind: children.length === 0 ? "leaf" : "or", children,
    leaf_ids: leafIds, observation_ids: [], source_revisions: [], provenance_layout: "local_leaves.v1",
    association_milligrades: 500 };
}
