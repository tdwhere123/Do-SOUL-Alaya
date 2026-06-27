// HyDE hook: ALAYA_RECALL_QUERY_HYDE_JSON ({normalizedQuery: hypothesisText}) replaces the
// embedding query text with a hypothetical answer, bridging query->latent-fact for retrieval
// (e.g. "recommend video-editing resources" -> "The user uses Adobe Premiere Pro"). Absent/empty
// JSON or no match -> returns the query unchanged (byte-identical). LLM-precomputed for A/B.
let hydeCache: Readonly<Record<string, string>> | null = null;

function injectedHyde(): Readonly<Record<string, string>> {
  if (hydeCache === null) {
    const raw = process.env.ALAYA_RECALL_QUERY_HYDE_JSON;
    try {
      hydeCache = raw === undefined || raw.length === 0 ? {} : JSON.parse(raw);
    } catch {
      hydeCache = {};
    }
  }
  return hydeCache ?? {};
}

function normalizeHydeKey(queryText: string): string {
  return queryText.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}

export function resolveHydeQueryText(queryText: string | null): string | null {
  if (queryText === null) {
    return null;
  }
  const hypothesis = injectedHyde()[normalizeHydeKey(queryText)];
  return hypothesis !== undefined && hypothesis.length > 0 ? hypothesis : queryText;
}
