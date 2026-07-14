import { uniqueStrings } from "../../expansion/path-relations.js";
import type { RecallQueryProbes } from "../../query/recall-query-probes.js";

export function buildEvidenceSearchQueries(
  queryText: string,
  queryProbes: Readonly<RecallQueryProbes>
): readonly string[] {
  return uniqueStrings([
    queryText,
    ...buildInformativeEvidenceSearchQueries(queryProbes)
  ].map((value) => value.trim()).filter((value) => value.length > 0));
}

export function buildInformativeEvidenceSearchQueries(
  queryProbes: Readonly<RecallQueryProbes>
): readonly string[] {
  const phraseQueries = queryProbes.phrases
    .filter((phrase) => phrase.length >= 3)
    .slice(0, 8);
  const lexicalQuery = queryProbes.lexical_terms.slice(0, 8).join(" ");
  const expandedQuery = queryProbes.expanded_terms.slice(0, 8).join(" ");
  return uniqueStrings([
    ...phraseQueries,
    lexicalQuery,
    expandedQuery,
    ...queryProbes.date_terms.slice(0, 6)
  ].map((value) => value.trim()).filter((value) => value.length > 0));
}

/** Evidence FTS probes only; raw NL is fallback when no informative probes exist. */
export function selectEvidenceSearchQueries(
  queryText: string,
  queryProbes: Readonly<RecallQueryProbes>
): readonly string[] {
  const informativeQueries = buildInformativeEvidenceSearchQueries(queryProbes);
  if (informativeQueries.length > 0) {
    return informativeQueries;
  }
  const fallback = queryText.trim();
  return fallback.length === 0 ? [] : [fallback];
}
