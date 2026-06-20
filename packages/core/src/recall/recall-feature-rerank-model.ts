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
 * Evidence-gist feature weight. When the query did not match the distilled
 * memory content but matches the evidence capsule's `gist` (the human-readable
 * explanation of the raw turn), the candidate may still be the gold: the
 * answer-bearing semantics live in the evidence anchor, not the distillation.
 * Compute the lexical feature score against the gist text and take the max of
 * `content_score` and `EVIDENCE_GIST_WEIGHT * gist_score` so a strong gist
 * match wins over a weak content match — but stays below a strong content
 * match. The weight stays below 1 because gist is a paraphrase of the source
 * rather than the source itself; an explicit content match is still the
 * higher-trust signal.
 *
 * Initial value 0.7: a perfect gist match is treated as roughly equivalent to
 * a 70% content match. Tunable in B3 grid search; kept module-local because
 * the only consumer is the gist path inside computeRerankFeatures.
 */
export const EVIDENCE_GIST_WEIGHT = 0.7;

/**
 * Hard safety cap on the gist text length fed to the rerank tokenizer. Gist
 * is `EvidenceCapsule.gist` (a `NonEmptyStringSchema` with no upper bound at
 * the protocol layer) and originates from attacker-controlled source text —
 * unlike `memory_entry.content`, which is the output of an upstream
 * distillation step. Without this cap an oversized gist would O(n)-expand
 * the tokenizer + `new Set` + the proximity sliding window inside every
 * top-N rerank pass.
 *
 * 8192 chars is well above any normal evidence gist (the in-corpus
 * distribution sits under 1K) and below any plausible legitimate ceiling,
 * so a longer payload is treated as anomalous and hard-truncated. Not
 * configurable on purpose: this is a safety boundary, not a tuning knob.
 */
export const GIST_MAX_CHARS = 8192;

/**
 * Diversity threshold below which the gist score is linearly damped. Defined
 * as `distinctTokenRatio = uniqueTokens / totalTokens` inside the gist's own
 * token list. A natural-language gist sits comfortably above 0.5; a repeated-
 * token gist (e.g. the query phrase pasted N times to game `exact_phrase` +
 * `term_coverage`) collapses toward 0. 0.5 is the "single-token-repeat rate
 * of 50%" boundary — high enough to leave normal gists untouched, low enough
 * to catch the repeat-amplification shape that bypasses pool-IDF dilution on
 * the gist path (gist scorer is intentionally pool-IDF-free).
 *
 * Self-contained: depends only on the gist's own token list, no pool or IDF
 * table required.
 */
export const GIST_MIN_DIVERSITY_RATIO = 0.5;

/**
 * Token count below which both diversity damps are skipped. A short gist
 * naturally has either low distinct ratio (legitimate emphatic answers like
 * "yes yes yes" or "no thanks") or high query-term density (a one-word
 * answer that is literally the query term). Damping these is a false
 * positive: they carry no amplification headroom — the lexical score is
 * already bounded by the small token set, and the upper EVIDENCE_GIST_WEIGHT
 * cap keeps gist score below content score on equal raw signal.
 *
 * 4 tokens is the emphatic-answer ceiling observed in the corpus
 * ("yes yes yes", "ok ok ok ok"). Above this threshold both damps engage
 * because a longer gist with collapsed diversity / dense query terms
 * carries genuine attack headroom.
 */
export const GIST_SHORT_TOKEN_THRESHOLD = 4;

/**
 * Query-term concentration threshold for the second gist damp. Defined as
 * `distinctQueryTokensPresent / totalTokens` over the gist's tokens —
 * each unique query term that appears in the gist counts once, repeated
 * occurrences of the same query word do not bump density. High density
 * means distinct query terms saturate the gist, which is the
 * padding-bypass attack shape: distinct nonsense tokens wrapping the
 * query phrase keep `distinctTokenRatio` near 1.0 (so the diversity damp
 * does not fire) while distinct query terms still dominate (so
 * `exact_phrase` + `term_coverage` still saturate). Above this threshold
 * the concentration damp ramps linearly to the floor, complementing the
 * distinct-token damp.
 *
 * invariant: distinct counting bounds the numerator by querySet size,
 * so repeating one query word K times cannot drive density up — it only
 * scales the denominator. Bypass space shrinks under repetition.
 *
 * 0.55 is the boundary that lets natural-language paraphrases through:
 * a 6-8 token gist that mentions a 3-term query phrase once with a couple
 * of stop words and one content connector lands at 0.4-0.5 (e.g.
 * "the rollback procedure schedule stays weekly" — distinct {rollback,
 * procedure, schedule} = 3 / 6 tokens = 0.5). A paraphrase that repeats
 * the same subject token ("Alice cooked, yes Alice cooked", query
 * {alice, cook}) lands at distinct 2 / 5 = 0.4, also under the boundary.
 * An attacker who relies on N distinct query terms plus M padding tokens
 * hits the same boundary as before: density = N / (N + M), so they must
 * still hold M < (N / 0.55 - N) padding to stay above 0.55.
 */
export const GIST_QUERY_CONCENTRATION_THRESHOLD = 0.55;

/**
 * Ramp width of the concentration damp above
 * `GIST_QUERY_CONCENTRATION_THRESHOLD`. `density 0.55 -> damp 1.0`;
 * `density 1.0 -> damp 0.1 then floored to GIST_CONCENTRATION_MIN_DAMP`.
 * The linear shape keeps the damp continuous across the threshold (no
 * cliff a bench grid could exploit).
 */
export const GIST_CONCENTRATION_RAMP = 0.5;

/**
 * Floor of the concentration damp. A fully query-stuffed gist (every token
 * is a query term) is suspicious but not provably adversarial, so the damp
 * floors at this minimum instead of collapsing to 0. Mirrors the shape of
 * the evidence-only damp factor: pull the score down decisively without
 * zeroing a candidate that may still carry a legitimate signal.
 */
export const GIST_CONCENTRATION_MIN_DAMP = 0.2;

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
  /**
   * The evidence capsule `gist` paraphrase associated with this candidate
   * (best-rank evidence when multiple evidence_refs hit). When present, the
   * rerank computes lexical features against the gist as well and takes
   * `max(content_score, EVIDENCE_GIST_WEIGHT * gist_score)`. Absent / empty
   * → behavior identical to the pre-B2 content-only scorer.
   */
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

export const WEIGHT_TOTAL =
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
export function tokenize(value: string): readonly string[] {
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
