import type { RecallQueryProbes } from "../query/recall-query-probes.js";
import {
  EVIDENCE_GIST_WEIGHT,
  GIST_CONCENTRATION_MIN_DAMP,
  GIST_CONCENTRATION_RAMP,
  GIST_MAX_CHARS,
  GIST_MIN_DIVERSITY_RATIO,
  GIST_QUERY_CONCENTRATION_THRESHOLD,
  GIST_SHORT_TOKEN_THRESHOLD,
  RECALL_RERANK_EVIDENCE_ONLY_FACTOR,
  RECALL_RERANK_MIN_QUERY_TERMS,
  RECALL_RERANK_WEIGHTS,
  WEIGHT_TOTAL,
  tokenize,
  type RerankCandidateText,
  type RerankFeatureBreakdown,
  type RerankPoolIdf
} from "./recall-feature-rerank-model.js";

function poolTermIdf(pool: RerankPoolIdf, term: string): number {
  if (pool.poolSize <= 0) {
    return 0;
  }
  const df = pool.documentFrequency.get(term) ?? 0;
  return Math.log((pool.poolSize + 1) / (df + 1));
}

/** Exact-phrase feature: 1 when a salient query span appears verbatim. Full-query fallback fires only with >=1 content term, so a stop-word-only query earns no credit. */
function scoreExactPhrase(
  normalizedQuery: string | null,
  phrases: readonly string[],
  hasContentTerms: boolean,
  haystack: string
): number {
  if (haystack.length === 0) {
    return 0;
  }
  const lowered = haystack.toLocaleLowerCase();
  for (const phrase of phrases) {
    const candidate = phrase.trim().toLocaleLowerCase();
    if (candidate.length >= 3 && lowered.includes(candidate)) {
      return 1;
    }
  }
  if (normalizedQuery !== null && hasContentTerms) {
    const fullQuery = normalizedQuery.trim().toLocaleLowerCase();
    if (fullQuery.length >= 3 && lowered.includes(fullQuery)) {
      return 1;
    }
  }
  return 0;
}

/** Term-coverage feature: fraction of distinct query terms in the haystack. */
function scoreTermCoverage(
  queryTerms: readonly string[],
  haystackTerms: ReadonlySet<string>
): number {
  if (queryTerms.length < RECALL_RERANK_MIN_QUERY_TERMS) {
    return 0;
  }
  let hits = 0;
  for (const term of queryTerms) {
    if (haystackTerms.has(term)) {
      hits += 1;
    }
  }
  return hits / queryTerms.length;
}

/** Rare-term-coverage: matched IDF mass over total query IDF mass (in [0,1]); rewards matching rare answer-bearing terms over common topic terms at equal plain coverage. Yields 0 on a thin query, no pool IDF, or zero total IDF mass (fully topic-saturated pool — term_coverage carries that case). */
function scoreRareTermCoverage(
  queryTerms: readonly string[],
  haystackTerms: ReadonlySet<string>,
  pool: RerankPoolIdf | null
): number {
  if (queryTerms.length < RECALL_RERANK_MIN_QUERY_TERMS || pool === null) {
    return 0;
  }
  let matchedIdf = 0;
  let totalIdf = 0;
  for (const term of queryTerms) {
    const idf = poolTermIdf(pool, term);
    totalIdf += idf;
    if (haystackTerms.has(term)) {
      matchedIdf += idf;
    }
  }
  if (totalIdf <= 0) {
    return 0;
  }
  return matchedIdf / totalIdf;
}

/** Proximity feature: smallest token-span window containing every matched query term, mapped span → [0,1]; tight windows score higher than scattered. */
function scoreProximity(
  queryTerms: readonly string[],
  haystackTokens: readonly string[]
): number {
  if (queryTerms.length < RECALL_RERANK_MIN_QUERY_TERMS || haystackTokens.length === 0) {
    return 0;
  }
  const matched = collectMatchedQueryTerms(queryTerms, haystackTokens);
  const distinctNeeded = matched.matchedTerms.size;
  if (distinctNeeded <= 1) {
    return 0;
  }
  const bestSpan = findTightestMatchedSpan(
    matched.matchedPositions,
    haystackTokens,
    distinctNeeded
  );
  return bestSpan === null ? 0 : distinctNeeded / bestSpan;
}

