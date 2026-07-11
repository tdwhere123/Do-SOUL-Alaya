import { describe, expect, it } from "vitest";

import {
  buildObjectFormationOrder,
  buildSessionMap,
  parsePathPairKeys,
  sparsifyPairs
} from "../../path-graph/producers/path-pair-sparsify.js";

describe("path pair semantic determinism", () => {
  it("keeps the same capped topology when storage ids change", () => {
    const first = topologyBySemanticPosition(["a", "b", "c", "d"], [2, 0, 3, 1]);
    const second = topologyBySemanticPosition(["z", "a", "y", "b"], [1, 3, 0, 2]);

    expect(second).toEqual(first);
    expect(maxDegree(first)).toBeLessThanOrEqual(1);
  });

  it("collapses reversed duplicate pair observations before mint", () => {
    const objects = [
      { objectId: "z", sessionId: "first", formationKey: "formation:0" },
      { objectId: "a", sessionId: "second", formationKey: "formation:1" }
    ];
    const order = buildObjectFormationOrder(objects);
    const kept = sparsifyPairs(
      parsePathPairKeys(new Set(["a|z", "z|a"])),
      buildSessionMap(objects),
      order,
      1,
      true
    );

    expect(kept).toEqual([["z", "a"]]);
  });

  it.each(["missing-delimiter", "|right", "left|", "a|b|c"])(
    "rejects malformed pair key %s at the string boundary",
    (pairKey) => {
      expect(() => parsePathPairKeys(new Set([pairKey]))).toThrow(/pair key/u);
    }
  );

  it("uses object identity only to total-order equivalent formation evidence", () => {
    const forward = buildObjectFormationOrder([
      { objectId: "a", formationKey: "same" },
      { objectId: "b", formationKey: "same" }
    ]);
    const reverse = buildObjectFormationOrder([
      { objectId: "b", formationKey: "same" },
      { objectId: "a", formationKey: "same" }
    ]);

    expect([...forward]).toEqual([...reverse]);
    expect([...forward]).toEqual([["a", 0], ["b", 1]]);
  });
});

function topologyBySemanticPosition(
  ids: readonly string[],
  inputPermutation: readonly number[]
): readonly string[] {
  const objects = inputPermutation.map((semanticIndex) => ({
    objectId: ids[semanticIndex]!,
    sessionId: `s${semanticIndex}`,
    formationKey: `formation:${semanticIndex}`
  }));
  const objectOrder = buildObjectFormationOrder(objects);
  const kept = sparsifyPairs(
    parsePathPairKeys(completePairSet(ids)),
    buildSessionMap(objects),
    objectOrder,
    1,
    true
  );
  const positionById = new Map(ids.map((id, index) => [id, index] as const));
  return kept.map(([source, target]) =>
    `${positionById.get(source)}->${positionById.get(target)}`
  );
}

function maxDegree(edges: readonly string[]): number {
  const degree = new Map<string, number>();
  for (const edge of edges) {
    for (const endpoint of edge.split("->")) {
      degree.set(endpoint, (degree.get(endpoint) ?? 0) + 1);
    }
  }
  return Math.max(0, ...degree.values());
}

function completePairSet(ids: readonly string[]): ReadonlySet<string> {
  const pairs = new Set<string>();
  for (let left = 0; left < ids.length; left += 1) {
    for (let right = left + 1; right < ids.length; right += 1) {
      const a = ids[left]!;
      const b = ids[right]!;
      pairs.add(a < b ? `${a}|${b}` : `${b}|${a}`);
    }
  }
  return pairs;
}
