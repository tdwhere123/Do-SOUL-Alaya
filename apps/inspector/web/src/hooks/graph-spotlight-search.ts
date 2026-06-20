import { useEffect, useState } from "react";
import { apiFetch, type ApiError } from "../api";
import { parseSearchQuery } from "../utils/parse-search-query";

export interface GraphSearchTimeHits {
  readonly ids: ReadonlySet<string>;
  readonly windowLabel: string;
}

interface GraphSearchEnvelope {
  readonly success: boolean;
  readonly data: {
    readonly results: ReadonlyArray<{ readonly object_id: string }>;
    readonly total_count?: number;
  };
}

interface GraphTimeSearchState {
  readonly searchError: string | null;
  readonly searchKeywordFallback: string;
  readonly searchTimeHits: GraphSearchTimeHits | null;
}

const EMPTY_TIME_SEARCH: GraphTimeSearchState = {
  searchError: null,
  searchKeywordFallback: "",
  searchTimeHits: null
};

export function useDebouncedSearchTerm(searchTerm: string, delayMs: number): string {
  const [debouncedSearchTerm, setDebouncedSearchTerm] = useState("");
  useEffect(() => {
    if (searchTerm === debouncedSearchTerm) return undefined;
    const timeoutId = window.setTimeout(() => setDebouncedSearchTerm(searchTerm), delayMs);
    return () => window.clearTimeout(timeoutId);
  }, [debouncedSearchTerm, delayMs, searchTerm]);
  return debouncedSearchTerm;
}

export function useGraphTimeSearch(
  debouncedSearchTerm: string,
  workspaceId: string | null
): GraphTimeSearchState {
  const [state, setState] = useState<GraphTimeSearchState>(EMPTY_TIME_SEARCH);
  useEffect(() => {
    if (workspaceId === null) return undefined;
    const trimmed = debouncedSearchTerm.trim();
    if (trimmed.length === 0) {
      setState(EMPTY_TIME_SEARCH);
      return undefined;
    }
    const controller = new AbortController();
    void runGraphTimeSearch(trimmed, workspaceId, controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) setState(next);
      })
      .catch((err) => {
        if (!isSilentSearchError(err, controller.signal)) setState(searchErrorState(err));
      });
    return () => controller.abort();
  }, [debouncedSearchTerm, workspaceId]);
  return state;
}

async function runGraphTimeSearch(
  trimmed: string,
  workspaceId: string,
  signal: AbortSignal
): Promise<GraphTimeSearchState> {
  const parsed = await parseSearchQuery(trimmed);
  if (signal.aborted) return EMPTY_TIME_SEARCH;
  if (parsed.since === null && parsed.until === null) {
    return { searchError: null, searchKeywordFallback: parsed.text, searchTimeHits: null };
  }
  const envelope = await apiFetch<GraphSearchEnvelope>(`/soul/search/${workspaceId}`, {
    signal,
    method: "POST",
    body: {
      text: parsed.text.length > 0 ? parsed.text : (parsed.windowLabel ?? trimmed),
      since: parsed.since,
      until: parsed.until,
      max_results: 50
    }
  });
  return {
    searchError: null,
    searchKeywordFallback: parsed.text,
    searchTimeHits: {
      ids: new Set(envelope.data.results.map((result) => result.object_id)),
      windowLabel: parsed.windowLabel ?? trimmed
    }
  };
}

function isSilentSearchError(err: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted ||
    (err instanceof DOMException && err.name === "AbortError") ||
    (err as ApiError).status === 401
  );
}

function searchErrorState(err: unknown): GraphTimeSearchState {
  return {
    searchError: err instanceof Error ? err.message : "search failed",
    searchKeywordFallback: "",
    searchTimeHits: null
  };
}