function collectMatchedQueryTerms(
  queryTerms: readonly string[],
  haystackTokens: readonly string[]
): Readonly<{
  readonly matchedPositions: readonly number[];
  readonly matchedTerms: ReadonlySet<string>;
}> {
  const querySet = new Set(queryTerms);
  const matchedPositions: number[] = [];
  const matchedTerms = new Set<string>();
  for (let i = 0; i < haystackTokens.length; i += 1) {
    const token = haystackTokens[i];
    if (token !== undefined && querySet.has(token)) {
      matchedPositions.push(i);
      matchedTerms.add(token);
    }
  }
  return Object.freeze({ matchedPositions, matchedTerms });
}

function findTightestMatchedSpan(
  matchedPositions: readonly number[],
  haystackTokens: readonly string[],
  distinctNeeded: number
): number | null {
  let bestSpan = Number.MAX_SAFE_INTEGER;
  const windowCounts = new Map<string, number>();
  let left = 0;
  let satisfied = 0;
  for (let right = 0; right < matchedPositions.length; right += 1) {
    const rightTerm = haystackTokens[matchedPositions[right] as number] as string;
    const nextCount = (windowCounts.get(rightTerm) ?? 0) + 1;
    windowCounts.set(rightTerm, nextCount);
    if (nextCount === 1) {
      satisfied += 1;
    }
    while (satisfied === distinctNeeded) {
      bestSpan = Math.min(
        bestSpan,
        (matchedPositions[right] as number) - (matchedPositions[left] as number) + 1
      );
      const leftTerm = haystackTokens[matchedPositions[left] as number] as string;
      const leftCount = (windowCounts.get(leftTerm) ?? 0) - 1;
      windowCounts.set(leftTerm, leftCount);
      if (leftCount === 0) {
        satisfied -= 1;
      }
      left += 1;
    }
  }
  return bestSpan === Number.MAX_SAFE_INTEGER ? null : bestSpan;
}

/** Deterministic lexical rerank feature breakdown for one candidate (score in [0,1]). With poolIdf null, rare_term_coverage contributes 0 so the scorer stays well-defined for an empty/single-candidate pool. */
export function computeRerankFeatures(
  query: Readonly<RecallQueryProbes>,
  text: RerankCandidateText,
  poolIdf: RerankPoolIdf | null = null
): RerankFeatureBreakdown {
  const contentBreakdown = computeRerankFeaturesForField(query, text.content ?? "", poolIdf, {
    hasEvidenceLexicalHit: text.hasEvidenceLexicalHit
  });
  const gistText = normalizeEvidenceGist(text.evidenceGist);
  if (gistText === null) {
    return contentBreakdown;
  }
  const gistBreakdown = computeGistBreakdown(query, gistText);
  const gistFieldFactor = resolveGistFieldFactor(
    contentBreakdown,
    text.hasEvidenceLexicalHit,
    gistText,
    query
  );
  const weightedGistScore = gistBreakdown.score * EVIDENCE_GIST_WEIGHT * gistFieldFactor;
  if (weightedGistScore <= contentBreakdown.score) {
    return contentBreakdown;
  }
  return buildWeightedGistBreakdown(gistBreakdown, weightedGistScore, gistFieldFactor);
}

function normalizeEvidenceGist(rawGist: string | null | undefined): string | null {
  const trimmed = rawGist?.trim() ?? "";
  if (trimmed.length === 0) {
    return null;
  }
  return trimmed.length > GIST_MAX_CHARS ? trimmed.slice(0, GIST_MAX_CHARS) : trimmed;
}

function computeGistBreakdown(
  query: Readonly<RecallQueryProbes>,
  gistText: string
): RerankFeatureBreakdown {
  return computeRerankFeaturesForField(query, gistText, null, {
    hasEvidenceLexicalHit: false
  });
}

function resolveGistFieldFactor(
  contentBreakdown: RerankFeatureBreakdown,
  hasEvidenceLexicalHit: boolean,
  gistText: string,
  query: Readonly<RecallQueryProbes>
): number {
  const contentHadSignal =
    contentBreakdown.exactPhrase > 0 || contentBreakdown.termCoverage > 0;
  const gistEvidenceOnlyDamp =
    !contentHadSignal && hasEvidenceLexicalHit
      ? RECALL_RERANK_EVIDENCE_ONLY_FACTOR
      : 1;
  const gistDiversityDamp = Math.min(
    computeGistDiversityDamp(gistText),
    computeGistConcentrationDamp(gistText, query)
  );
  return gistEvidenceOnlyDamp * gistDiversityDamp;
}

