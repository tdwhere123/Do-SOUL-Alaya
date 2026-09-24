import type { SourceSemanticCorrespondenceEndpointCatalog } from "@do-soul/alaya-protocol";

type TestPair = Readonly<{
  query: string;
  source: string;
  query_excerpt: string;
  source_semantic_support: readonly unknown[];
  applicable_context?: string;
}>;

/** Test fixtures supply intended positive pairs; every other advertised endpoint stays explicitly open. */
export function assessmentForTestPairs(
  catalog: SourceSemanticCorrespondenceEndpointCatalog, originalQuery: string, pairs: readonly TestPair[]
) {
  return catalog.query_endpoints.map((endpoint) => {
    const equivalents = pairs.filter((pair) => pair.query === endpoint.handle).map(({ query: _query, ...pair }) => ({
      ...pair, grounding: "The cited source support grounds this local relation."
    }));
    return equivalents.length > 0
      ? { query: endpoint.handle, status: "supported", equivalents }
      : { query: endpoint.handle, status: "unresolved", query_excerpt: originalQuery.slice(0, 1),
        explanation: "No equivalent source endpoint is proposed in this fixture." };
  });
}
