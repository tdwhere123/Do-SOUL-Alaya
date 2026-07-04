import { FACET_VOCABULARY } from "@do-soul/alaya-protocol";
import { recallEnvRaw } from "../../config/recall-env-access.js";
import { deriveFacetsFromText } from "../expansion/facet-keywords.js";
import type { RecallQueryProbes } from "./recall-query-probes.js";

// Bench A/B hook: ALAYA_RECALL_QUERY_FACETS_JSON ({query: facets}) overrides the keyword hints to measure router headroom.
let injectedFacetsCache: Readonly<Record<string, readonly string[]>> | null = null;
function injectedQueryFacets(): Readonly<Record<string, readonly string[]>> {
  if (injectedFacetsCache === null) {
    const raw = recallEnvRaw("ALAYA_RECALL_QUERY_FACETS_JSON");
    try {
      injectedFacetsCache = raw === undefined || raw.length === 0 ? {} : JSON.parse(raw);
    } catch {
      injectedFacetsCache = {};
    }
  }
  return injectedFacetsCache ?? {};
}

export function deriveQuerySoughtFacets(queryProbes: Readonly<RecallQueryProbes>): readonly string[] {
  const query = queryProbes.normalized_query;
  if (query === null || query.length === 0) {
    return Object.freeze([]);
  }
  const injected = injectedQueryFacets()[query];
  if (injected !== undefined) {
    return Object.freeze(injected.filter((facet) => FACET_VOCABULARY.includes(facet)));
  }
  return deriveFacetsFromText(query);
}
