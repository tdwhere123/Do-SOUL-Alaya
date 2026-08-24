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

export type RecallTierWindowPageFailure =
  | "oversized"
  | "missing_cursor"
  | "stalled_cursor";

export function validateRecallTierWindowPage(
  window: Readonly<{
    readonly memories: readonly unknown[];
    readonly truncated: boolean;
    readonly next_cursor: Readonly<RecallTierWindowCursor> | null;
  }>,
  requestLimit: number,
  inputCursor: Readonly<RecallTierWindowCursor> | undefined
): RecallTierWindowPageFailure | null {
  if (window.memories.length > requestLimit) return "oversized";
  if (!window.truncated) return null;
  if (window.next_cursor === null) return "missing_cursor";
  if (inputCursor !== undefined && compareCursor(window.next_cursor, inputCursor) <= 0) {
    return "stalled_cursor";
  }
  return null;
}

function compareCursor(
  left: Readonly<RecallTierWindowCursor>,
  right: Readonly<RecallTierWindowCursor>
): number {
  return left.created_at.localeCompare(right.created_at) ||
    left.object_id.localeCompare(right.object_id);
}

export function resolveRecallTierWindowPageLimit(memoryCount: number): number | null {
  const remaining = MAX_RECALL_TIER_MEMORIES - memoryCount;
  return remaining <= 0
    ? null
    : Math.min(STORAGE_RECALL_TIER_PAGE_SIZE, remaining);
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
