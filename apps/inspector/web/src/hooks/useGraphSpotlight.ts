import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { GraphLink, GraphNode, SpotlightState } from "../types/graph";
import {
  useDebouncedSearchTerm,
  useGraphTimeSearch,
  type GraphSearchTimeHits
} from "./graph-spotlight-search";
import { useGraphSpotlightMatches } from "./graph-spotlight-matches";

interface GraphDataLike {
  readonly nodes: readonly GraphNode[];
  readonly links: readonly GraphLink[];
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
  readonly setMatchCursor: Dispatch<SetStateAction<number>>;
  readonly setSearchTerm: Dispatch<SetStateAction<string>>;
  readonly spotlightActive: boolean;
}

export function useGraphSpotlight({
  data,
  workspaceId
}: UseGraphSpotlightOptions): UseGraphSpotlightResult {
  const [searchTerm, setSearchTerm] = useState("");
  const [matchCursor, setMatchCursor] = useState(0);
  useResetMatchCursor(searchTerm, setMatchCursor);
  const debouncedSearchTerm = useDebouncedSearchTerm(searchTerm, 120);
  const timeSearch = useGraphTimeSearch(debouncedSearchTerm, workspaceId);
  const matches = useGraphSpotlightMatches({
    data,
    debouncedSearchTerm,
    searchKeywordFallback: timeSearch.searchKeywordFallback,
    searchTimeHits: timeSearch.searchTimeHits
  });
  const spotlightActive = searchTerm.trim() !== "" && debouncedSearchTerm.trim() !== "";
  const nodeSpotlightState = useNodeSpotlightState(
    matches.adjacentIds,
    matches.matchIds,
    spotlightActive
  );
  return {
    adjacentIds: matches.adjacentIds,
    focusedMatchId: matches.matchOrder[matchCursor],
    matchCount: matches.matchOrder.length,
    matchCursor,
    matchIds: matches.matchIds,
    nodeSpotlightState,
    searchError: timeSearch.searchError,
    searchTerm,
    searchTimeHits: timeSearch.searchTimeHits,
    setMatchCursor,
    setSearchTerm,
    spotlightActive
  };
}

function useResetMatchCursor(
  searchTerm: string,
  setMatchCursor: Dispatch<SetStateAction<number>>
) {
  useEffect(() => {
    setMatchCursor(0);
  }, [searchTerm, setMatchCursor]);
}

function useNodeSpotlightState(
  adjacentIds: ReadonlySet<string>,
  matchIds: ReadonlySet<string>,
  spotlightActive: boolean
) {
  return useCallback(
    (id: string): SpotlightState => {
      if (!spotlightActive) return "match";
      if (matchIds.has(id)) return "match";
      if (adjacentIds.has(id)) return "adjacent";
      return "background";
    },
    [adjacentIds, matchIds, spotlightActive]
  );
}
