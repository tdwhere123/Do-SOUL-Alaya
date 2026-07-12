import { deriveFacetsFromText } from "../expansion/facet-keywords.js";
import type { RecallQueryProbes } from "./recall-query-probes.js";

export function deriveQuerySoughtFacets(queryProbes: Readonly<RecallQueryProbes>): readonly string[] {
  const query = queryProbes.normalized_query;
  if (query === null || query.length === 0) {
    return Object.freeze([]);
  }
  return deriveFacetsFromText(query);
}
