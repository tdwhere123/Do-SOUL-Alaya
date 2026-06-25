import { splitLexicalTokens } from "./recall-query-probes.js";

// Deterministic post-fusion feature rerank: reorders top-N by lexical features over query+candidate text (no model/API/embedding). Blends [0,1] lexical score with head-max-normalized fusion; only near-ties within the rerank_weight headroom reorder, a decisive fusion lead cannot.

/** Head candidates the rerank reorders; also bounds the pool-local IDF pool. Below this cut, incoming fusion order is untouched. */
export const RECALL_RERANK_TOP_N = 50;

/** Blend: final = fusion_weight*normalizedFusion + rerank_weight*lexicalScore. rerank_weight is the near-tie reorder headroom. Tunable. */
export const RECALL_RERANK_BLEND = Object.freeze({
  fusion_weight: 1.0,
  rerank_weight: 0.35
});

/** Feature weights in the lexical rerank score; weighted sum normalized to [0,1]. Tunable. */
export const RECALL_RERANK_WEIGHTS = Object.freeze({
  /** Verbatim phrase / query-span appears in the candidate content. */
  exact_phrase: 1.0,
  /** Fraction of distinct query content-terms present in the candidate. */
  term_coverage: 0.8,
  /** Matched terms weighted by pool-local rarity; separates gold from topic-saturated neighbours that term_coverage cannot. */
  rare_term_coverage: 0.9,
  /** Matched query terms appear close together (small window). */
  proximity: 0.4
});

/** Field-aware multiplier: damped credit for a candidate whose only lexical hit is in raw evidence, not distilled content. */
export const RECALL_RERANK_EVIDENCE_ONLY_FACTOR = 0.4;

/** Evidence-gist feature weight: scorer takes max(content_score, WEIGHT*gist_score) so a gist match can win when content missed. Below 1 because gist is a paraphrase, not the source. Tunable. */
export const EVIDENCE_GIST_WEIGHT = 0.7;

/** Safety cap on gist length fed to the rerank tokenizer: gist is attacker-controlled (unbounded at protocol layer), so an oversized payload is hard-truncated to bound the per-pass O(n) work. Not a tuning knob. */
export const GIST_MAX_CHARS = 8192;

/** Diversity floor (uniqueTokens/totalTokens) below which the gist score is linearly damped; catches repeat-amplification on the pool-IDF-free gist path. */
export const GIST_MIN_DIVERSITY_RATIO = 0.5;

/** Token count below which both gist damps are skipped: short emphatic answers ("yes yes yes") carry no amplification headroom and are false positives. */
export const GIST_SHORT_TOKEN_THRESHOLD = 4;

/**
 * Query-term concentration threshold (distinctQueryTokensPresent/totalTokens) for the second gist damp; above it the damp ramps to the floor, catching the padding-bypass shape the diversity damp misses.
 * invariant: distinct counting bounds the numerator by querySet size, so repeating one query word cannot raise density — bypass space shrinks under repetition.
 */
export const GIST_QUERY_CONCENTRATION_THRESHOLD = 0.55;

/** Ramp width of the concentration damp above GIST_QUERY_CONCENTRATION_THRESHOLD; linear so the damp stays continuous across the threshold (no exploitable cliff). */
export const GIST_CONCENTRATION_RAMP = 0.5;

/** Floor of the concentration damp: a fully query-stuffed gist is suspicious but not provably adversarial, so demote decisively without zeroing. */
export const GIST_CONCENTRATION_MIN_DAMP = 0.2;

/** Min distinct query terms before term-coverage/proximity are trusted; below this they yield 0 (exact-phrase still applies). */
export const RECALL_RERANK_MIN_QUERY_TERMS = 1;

/** Candidate text exposed to the rerank stage. */
export interface RerankCandidateText {
  /** The distilled `memory_entry.content`. */
  readonly content: string;
  /** Candidate has a raw-evidence FTS hit but no distilled-content match; drives the field-aware damped credit. */
  readonly hasEvidenceLexicalHit: boolean;
  /** Best-rank evidence-capsule gist; when present the scorer also scores against it and takes max(content, WEIGHT*gist). Absent → content-only. */
  readonly evidenceGist?: string;
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

/** Pool-local IDF over the rerank candidate set: high for rare/discriminative terms, low for generic topic noise. Built once per pass from held top-N content; no retrieval, deterministic. */
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

export const WEIGHT_TOTAL =
  RECALL_RERANK_WEIGHTS.exact_phrase +
  RECALL_RERANK_WEIGHTS.term_coverage +
  RECALL_RERANK_WEIGHTS.rare_term_coverage +
  RECALL_RERANK_WEIGHTS.proximity;

/** Lowercased term list via the same splitLexicalTokens as the query side; keeps stop words so a query content-term colliding with one still matches. */
export function tokenize(value: string): readonly string[] {
  return splitLexicalTokens(value);
}

/** Pool-local document-frequency over candidate contents; distinct terms per candidate counted once. Deterministic, order-independent. */
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
