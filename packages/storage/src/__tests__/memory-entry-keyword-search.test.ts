import { describe, expect, it } from "vitest";
import {
  mergeKeywordSearchRows,
  type ExactKeywordSearchRow,
  type FtsKeywordSearchRow
} from "../repos/memory-entry-keyword-search.js";

describe("mergeKeywordSearchRows trigram_rank passthrough", () => {
  it("surfaces a trigram_rank for objects that matched the trigram lane", () => {
    const exactRows: readonly ExactKeywordSearchRow[] = [];
    const trigramRows: readonly FtsKeywordSearchRow[] = [
      { object_id: "obj-trigram", raw_rank: -5 }
    ];
    const merged = mergeKeywordSearchRows(exactRows, trigramRows, 10);

    expect(merged).toEqual([
      { object_id: "obj-trigram", normalized_rank: 1, trigram_rank: 1 }
    ]);
  });

  it("omits trigram_rank for objects that only matched exact or porter lanes", () => {
    const exactRows: readonly ExactKeywordSearchRow[] = [
      { object_id: "obj-exact", matched_token_count: 2 }
    ];
    const porterRows: readonly FtsKeywordSearchRow[] = [
      { object_id: "obj-porter", raw_rank: -3 }
    ];
    const merged = mergeKeywordSearchRows(exactRows, [], 10, porterRows);

    expect(merged).toEqual([
      { object_id: "obj-exact", normalized_rank: 1 },
      { object_id: "obj-porter", normalized_rank: 1 }
    ]);
    expect(merged.every((row) => row.trigram_rank === undefined)).toBe(true);
  });

  it("carries the trigram-lane ordinal score even when a higher-priority lane wins the merged rank", () => {
    const exactRows: readonly ExactKeywordSearchRow[] = [
      { object_id: "obj-both", matched_token_count: 1 }
    ];
    const trigramRows: readonly FtsKeywordSearchRow[] = [
      { object_id: "obj-both", raw_rank: -9 },
      { object_id: "obj-trigram-only", raw_rank: -1 }
    ];
    const merged = mergeKeywordSearchRows(exactRows, trigramRows, 10);
    const byId = new Map(merged.map((row) => [row.object_id, row]));

    // The exact lane wins the merged normalized_rank for obj-both, yet its
    // distinct trigram-lane ordinal score is still surfaced for the
    // trigram_fts fusion stream to read.
    expect(byId.get("obj-both")?.trigram_rank).toBeGreaterThan(0);
    expect(byId.get("obj-trigram-only")?.trigram_rank).toBeGreaterThan(0);
  });
});
