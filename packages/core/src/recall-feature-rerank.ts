import { splitLexicalTokens, type RecallQueryProbes } from "./recall-query-probes.js";

// Deterministic, post-fusion feature rerank. Reorders the top-N of the
// fusion-ranked candidate list using lexical features computed from the
// already-retrieved query and candidate text. No model, no API, no
// embedding — pure computation over text already in hand.
//
// The rerank does not replace fusion: it blends a [0,1] lexical feature
// score with the head-max-normalized fusion score. The protection it
// gives fusion is a fusion-*ratio* guarantee, not a signal-type one:
// a near-tie whose normalized fusion ratio sits within the
// `rerank_weight` headroom can be reordered by lexical features, while a
// decisive fusion lead cannot. The blend is blind to which fusion stream
// produced the lead. This is the "promote the genuine best match among
// close fusion candidates" lever.

/**
 * Number of head candidates the rerank reorders. Candidates below this
 * cut keep their incoming fusion order untouched. The cut also bounds the
 * pool over which pool-local IDF (`rare_term_coverage`) is computed.
 */
export const RECALL_RERANK_TOP_N = 50;

/**
 * Blend weights for the final rerank score:
 *   final = fusion_weight * normalizedFusion + rerank_weight * lexicalScore
 * `fusion_weight` keeps a decisive fusion gap authoritative; `rerank_weight`
 * is the headroom within which lexical features can reorder near-ties.
 * Single-source tunable constants — the bench-tuning loop sweeps these.
 */
export const RECALL_RERANK_BLEND = Object.freeze({
  fusion_weight: 1.0,
  rerank_weight: 0.35
});

/**
 * Feature weights inside the lexical rerank score. Each feature yields a
 * value in [0, 1]; their weighted sum is normalized by the weight total so
 * the lexical score itself stays in [0, 1]. Tunable — the orchestrator
 * sweeps these.
 */
export const RECALL_RERANK_WEIGHTS = Object.freeze({
  /** Verbatim phrase / query-span appears in the candidate content. */
  exact_phrase: 1.0,
  /** Fraction of distinct query content-terms present in the candidate. */
  term_coverage: 0.8,
  /**
   * Matched query terms weighted by their rarity across the rerank
   * candidate pool. A term present in few candidates is discriminative
   * (it marks the answer-bearing memory); a term present in most is
   * generic topic noise. This separates the gold from saturated topical
   * neighbours where plain `term_coverage` cannot.
   */
  rare_term_coverage: 0.9,
  /** Matched query terms appear close together (small window). */
  proximity: 0.4
});

/**
 * Field-aware multiplier: a hit in the distilled `memory_entry.content`
 * gets full credit; a candidate with no content hit but a raw-evidence
 * lexical hit gets this damped credit so it is not blindly sunk.
 */
export const RECALL_RERANK_EVIDENCE_ONLY_FACTOR = 0.4;

/**
 * Minimum distinct query terms required before term-coverage / proximity
 * features are trusted. Below this the query is too thin to rerank on and
 * those features yield 0 (exact-phrase still applies).
 */
export const RECALL_RERANK_MIN_QUERY_TERMS = 1;

/** Candidate text exposed to the rerank stage. */
export interface RerankCandidateText {
  /** The distilled `memory_entry.content`. */
  readonly content: string;
  /**
   * True when this candidate carries a raw-evidence lexical (FTS) hit but
   * the query did not match its distilled content — used for field-aware
   * weighting so an evidence-only match keeps damped credit.
   */
  readonly hasEvidenceLexicalHit: boolean;
}

export interface RerankFeatureBreakdown {
  readonly exactPhrase: number;
  readonly termCoverage: number;
  /** IDF-weighted term coverage in [0, 1]; 0 when no pool IDF is supplied. */
  readonly rareTermCoverage: number;
  readonly proximity: number;
  readonly fieldFactor: number;
  /** Lexical feature score in [0, 1] (pre-blend). */
  readonly score: number;
}

/**
 * Pool-local inverse-document-frequency over the rerank candidate set.
 * `idf(term)` is high for a term present in few candidates (discriminative)
 * and low for a term present in most (generic topic noise). Built once per
 * rerank pass from the top-N candidates' content the rerank already holds —
 * no retrieval, no corpus scan, deterministic.
 */
export interface RerankPoolIdf {
  /** Number of candidates the document-frequency was counted over. */
  readonly poolSize: number;
  /** Document frequency: distinct candidates whose content contains the term. */
  readonly documentFrequency: ReadonlyMap<string, number>;
}

export interface RerankCandidate<T> {
  readonly item: T;
  readonly text: RerankCandidateText;
  /** The fusion stage's `fused_score` for this candidate. */
  readonly fusionScore: number;
}

const WEIGHT_TOTAL =
  RECALL_RERANK_WEIGHTS.exact_phrase +
  RECALL_RERANK_WEIGHTS.term_coverage +
  RECALL_RERANK_WEIGHTS.rare_term_coverage +
  RECALL_RERANK_WEIGHTS.proximity;

/**
 * Normalize candidate text to a deterministic lowercased term list. Uses
 * the same `splitLexicalTokens` helper as the query-probe tokenizer so
 * query terms and candidate terms tokenize under one identical rule. The
 * candidate side intentionally keeps stop words: a query content-term
 * that collides with a stop word must still match in the haystack.
 */
function tokenize(value: string): readonly string[] {
  return splitLexicalTokens(value);
}

/**
 * Build pool-local document-frequency counts over a set of candidate
 * contents — one tokenize per candidate, distinct terms per candidate
 * counted once. Deterministic and order-independent. Exported for unit
 * testing the IDF stage in isolation.
 */
