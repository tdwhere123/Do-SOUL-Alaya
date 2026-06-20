import type { RecallQueryProbes } from "./recall-query-probes.js";
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

/**
 * Exact-phrase feature: 1 when any salient query span appears verbatim.
 * The bare full-query fallback only fires when the query carries at least
 * one content term; a stop-word-only query (e.g. "the") has no content
 * signal and must not award spurious exact-phrase credit.
 */
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

/**
 * Rare-term-coverage feature: like term-coverage, but each matched query
 * term contributes its pool-local IDF weight instead of a flat 1. The
 * result is the matched IDF mass over the total query IDF mass, so it
 * stays in [0, 1]. A candidate that matches the rare, answer-bearing
 * terms scores high; one that matches only common topic terms scores low,
 * even when its plain term-coverage is identical.
 *
 * Yields 0 when the query is too thin (mirrors term-coverage), when no
 * pool IDF is supplied, or when the total query IDF mass is 0 (every
 * matched-or-unmatched term is maximally common — no rarity signal).
 *
 * Two consequences worth stating: (1) on a fully topic-saturated pool —
 * every query term in every candidate — this feature contributes 0 even
 * to a full-coverage candidate, and `term_coverage` carries that case
 * alone; the discriminating gain therefore comes from *partially*
 * saturated pools, which is the LongMemEval distractor-cluster shape this
 * targets. (2) A query term absent from the whole pool earns the maximum
 * IDF and so inflates `totalIdf` (the denominator) without ever adding to
 * `matchedIdf` — it legitimately dampens every candidate's score, since
 * "no candidate matches a rare query term" means none is a strong hit.
 */
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

/**
 * Proximity feature: query terms appearing in a tight window score higher
 * than scattered ones. Computes the smallest token-span window that
 * contains every matched query term, then maps span → [0, 1].
 */
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

/**
 * Compute the deterministic lexical rerank feature breakdown for one
 * candidate. The `score` is in [0, 1]. Exported for unit testing the
 * scorer in isolation.
 *
 * `poolIdf` carries pool-local term rarity over the rerank candidate set;
 * when omitted (or `null`) the `rare_term_coverage` feature contributes 0,
 * so the scorer stays well-defined for an empty pool or a single-candidate
 * call.
 */
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

/**
 * Self-contained token-diversity damp for the gist path. Returns 1 when the
 * gist's distinct-token ratio is at or above GIST_MIN_DIVERSITY_RATIO; below
 * that, scales linearly to 0 at ratio 0. The mapping
 * `damp = ratio / GIST_MIN_DIVERSITY_RATIO` keeps the boundary continuous
 * (ratio == threshold -> damp == 1, ratio == 0.1 -> damp == 0.2) so there is
 * no cliff that bench tuning could exploit. Short gists
 * (<= GIST_SHORT_TOKEN_THRESHOLD tokens) yield 1: legitimate emphatic
 * answers ("yes yes yes", "ok ok ok ok") naturally collapse this ratio and
 * the upper EVIDENCE_GIST_WEIGHT cap already bounds their amplification.
 */
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
 * Self-contained query-term concentration damp for the gist path. Returns
 * 1 when the gist's distinct-query-token density
 * (distinctQueryTokensPresent / totalTokens — each unique query term that
 * appears in the gist counts once regardless of repetition) is at or below
 * GIST_QUERY_CONCENTRATION_THRESHOLD; above that, ramps linearly to
 * GIST_CONCENTRATION_MIN_DAMP across a window of width
 * GIST_CONCENTRATION_RAMP. Catches the padding-bypass attack the
 * distinct-token damp misses: the attacker pads the query phrase with
 * distinct nonsense tokens so uniqueTokens/totalTokens stays near 1.0,
 * but distinct query terms still dominate the gist.
 *
 * invariant: repeating the same query word does not increase concentration —
 * distinct counting bounds the numerator by querySet size while padding
 * scales the denominator.
 * invariant: short gists (<= GIST_SHORT_TOKEN_THRESHOLD tokens) skip the
 * damp — a one-word answer that literally is the query term is a
 * legitimate gist shape and carries no amplification headroom under the
 * EVIDENCE_GIST_WEIGHT cap.
 * invariant: empty query (no lexical_terms) yields 1 — nothing to
 * concentrate on.
 * see also: GIST_QUERY_CONCENTRATION_THRESHOLD / GIST_CONCENTRATION_RAMP
 * / GIST_CONCENTRATION_MIN_DAMP constants above for the boundary tuning
 * rationale.
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

  // Field-aware weighting: full credit when the query matched the distilled
  // content; damped credit when the only lexical signal is in the raw
  // evidence excerpt (a separate, lower-trust field).
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
