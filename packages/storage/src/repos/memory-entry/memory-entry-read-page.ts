import {
  DEFAULT_REPO_LIST_PAGE_LIMIT,
  parsePageLimit,
  parsePageOffset
} from "../shared/validators.js";
import type { MemoryEntryListPageOptions } from "./types.js";

export const DEFAULT_MEMORY_ENTRY_PAGE = Object.freeze({
  limit: DEFAULT_REPO_LIST_PAGE_LIMIT,
  offset: 0
});

export function parseMemoryEntryPage(
  page: MemoryEntryListPageOptions
): Readonly<MemoryEntryListPageOptions> {
  return Object.freeze({
    limit: parsePageLimit(page.limit, "memory entry page limit"),
    offset: parsePageOffset(page.offset, "memory entry page offset")
  });
}
