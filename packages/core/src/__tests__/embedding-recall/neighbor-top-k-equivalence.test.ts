import { describe, expect, it } from "vitest";

import {
  compareNeighborHits,
  selectTopNeighborHits
} from "../../embedding-recall/scoring/neighbor-top-k.js";
import type { EmbeddingNeighborHit } from "../../embedding-recall/types.js";

describe("selectTopNeighborHits", () => {
  it("matches full-sort-then-slice on random ledgers (exact top-K equivalence)", () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const hits = buildRandomLedger(seed, 80 + (seed % 40));
      for (const maxNeighbors of [0, 1, 3, 5, 11, hits.length, hits.length + 5]) {
        const expected = [...hits].sort(compareNeighborHits).slice(0, Math.max(0, maxNeighbors));
        const actual = selectTopNeighborHits(hits, maxNeighbors);
        expect(actual).toEqual(expected);
      }
    }
  });

  it("preserves similarity-desc then object_id-asc order at the K boundary", () => {
    const hits: EmbeddingNeighborHit[] = [
      { object_id: "b", normalized_similarity: 0.9 },
      { object_id: "a", normalized_similarity: 0.9 },
      { object_id: "c", normalized_similarity: 0.5 },
      { object_id: "d", normalized_similarity: 0.5 }
    ];
    expect(selectTopNeighborHits(hits, 3).map((hit) => hit.object_id)).toEqual([
      "a",
      "b",
      "c"
    ]);
  });
});

function buildRandomLedger(seed: number, count: number): EmbeddingNeighborHit[] {
  let state = seed >>> 0;
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const hits: EmbeddingNeighborHit[] = [];
  for (let index = 0; index < count; index += 1) {
    hits.push({
      object_id: `obj-${String(index).padStart(4, "0")}-${(next() * 1e6) | 0}`,
      normalized_similarity: next(),
      content_hash: `sha256:${index}`
    });
  }
  return hits;
}
