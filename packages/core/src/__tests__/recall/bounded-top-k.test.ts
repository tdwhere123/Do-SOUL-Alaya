import { describe, expect, it } from "vitest";
import { selectBoundedTopK } from "../../recall/coarse-filter/selection/bounded-top-k.js";

interface RankedValue {
  readonly id: string;
  readonly score: number;
}

const compareRankedValues = (left: RankedValue, right: RankedValue): number =>
  right.score - left.score || left.id.localeCompare(right.id);

describe("selectBoundedTopK", () => {
  it("matches full-sort selection including deterministic ties", () => {
    const values = Array.from({ length: 997 }, (_, index) => ({
      id: `value-${String(996 - index).padStart(4, "0")}`,
      score: (index * 37) % 29
    }));

    expect(selectBoundedTopK(values, 73, compareRankedValues)).toEqual(
      [...values].sort(compareRankedValues).slice(0, 73)
    );
  });

  it("handles empty and unbounded selections", () => {
    const values = [
      { id: "b", score: 1 },
      { id: "a", score: 1 }
    ];

    expect(selectBoundedTopK(values, 0, compareRankedValues)).toEqual([]);
    expect(selectBoundedTopK(values, 5, compareRankedValues)).toEqual([
      { id: "a", score: 1 },
      { id: "b", score: 1 }
    ]);
  });
});
