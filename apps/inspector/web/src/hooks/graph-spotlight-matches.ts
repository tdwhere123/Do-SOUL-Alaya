import { useMemo } from "react";
import type { GraphLink, GraphNode } from "../types/graph";
import { extractId } from "../utils/graph";
import type { GraphSearchTimeHits } from "./graph-spotlight-search";

interface GraphDataLike {
  readonly nodes: readonly GraphNode[];
  readonly links: readonly GraphLink[];
}

interface GraphSpotlightMatchOptions {
  readonly data: GraphDataLike | null;
  readonly debouncedSearchTerm: string;
  readonly searchKeywordFallback: string;
  readonly searchTimeHits: GraphSearchTimeHits | null;
}

export interface GraphSpotlightMatches {
  readonly adjacentIds: ReadonlySet<string>;
  readonly matchIds: ReadonlySet<string>;
  readonly matchOrder: readonly string[];
}

export function useGraphSpotlightMatches(
  options: GraphSpotlightMatchOptions
): GraphSpotlightMatches {
  return useMemo(() => {
    if (!options.data || options.debouncedSearchTerm.trim() === "") {
      return emptyMatches();
    }
    const matchOrder = matchOrderForSearch(options);
    const matchIds = new Set(matchOrder);
    return {
      adjacentIds: adjacentIdsForMatches(options.data.links, matchIds),
      matchIds,
      matchOrder
    };
  }, [
    options.data,
    options.debouncedSearchTerm,
    options.searchKeywordFallback,
    options.searchTimeHits
  ]);
}

function matchOrderForSearch(options: GraphSpotlightMatchOptions): string[] {
  if (!options.data) return [];
  if (options.searchTimeHits) {
    return options.data.nodes
      .filter((node) => options.searchTimeHits?.ids.has(node.object_id ?? node.id))
      .map((node) => node.id);
  }
  return keywordMatchOrder(
    options.data.nodes,
    fallbackSearchText(options.searchKeywordFallback, options.debouncedSearchTerm)
  );
}

function keywordMatchOrder(nodes: readonly GraphNode[], fallbackText: string): string[] {
  const needle = fallbackText.toLowerCase();
  if (needle.length === 0) return [];
  return nodes
    .filter((node) => graphNodeHaystack(node).includes(needle))
    .map((node) => node.id);
}

function adjacentIdsForMatches(
  links: readonly GraphLink[],
  matchIds: ReadonlySet<string>
): ReadonlySet<string> {
  const adjacent = new Set<string>();
  links.forEach((link) => {
    const sourceId = extractId(link.source);
    const targetId = extractId(link.target);
    if (matchIds.has(sourceId)) adjacent.add(targetId);
    if (matchIds.has(targetId)) adjacent.add(sourceId);
  });
  matchIds.forEach((id) => adjacent.delete(id));
  return adjacent;
}

function fallbackSearchText(searchKeywordFallback: string, debouncedSearchTerm: string): string {
  return searchKeywordFallback.length > 0 ? searchKeywordFallback : debouncedSearchTerm.trim();
}

function graphNodeHaystack(node: GraphNode): string {
  return `${node.id} ${node.label} ${node.summary ?? ""}`.toLowerCase();
}

function emptyMatches(): GraphSpotlightMatches {
  return {
    adjacentIds: new Set<string>(),
    matchIds: new Set<string>(),
    matchOrder: []
  };
}
