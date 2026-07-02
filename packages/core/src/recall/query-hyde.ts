// invariant: ALAYA_RECALL_QUERY_HYDE_JSON maps normalized query text to
// precomputed hypothetical-answer text; absent, invalid, or missing entries
// preserve the original query text.
function parseHydeMap(raw: string): Readonly<Record<string, string>> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") {
        result[key] = value;
      }
    }
    return result;
  } catch {
    return {};
  }
}

let hydeCache: Readonly<Record<string, string>> | null = null;

function injectedHyde(): Readonly<Record<string, string>> {
  if (hydeCache === null) {
    const raw = process.env.ALAYA_RECALL_QUERY_HYDE_JSON;
    if (raw === undefined || raw.length === 0) {
      hydeCache = {};
    } else {
      try {
        hydeCache = parseHydeMap(raw);
      } catch {
        hydeCache = {};
      }
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
