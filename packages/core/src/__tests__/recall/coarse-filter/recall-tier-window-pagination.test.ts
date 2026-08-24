import { describe, expect, it } from "vitest";
import {
  MAX_RECALL_TIER_MEMORIES,
  MAX_CURSOR_RECALL_TIER_PAGES,
  STORAGE_RECALL_TIER_PAGE_SIZE,
  resolveRecallTierWindowPageLimit,
  resolveRecallTierWindowStep
} from "../../../recall/coarse-filter/pagination/recall-tier-window-pagination.js";

const CURSOR = Object.freeze({
  created_at: "2026-05-07T00:00:00.000Z",
  object_id: "memory-cursor"
});

describe("recall tier window pagination", () => {
  it("keeps the cursor window aligned to the 102400-memory hard cap", () => {
    expect(MAX_RECALL_TIER_MEMORIES).toBe(102_400);
    expect(MAX_CURSOR_RECALL_TIER_PAGES).toBe(205);
    expect(resolveRecallTierWindowPageLimit(0)).toBe(STORAGE_RECALL_TIER_PAGE_SIZE);
    expect(resolveRecallTierWindowPageLimit(100_000)).toBe(STORAGE_RECALL_TIER_PAGE_SIZE);
    expect(resolveRecallTierWindowPageLimit(102_000)).toBe(400);
    expect(resolveRecallTierWindowPageLimit(102_400)).toBeNull();
  });

  it("never exceeds the SQL page bound while reaching the total cap", () => {
    let memoryCount = 0;
    let pagesLoaded = 0;
    const requested: number[] = [];
    while (memoryCount < MAX_RECALL_TIER_MEMORIES) {
      const limit = resolveRecallTierWindowPageLimit(memoryCount);
      expect(limit).not.toBeNull();
      if (limit === null) break;
      requested.push(limit);
      memoryCount += limit;
      pagesLoaded += 1;
    }
    expect(Math.max(...requested)).toBe(STORAGE_RECALL_TIER_PAGE_SIZE);
    expect(memoryCount).toBe(MAX_RECALL_TIER_MEMORIES);
    expect(pagesLoaded).toBe(MAX_CURSOR_RECALL_TIER_PAGES);
    expect(resolveRecallTierWindowPageLimit(memoryCount)).toBeNull();
  });

  it("continues through page 204 and closes the final cursor page honestly", () => {
    const truncated = { truncated: true, next_cursor: CURSOR };

    expect(resolveRecallTierWindowStep(truncated, 200, 100_000)).toEqual({
      kind: "continue",
      cursor: CURSOR
    });
    expect(resolveRecallTierWindowStep(truncated, 204, 102_000)).toEqual({
      kind: "continue",
      cursor: CURSOR
    });
    expect(resolveRecallTierWindowStep(
      { truncated: false, next_cursor: null },
      205,
      102_400
    )).toEqual({ kind: "complete" });
    expect(resolveRecallTierWindowStep(truncated, 205, 102_400)).toEqual({
      kind: "capped"
    });
  });
});
