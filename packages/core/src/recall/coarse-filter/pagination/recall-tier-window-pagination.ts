import type { RecallTierWindowCursor } from
  "../../runtime/recall-service-types.js";

export const OFFSET_RECALL_TIER_PAGE_SIZE = 512;
export const STORAGE_RECALL_TIER_PAGE_SIZE = 500;
export const MAX_OFFSET_RECALL_TIER_PAGES = 200;
// Safety valve only: activation admission prefers SQL top-K, then hydrate.
// This cap still bounds the HOT window used by other coarse planes.
export const MAX_RECALL_TIER_MEMORIES =
  OFFSET_RECALL_TIER_PAGE_SIZE * MAX_OFFSET_RECALL_TIER_PAGES;
export const MAX_CURSOR_RECALL_TIER_PAGES = Math.ceil(
  MAX_RECALL_TIER_MEMORIES / STORAGE_RECALL_TIER_PAGE_SIZE
);

export type RecallTierWindowStep = Readonly<
  | { readonly kind: "complete" }
  | { readonly kind: "capped" }
  | { readonly kind: "continue"; readonly cursor: Readonly<RecallTierWindowCursor> }
>;

export function resolveRecallTierWindowPageLimit(memoryCount: number): number | null {
  const remaining = MAX_RECALL_TIER_MEMORIES - memoryCount;
  // Cursor limit is I/O batching up to the hard cap, not a ranking window.
  return remaining <= 0 ? null : remaining;
}

export function resolveRecallTierWindowStep(
  window: Readonly<{
    readonly truncated: boolean;
    readonly next_cursor: Readonly<RecallTierWindowCursor> | null;
  }>,
  pagesLoaded: number,
  memoryCount: number
): RecallTierWindowStep {
  if (!window.truncated) return Object.freeze({ kind: "complete" });
  if (
    window.next_cursor === null
    || pagesLoaded >= MAX_CURSOR_RECALL_TIER_PAGES
    || memoryCount >= MAX_RECALL_TIER_MEMORIES
  ) {
    return Object.freeze({ kind: "capped" });
  }
  return Object.freeze({ kind: "continue", cursor: window.next_cursor });
}