function buildWeightedGistBreakdown(
  gistBreakdown: RerankFeatureBreakdown,
  weightedGistScore: number,
  gistFieldFactor: number
): RerankFeatureBreakdown {
  return Object.freeze({
    exactPhrase: gistBreakdown.exactPhrase,
    termCoverage: gistBreakdown.termCoverage,
    rareTermCoverage: gistBreakdown.rareTermCoverage,
    proximity: gistBreakdown.proximity,
    fieldFactor: gistFieldFactor,
    score: weightedGistScore
  });
}

/** Token-diversity damp for the gist path: 1 at/above GIST_MIN_DIVERSITY_RATIO, linear to 0 below (continuous, no exploitable cliff). Short gists (<= GIST_SHORT_TOKEN_THRESHOLD) yield 1. */
function computeGistDiversityDamp(gistText: string): number {
  const tokens = tokenize(gistText);
  if (tokens.length <= GIST_SHORT_TOKEN_THRESHOLD) {
    return 1;
  }
  const distinct = new Set(tokens).size;
  const ratio = distinct / tokens.length;
  if (ratio >= GIST_MIN_DIVERSITY_RATIO) {
    return 1;
  }
  return ratio / GIST_MIN_DIVERSITY_RATIO;
}

/**
 * Query-term concentration damp for the gist path: 1 at/below GIST_QUERY_CONCENTRATION_THRESHOLD, ramps to GIST_CONCENTRATION_MIN_DAMP over GIST_CONCENTRATION_RAMP above it; catches the distinct-padding bypass the diversity damp misses.
 * invariant: distinct counting bounds the numerator by querySet size, so repeating a query word cannot raise concentration.
 * invariant: short gists (<= GIST_SHORT_TOKEN_THRESHOLD) and empty queries yield 1 — no amplification headroom / nothing to concentrate.
 * see also: GIST_QUERY_CONCENTRATION_THRESHOLD, GIST_CONCENTRATION_RAMP, GIST_CONCENTRATION_MIN_DAMP.
 */
function computeGistConcentrationDamp(
  gistText: string,
  query: Readonly<RecallQueryProbes>
): number {
  const queryTerms = query.lexical_terms;
  if (queryTerms.length === 0) {
    return 1;
  }
  const tokens = tokenize(gistText);
  if (tokens.length <= GIST_SHORT_TOKEN_THRESHOLD) {
    return 1;
  }
  const querySet = new Set(queryTerms);
  const distinctQueryTokensPresent = new Set(
    tokens.filter((token) => querySet.has(token))
  ).size;
  const density = distinctQueryTokensPresent / tokens.length;
  if (density <= GIST_QUERY_CONCENTRATION_THRESHOLD) {
    return 1;
  }
  const excess = density - GIST_QUERY_CONCENTRATION_THRESHOLD;
  const damp = 1 - excess / GIST_CONCENTRATION_RAMP;
  return Math.max(GIST_CONCENTRATION_MIN_DAMP, damp);
}

function computeRerankFeaturesForField(
  query: Readonly<RecallQueryProbes>,
  fieldText: string,
  poolIdf: RerankPoolIdf | null,
  options: Readonly<{ readonly hasEvidenceLexicalHit: boolean }>
): RerankFeatureBreakdown {
  const queryTerms = query.lexical_terms;
  const haystackTokens = tokenize(fieldText);
  const haystackTermSet = new Set(haystackTokens);

  const exactPhrase = scoreExactPhrase(
    query.normalized_query,
    query.phrases,
    queryTerms.length > 0,
    fieldText
  );
  const termCoverage = scoreTermCoverage(queryTerms, haystackTermSet);
  const rareTermCoverage = scoreRareTermCoverage(queryTerms, haystackTermSet, poolIdf);
  const proximity = scoreProximity(queryTerms, haystackTokens);

  // Field-aware: full credit on a distilled-content match, damped credit when the only signal is the lower-trust raw evidence.
  const hasContentSignal = exactPhrase > 0 || termCoverage > 0;
  const fieldFactor = hasContentSignal
    ? 1
    : options.hasEvidenceLexicalHit
      ? RECALL_RERANK_EVIDENCE_ONLY_FACTOR
      : 1;

  const weighted =
    RECALL_RERANK_WEIGHTS.exact_phrase * exactPhrase +
    RECALL_RERANK_WEIGHTS.term_coverage * termCoverage +
    RECALL_RERANK_WEIGHTS.rare_term_coverage * rareTermCoverage +
    RECALL_RERANK_WEIGHTS.proximity * proximity;

  return Object.freeze({
    exactPhrase,
    termCoverage,
    rareTermCoverage,
    proximity,
    fieldFactor,
    score: (weighted / WEIGHT_TOTAL) * fieldFactor
  });
}
