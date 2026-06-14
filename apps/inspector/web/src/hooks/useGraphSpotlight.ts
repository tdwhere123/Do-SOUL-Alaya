import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch, type ApiError } from "../api";
import type { GraphLink, GraphNode, SpotlightState } from "../types/graph";
import { parseSearchQuery } from "../utils/parse-search-query";
import { extractId } from "../utils/graph";

interface GraphDataLike {
  readonly nodes: readonly GraphNode[];
  readonly links: readonly GraphLink[];
}

interface GraphSearchTimeHits {
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

interface UseGraphSpotlightOptions {
  readonly data: GraphDataLike | null;
  readonly workspaceId: string | null;
}

export interface UseGraphSpotlightResult {
  readonly adjacentIds: ReadonlySet<string>;
  readonly focusedMatchId: string | undefined;
  readonly matchCount: number;
  readonly matchCursor: number;
  readonly matchIds: ReadonlySet<string>;
  readonly nodeSpotlightState: (id: string) => SpotlightState;
  readonly searchError: string | null;
  readonly searchTerm: string;
  readonly searchTimeHits: GraphSearchTimeHits | null;
  readonly setMatchCursor: React.Dispatch<React.SetStateAction<number>>;
  readonly setSearchTerm: React.Dispatch<React.SetStateAction<string>>;
  readonly spotlightActive: boolean;
}

/**
 * Debounces the graph search box, upgrades recognized time expressions to the
 * daemon-backed search route, and derives match/adjacent spotlight sets for
 * both 2D and 3D renderers.
 */
export function useGraphSpotlight({
  data,
  workspaceId
}: UseGraphSpotlightOptions): UseGraphSpotlightResult {
  const [searchTerm, setSearchTerm] = useState("");
  const [debouncedSearchTerm, setDebouncedSearchTerm] = useState("");
  const [searchTimeHits, setSearchTimeHits] = useState<GraphSearchTimeHits | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchKeywordFallback, setSearchKeywordFallback] = useState("");
  const [matchCursor, setMatchCursor] = useState(0);

  useEffect(() => {
    setMatchCursor(0);
  }, [searchTerm]);

  useEffect(() => {
    if (searchTerm === debouncedSearchTerm) return;
    const timeoutId = window.setTimeout(() => setDebouncedSearchTerm(searchTerm), 120);
    return () => window.clearTimeout(timeoutId);
  }, [debouncedSearchTerm, searchTerm]);

  useEffect(() => {
    if (workspaceId === null) return;

    const trimmed = debouncedSearchTerm.trim();
    if (trimmed.length === 0) {
      setSearchTimeHits(null);
      setSearchError(null);
      setSearchKeywordFallback("");
      return;
    }

    const controller = new AbortController();
    void (async () => {
      const parsed = await parseSearchQuery(trimmed);
      if (controller.signal.aborted) return;

      setSearchKeywordFallback(parsed.text);
      if (parsed.since === null && parsed.until === null) {
        setSearchTimeHits(null);
        setSearchError(null);
        return;
      }

      try {
        const envelope = await apiFetch<GraphSearchEnvelope>(`/soul/search/${workspaceId}`, {
          signal: controller.signal,
          method: "POST",
          body: {
            text: parsed.text.length > 0 ? parsed.text : (parsed.windowLabel ?? trimmed),
            since: parsed.since,
            until: parsed.until,
            max_results: 50
          }
        });
        if (controller.signal.aborted) return;
        setSearchTimeHits({
          ids: new Set(envelope.data.results.map((result) => result.object_id)),
          windowLabel: parsed.windowLabel ?? trimmed
        });
        setSearchError(null);
      } catch (err) {
        if (
          controller.signal.aborted ||
          (err instanceof DOMException && err.name === "AbortError") ||
          (err as ApiError).status === 401
        ) {
          return;
        }
        setSearchTimeHits(null);
        setSearchError(err instanceof Error ? err.message : "search failed");
      }
    })();

    return () => controller.abort();
  }, [debouncedSearchTerm, workspaceId]);

  const { matchIds, adjacentIds, matchOrder } = useMemo(() => {
    if (!data || debouncedSearchTerm.trim() === "") {
      return {
        matchIds: new Set<string>(),
        adjacentIds: new Set<string>(),
        matchOrder: [] as string[]
      };
    }

    let order: string[] = [];
    const matchSet = new Set<string>();

    if (searchTimeHits) {
      order = data.nodes
        .filter((node) => searchTimeHits.ids.has(node.object_id ?? node.id))
        .map((node) => node.id);
      order.forEach((id) => matchSet.add(id));
    } else {
      const fallbackText =
        searchKeywordFallback.length > 0 ? searchKeywordFallback : debouncedSearchTerm.trim();
      const needle = fallbackText.toLowerCase();
      if (needle.length > 0) {
        order = data.nodes
          .filter((node) => {
            const haystack = `${node.id} ${node.label} ${node.summary ?? ""}`.toLowerCase();
            return haystack.includes(needle);
          })
          .map((node) => node.id);
        order.forEach((id) => matchSet.add(id));
      }
    }

    const adjacent = new Set<string>();
    data.links.forEach((link) => {
      const sourceId = extractId(link.source);
      const targetId = extractId(link.target);
      if (matchSet.has(sourceId)) adjacent.add(targetId);
      if (matchSet.has(targetId)) adjacent.add(sourceId);
    });
    matchSet.forEach((id) => adjacent.delete(id));

    return {
      matchIds: matchSet,
      adjacentIds: adjacent,
      matchOrder: order
    };
  }, [data, debouncedSearchTerm, searchKeywordFallback, searchTimeHits]);

  const spotlightActive = searchTerm.trim() !== "" && debouncedSearchTerm.trim() !== "";
  const focusedMatchId = matchOrder[matchCursor];

  const nodeSpotlightState = useCallback(
    (id: string): SpotlightState => {
      if (!spotlightActive) return "match";
      if (matchIds.has(id)) return "match";
      if (adjacentIds.has(id)) return "adjacent";
      return "background";
    },
    [adjacentIds, matchIds, spotlightActive]
  );

  return {
    adjacentIds,
    focusedMatchId,
    matchCount: matchOrder.length,
    matchCursor,
    matchIds,
    nodeSpotlightState,
    searchError,
    searchTerm,
    searchTimeHits,
    setMatchCursor,
    setSearchTerm,
    spotlightActive
  };
}
