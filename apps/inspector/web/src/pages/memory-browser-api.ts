import { apiFetchWithHeaders } from "../api";
import {
  MEMORY_PAGE_SIZE,
  readOptionalIntegerHeader,
  type ConflictFilter,
  type DimensionFilter,
  type MemoryEntryListEnvelope,
  type MemoryPageData,
  type ScopeFilter
} from "./memory-browser-support";

export interface MemoryFilterState {
  readonly dimensionFilter: DimensionFilter;
  readonly scopeFilter: ScopeFilter;
  readonly conflictFilter: ConflictFilter;
}

export function buildMemoryEntriesPath(
  workspaceId: string,
  filters: MemoryFilterState,
  offset: number
): string {
  const search = new URLSearchParams();
  if (filters.dimensionFilter !== "all") {
    search.set("dimension", filters.dimensionFilter);
  }
  if (filters.scopeFilter !== "all") {
    search.set("scope_class", filters.scopeFilter);
  }
  if (filters.conflictFilter === "has_conflict") {
    search.set("has_conflict", "true");
  }
  search.set("limit", String(MEMORY_PAGE_SIZE));
  search.set("offset", String(offset));
  const query = search.toString();
  return `/memory-entries/${workspaceId}${query.length > 0 ? `?${query}` : ""}`;
}

export async function fetchMemoryPage(
  workspaceId: string,
  filters: MemoryFilterState,
  offset: number,
  signal?: AbortSignal
): Promise<MemoryPageData> {
  const result = await apiFetchWithHeaders<MemoryEntryListEnvelope>(
    buildMemoryEntriesPath(workspaceId, filters, offset),
    signal ? { signal } : undefined
  );
  return toMemoryPageData(result.payload.data, result.headers, offset);
}

function toMemoryPageData(
  rows: MemoryEntryListEnvelope["data"],
  headers: Headers,
  offset: number
): MemoryPageData {
  const total = readOptionalIntegerHeader(headers, "x-total-count");
  const loadedCount = offset + rows.length;
  return {
    rows,
    totalRows: total,
    nextOffset: loadedCount,
    hasMoreRows: total === null ? rows.length === MEMORY_PAGE_SIZE : loadedCount < total
  };
}
