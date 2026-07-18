import type { MemoryEntryKeywordSearchResult } from "../types.js";

export function freezeKeywordSearchResults(
  rows: readonly MemoryEntryKeywordSearchResult[]
): readonly MemoryEntryKeywordSearchResult[] {
  return Object.freeze(
    rows.map((row) =>
      Object.freeze({
        object_id: row.object_id,
        normalized_rank: row.normalized_rank,
        ...(row.trigram_rank !== undefined ? { trigram_rank: row.trigram_rank } : {})
      })
    )
  );
}