export function buildRerankPoolIdf(contents: readonly string[]): RerankPoolIdf {
  const documentFrequency = new Map<string, number>();
  for (const content of contents) {
    const distinct = new Set(tokenize(content ?? ""));
    for (const term of distinct) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  return Object.freeze({
    poolSize: contents.length,
    documentFrequency
  });
}

/**
 * Standard smoothed inverse document frequency over the rerank pool:
 *   idf(term) = log((N + 1) / (df(term) + 1))
 * The `+1` smoothing keeps the value finite and non-negative for every
 * term, including a term absent from the pool. A pool of size 0 has no
 * frequency signal and yields 0.
 */
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
  if (matchedTerms.size <= 1) {
    // A single matched term has no proximity signal; coverage already
    // credits it. Two+ scattered terms are what proximity discriminates.
    return 0;
  }
  // Smallest window covering every distinct matched term.
  let bestSpan = Number.MAX_SAFE_INTEGER;
  const distinctNeeded = matchedTerms.size;
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
      const span =
        (matchedPositions[right] as number) - (matchedPositions[left] as number) + 1;
      if (span < bestSpan) {
        bestSpan = span;
      }
      const leftTerm = haystackTokens[matchedPositions[left] as number] as string;
      const leftCount = (windowCounts.get(leftTerm) ?? 0) - 1;
      windowCounts.set(leftTerm, leftCount);
      if (leftCount === 0) {
        satisfied -= 1;
      }
      left += 1;
    }
  }
  if (bestSpan === Number.MAX_SAFE_INTEGER) {
    return 0;
  }
  // span === distinctNeeded means perfectly adjacent → 1; as the window
  // grows the score decays toward 0.
  return distinctNeeded / bestSpan;
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
  const queryTerms = query.lexical_terms;
  const content = text.content ?? "";
  const haystackTokens = tokenize(content);
  const haystackTermSet = new Set(haystackTokens);

  const exactPhrase = scoreExactPhrase(
    query.normalized_query,
    query.phrases,
    queryTerms.length > 0,
    content
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
    : text.hasEvidenceLexicalHit
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

/**
 * Reorder the top-N of a fusion-ranked candidate list by blending the
 * fusion score with a deterministic lexical feature score. Candidates
 * below the top-N cut keep their incoming order.
 *
 * The blend (`RECALL_RERANK_BLEND`) keeps a decisive fusion lead
 * authoritative: a near-tie within the `rerank_weight` headroom can be
 * reordered by lexical features, but a decisive fusion lead cannot. This
 * is a fusion-ratio guarantee, not a signal-type guarantee — it does not
 * know which fusion stream produced the lead. The sort is stable on the
 * incoming fusion order, so a degenerate (empty / featureless) query is a
 * guaranteed no-op.
 *
 * Pure function — no I/O, no shared state. `candidates` MUST already be in
 * fusion rank order (best first).
 */
export function rerankTopN<T>(
  query: Readonly<RecallQueryProbes>,
  candidates: readonly RerankCandidate<T>[],
  topN: number = RECALL_RERANK_TOP_N
): readonly T[] {
  if (candidates.length === 0) {
    return Object.freeze([]);
  }
  const cut = Math.max(0, Math.min(topN, candidates.length));
  if (cut <= 1) {
    return Object.freeze(candidates.map((candidate) => candidate.item));
  }

  const hasQuerySignal =
    (query.normalized_query !== null && query.normalized_query.trim().length > 0) ||
    query.lexical_terms.length > 0 ||
    query.phrases.length > 0;
  if (!hasQuerySignal) {
    return Object.freeze(candidates.map((candidate) => candidate.item));
  }

  const head = candidates.slice(0, cut);
  const tail = candidates.slice(cut);

  // Pool-local IDF over exactly the head the rerank reorders: a query term
  // present in few head candidates is discriminative; one present in most
  // is generic topic noise. This is the signal that separates the gold
  // from its saturated topical neighbours.
  const poolIdf = buildRerankPoolIdf(head.map((candidate) => candidate.text.content));

  // Normalize fusion scores by the head maximum. Dividing by the max (not
  // min-max) keeps each candidate's proportional gap intact: a decisive
  // fusion lead stays a wide gap the lexical headroom cannot close, while
  // a near-tie stays a narrow gap the lexical signal can flip. When every
  // head candidate shares one fusion score, all normalize to 1 and the
  // rerank decides alone.
  let maxFusion = Number.NEGATIVE_INFINITY;
  for (const candidate of head) {
    if (candidate.fusionScore > maxFusion) {
      maxFusion = candidate.fusionScore;
    }
  }

  const scored = head.map((candidate, fusionIndex) => {
    const normalizedFusion =
      maxFusion > 0 ? candidate.fusionScore / maxFusion : 1;
    const lexicalScore = computeRerankFeatures(query, candidate.text, poolIdf).score;
    const blended =
      RECALL_RERANK_BLEND.fusion_weight * normalizedFusion +
      RECALL_RERANK_BLEND.rerank_weight * lexicalScore;
    return Object.freeze({ fusionIndex, item: candidate.item, blended });
  });

  const reordered = [...scored].sort((left, right) => {
    const delta = right.blended - left.blended;
    if (delta !== 0) {
      return delta;
    }
    // Stable: fall back to incoming fusion order on ties.
    return left.fusionIndex - right.fusionIndex;
  });

  return Object.freeze([
    ...reordered.map((entry) => entry.item),
    ...tail.map((candidate) => candidate.item)
  ]);
}
