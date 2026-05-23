import { describe, expect, it } from "vitest";
import { compileRecallQueryProbes } from "../recall-query-probes.js";
import {
  RECALL_RERANK_EVIDENCE_ONLY_FACTOR,
  RECALL_RERANK_TOP_N,
  buildRerankPoolIdf,
  computeRerankFeatures,
  rerankTopN,
  type RerankCandidate
} from "../recall-feature-rerank.js";

interface FakeCandidate {
  readonly id: string;
}

/**
 * Build a rerank candidate. `fusionScore` defaults to a flat value so the
 * fusion contribution is constant across a list and the lexical features
 * alone decide ordering — that isolates the feature logic under test.
 * Tests that exercise the fusion-vs-rerank blend set `fusionScore`
 * explicitly.
 */
function candidate(
  id: string,
  content: string,
  options: { readonly fusionScore?: number; readonly hasEvidenceLexicalHit?: boolean } = {}
): RerankCandidate<FakeCandidate> {
  return Object.freeze({
    item: Object.freeze({ id }),
    fusionScore: options.fusionScore ?? 0.1,
    text: Object.freeze({
      content,
      hasEvidenceLexicalHit: options.hasEvidenceLexicalHit ?? false
    })
  });
}

function ids<T extends { readonly id: string }>(result: readonly T[]): readonly string[] {
  return result.map((entry) => entry.id);
}

describe("recall feature rerank — computeRerankFeatures", () => {
  it("awards exact-phrase credit on a verbatim query span", () => {
    const query = compileRecallQueryProbes("favorite programming language");
    const features = computeRerankFeatures(query, {
      content: "The user said their favorite programming language is Rust.",
      hasEvidenceLexicalHit: false
    });

    expect(features.exactPhrase).toBe(1);
    expect(features.score).toBeGreaterThan(0);
  });

  it("scores term coverage as the fraction of distinct query terms present", () => {
    const query = compileRecallQueryProbes("rust python golang typescript");
    const allPresent = computeRerankFeatures(query, {
      content: "rust python golang typescript are all installed",
      hasEvidenceLexicalHit: false
    });
    const halfPresent = computeRerankFeatures(query, {
      content: "rust and python are installed",
      hasEvidenceLexicalHit: false
    });

    expect(allPresent.termCoverage).toBe(1);
    expect(halfPresent.termCoverage).toBeCloseTo(0.5, 5);
    expect(allPresent.score).toBeGreaterThan(halfPresent.score);
  });

  it("rewards proximity — tight term windows beat scattered ones", () => {
    const query = compileRecallQueryProbes("database connection timeout");
    const tight = computeRerankFeatures(query, {
      content: "database connection timeout was the reported bug",
      hasEvidenceLexicalHit: false
    });
    const scattered = computeRerankFeatures(query, {
      content:
        "the database failed because a slow remote connection eventually hit a timeout",
      hasEvidenceLexicalHit: false
    });

    expect(tight.proximity).toBeGreaterThan(scattered.proximity);
    expect(tight.termCoverage).toBeCloseTo(scattered.termCoverage, 5);
    expect(tight.score).toBeGreaterThan(scattered.score);
  });

  it("keeps the lexical score within [0, 1]", () => {
    const query = compileRecallQueryProbes("database connection timeout");
    const features = computeRerankFeatures(query, {
      content: "database connection timeout database connection timeout",
      hasEvidenceLexicalHit: false
    });

    expect(features.score).toBeGreaterThan(0);
    expect(features.score).toBeLessThanOrEqual(1);
  });

  it("applies field-aware damping to evidence-only matches", () => {
    const query = compileRecallQueryProbes("deployment rollback procedure");
    const evidenceOnly = computeRerankFeatures(query, {
      content: "an unrelated distilled fact about lunch preferences",
      hasEvidenceLexicalHit: true
    });
    const noSignal = computeRerankFeatures(query, {
      content: "an unrelated distilled fact about lunch preferences",
      hasEvidenceLexicalHit: false
    });

    expect(evidenceOnly.fieldFactor).toBe(RECALL_RERANK_EVIDENCE_ONLY_FACTOR);
    expect(noSignal.fieldFactor).toBe(1);
    // Both have zero content features, so both score 0 — the field factor
    // is still surfaced for diagnostics.
    expect(evidenceOnly.score).toBe(0);
  });

  it("awards no exact-phrase credit for a stop-word-only query", () => {
    // "the" survives the ≥3-char floor but is pure stop-word, so it has no
    // content terms. It must not award exact_phrase credit to any
    // candidate that merely contains the substring "the".
    const query = compileRecallQueryProbes("the");
    const features = computeRerankFeatures(query, {
      content: "the runbook documents the rollback procedure",
      hasEvidenceLexicalHit: false
    });

    expect(features.exactPhrase).toBe(0);
    expect(features.score).toBe(0);
  });

  it("gives a content hit full field credit over an evidence-only hit", () => {
    const query = compileRecallQueryProbes("rollback procedure");
    const contentHit = computeRerankFeatures(query, {
      content: "the rollback procedure is documented in the runbook",
      hasEvidenceLexicalHit: true
    });

    expect(contentHit.fieldFactor).toBe(1);
    expect(contentHit.score).toBeGreaterThan(0);
  });
});

describe("recall feature rerank — rerankTopN", () => {
  it("promotes an exact-phrase match above a fusion-tied weak candidate", () => {
    const query = compileRecallQueryProbes("favorite text editor");
    const candidates = [
      candidate("weak", "some loosely related note about editors in general"),
      candidate("exact", "the user told us their favorite text editor is Helix")
    ];

    const result = rerankTopN(query, candidates);

    expect(ids(result)).toEqual(["exact", "weak"]);
  });

  it("orders fusion-tied candidates by term coverage", () => {
    const query = compileRecallQueryProbes("rust python golang");
    const candidates = [
      candidate("one-term", "the team uses rust for the core"),
      candidate("three-term", "rust python golang are the supported languages"),
      candidate("two-term", "rust and python are both installed")
    ];

    const result = rerankTopN(query, candidates);

    expect(ids(result)).toEqual(["three-term", "two-term", "one-term"]);
  });

  it("reorders fusion-tied candidates by proximity when coverage ties", () => {
    const query = compileRecallQueryProbes("connection pool size");
    const candidates = [
      candidate(
        "scattered",
        "the connection was slow so we changed the pool to a larger size"
      ),
      candidate("tight", "connection pool size was raised to fifty")
    ];

    const result = rerankTopN(query, candidates);

    expect(ids(result)).toEqual(["tight", "scattered"]);
  });

  it("does not override a decisive fusion gap with a weak lexical signal", () => {
    const query = compileRecallQueryProbes("favorite text editor");
    // The fusion leader carries a far stronger fused_score (non-lexical
    // signal — e.g. subject alignment); the lexically richer candidate is
    // a decisive fusion gap behind it. Fusion must still win.
    const candidates = [
      candidate("fusion-leader", "a short note", { fusionScore: 0.9 }),
      candidate("lexical-rich", "favorite text editor favorite text editor", {
        fusionScore: 0.1
      })
    ];

    const result = rerankTopN(query, candidates);

    expect(ids(result)).toEqual(["fusion-leader", "lexical-rich"]);
  });

  it("flips a moderate fusion gap inside the rerank_weight headroom", () => {
    const query = compileRecallQueryProbes("favorite text editor");
    // The blend is `1.0·(fusion/maxFusion) + 0.35·lexical`. A maximal
    // lexical score (exact phrase + full coverage + adjacency → 1.0) flips
    // the leader once the trailing candidate's normalized fusion ratio
    // exceeds ~0.65. 0.24 / 0.30 = 0.80 is inside that window.
    const candidates = [
      candidate("moderate-leader", "a short unrelated note", { fusionScore: 0.3 }),
      candidate("moderate-strong", "their favorite text editor is Helix", {
        fusionScore: 0.24
      })
    ];

    const result = rerankTopN(query, candidates);

    expect(ids(result)).toEqual(["moderate-strong", "moderate-leader"]);
  });

  it("does not flip a fusion gap just outside the rerank_weight headroom", () => {
    const query = compileRecallQueryProbes("favorite text editor");
    // 0.15 / 0.30 = 0.50 is below the ~0.65 flip threshold, so even a
    // maximal lexical score cannot promote the trailing candidate.
    const candidates = [
      candidate("wide-leader", "a short unrelated note", { fusionScore: 0.3 }),
      candidate("wide-strong", "their favorite text editor is Helix", {
        fusionScore: 0.15
      })
    ];

    const result = rerankTopN(query, candidates);

    expect(ids(result)).toEqual(["wide-leader", "wide-strong"]);
  });

  it("flips a near-tied fusion pair toward the stronger lexical match", () => {
    const query = compileRecallQueryProbes("favorite text editor");
    // Fusion scores are near-tied; the lexical signal has enough headroom
    // to promote the genuine best match.
    const candidates = [
      candidate("near-weak", "a short unrelated note", { fusionScore: 0.21 }),
      candidate("near-strong", "their favorite text editor is Helix", {
        fusionScore: 0.2
      })
    ];

    const result = rerankTopN(query, candidates);

    expect(ids(result)).toEqual(["near-strong", "near-weak"]);
  });

  it("keeps a candidate outside the top-N at its fusion position", () => {
    const query = compileRecallQueryProbes("exact target phrase");
    const head: RerankCandidate<FakeCandidate>[] = [];
    for (let i = 0; i < RECALL_RERANK_TOP_N; i += 1) {
      head.push(candidate(`head-${i}`, `irrelevant filler content number ${i}`));
    }
    // The strongest lexical match sits just past the top-N cut.
    const tail = candidate("past-cut", "this carries the exact target phrase verbatim");
    const candidates = [...head, tail];

    const result = rerankTopN(query, candidates);

    expect(result).toHaveLength(RECALL_RERANK_TOP_N + 1);
    // Past-cut candidate is NOT pulled into the reordered head.
    expect(result[result.length - 1]?.id).toBe("past-cut");
  });

  it("is a stable no-op on a degenerate empty query", () => {
    const query = compileRecallQueryProbes("");
    const candidates = [
      candidate("a", "first fusion-ranked candidate"),
      candidate("b", "second fusion-ranked candidate"),
      candidate("c", "third fusion-ranked candidate")
    ];

    const result = rerankTopN(query, candidates);

    expect(ids(result)).toEqual(["a", "b", "c"]);
  });

  it("preserves fusion order when no candidate carries any query feature", () => {
    const query = compileRecallQueryProbes("quantum entanglement spectroscopy");
    // Distinct descending fusion scores; with zero lexical signal the
    // blend reduces to fusion order.
    const candidates = [
      candidate("a", "notes about gardening schedules", { fusionScore: 0.3 }),
      candidate("b", "notes about grocery shopping", { fusionScore: 0.2 }),
      candidate("c", "notes about bicycle maintenance", { fusionScore: 0.1 })
    ];

    const result = rerankTopN(query, candidates);

    expect(ids(result)).toEqual(["a", "b", "c"]);
  });

  it("preserves fusion order on ties (stable sort)", () => {
    const query = compileRecallQueryProbes("rust language");
    // Identical fusion score and identical lexical signal.
    const candidates = [
      candidate("first", "rust language is in use"),
      candidate("second", "rust language is in use")
    ];

    const result = rerankTopN(query, candidates);

    expect(ids(result)).toEqual(["first", "second"]);
  });

  it("handles an empty candidate list", () => {
    const query = compileRecallQueryProbes("anything");
    expect(rerankTopN(query, [])).toEqual([]);
  });

  it("damps an evidence-only match below a fusion-tied content match", () => {
    const query = compileRecallQueryProbes("backup retention policy");
    const candidates = [
      // Fusion-tied but only an evidence-FTS hit, no content match.
      candidate("evidence-only", "an unrelated fact about meeting notes", {
        hasEvidenceLexicalHit: true
      }),
      candidate("content-hit", "the backup retention policy keeps thirty days")
    ];

    const result = rerankTopN(query, candidates);

    expect(ids(result)).toEqual(["content-hit", "evidence-only"]);
  });
});

describe("recall feature rerank — pool-local IDF", () => {
  it("counts each candidate once per distinct term", () => {
    const pool = buildRerankPoolIdf([
      "rust rust rust language",
      "python language",
      "golang language"
    ]);

    expect(pool.poolSize).toBe(3);
    // "language" in all 3; "rust" in 1 even though it repeats in that doc.
    expect(pool.documentFrequency.get("language")).toBe(3);
    expect(pool.documentFrequency.get("rust")).toBe(1);
  });

  it("yields no rare-term signal for an empty pool", () => {
    const query = compileRecallQueryProbes("database connection timeout");
    const emptyPool = buildRerankPoolIdf([]);
    const features = computeRerankFeatures(
      query,
      { content: "database connection timeout reported", hasEvidenceLexicalHit: false },
      emptyPool
    );

    expect(emptyPool.poolSize).toBe(0);
    expect(features.rareTermCoverage).toBe(0);
    // term_coverage still fires, so the score is non-zero and bounded.
    expect(features.score).toBeGreaterThan(0);
    expect(features.score).toBeLessThanOrEqual(1);
  });

  it("yields no rare-term signal when no pool IDF is supplied", () => {
    const query = compileRecallQueryProbes("database connection timeout");
    const features = computeRerankFeatures(query, {
      content: "database connection timeout reported",
      hasEvidenceLexicalHit: false
    });

    expect(features.rareTermCoverage).toBe(0);
  });

  it("is safe for a single-candidate pool", () => {
    const query = compileRecallQueryProbes("database connection timeout");
    const pool = buildRerankPoolIdf(["database connection timeout reported"]);
    const features = computeRerankFeatures(
      query,
      { content: "database connection timeout reported", hasEvidenceLexicalHit: false },
      pool
    );

    // poolSize 1, every matched term has df 1 → idf = log(2/2) = 0 → no
    // rarity signal, but well-defined (not NaN / Infinity).
    expect(pool.poolSize).toBe(1);
    expect(features.rareTermCoverage).toBe(0);
    expect(Number.isFinite(features.score)).toBe(true);
  });

  it("scores a rare-term match above a common-term match at equal coverage", () => {
    const query = compileRecallQueryProbes("database connection retrypolicy");
    // "database" and "connection" saturate the pool; "retrypolicy" is rare.
    const pool = buildRerankPoolIdf([
      "database connection note one",
      "database connection note two",
      "database connection note three",
      "database connection retrypolicy answer"
    ]);
    const rareHit = computeRerankFeatures(
      query,
      { content: "database connection retrypolicy answer", hasEvidenceLexicalHit: false },
      pool
    );
    const commonHit = computeRerankFeatures(
      query,
      { content: "database connection note one", hasEvidenceLexicalHit: false },
      pool
    );

    // Plain term_coverage cannot tell them apart…
    expect(rareHit.termCoverage).toBeGreaterThan(commonHit.termCoverage);
    // …but rare_term_coverage rewards the discriminative term.
    expect(rareHit.rareTermCoverage).toBeGreaterThan(commonHit.rareTermCoverage);
  });

  it("keeps the lexical score within [0, 1] with the rare-term feature active", () => {
    const query = compileRecallQueryProbes("alpha beta gamma");
    const pool = buildRerankPoolIdf([
      "alpha beta gamma",
      "alpha beta gamma",
      "alpha beta gamma"
    ]);
    const features = computeRerankFeatures(
      query,
      { content: "alpha beta gamma alpha beta gamma", hasEvidenceLexicalHit: false },
      pool
    );

    expect(features.score).toBeGreaterThan(0);
    expect(features.score).toBeLessThanOrEqual(1);
  });

  it("counts document frequency independent of candidate order", () => {
    const contents = [
      "alpha shared term",
      "beta shared term",
      "gamma shared rareone"
    ];
    const forward = buildRerankPoolIdf(contents);
    const reversed = buildRerankPoolIdf([...contents].reverse());

    expect(reversed.poolSize).toBe(forward.poolSize);
    expect([...reversed.documentFrequency.keys()].sort()).toEqual(
      [...forward.documentFrequency.keys()].sort()
    );
    for (const term of forward.documentFrequency.keys()) {
      expect(reversed.documentFrequency.get(term)).toBe(
        forward.documentFrequency.get(term)
      );
    }
  });

  it("dampens the score when a rare query term matches no pool candidate", () => {
    // "alpha" saturates the pool; "rarematch" is rare and present in the
    // candidate; "zetaunmatched" appears in no pool candidate at all.
    const pool = buildRerankPoolIdf([
      "alpha note one",
      "alpha note two",
      "alpha note three",
      "alpha rarematch answer"
    ]);
    const text = { content: "alpha rarematch answer", hasEvidenceLexicalHit: false };

    const matched = computeRerankFeatures(
      compileRecallQueryProbes("alpha rarematch"),
      text,
      pool
    );
    const withUnmatchedRareTerm = computeRerankFeatures(
      compileRecallQueryProbes("alpha rarematch zetaunmatched"),
      text,
      pool
    );

    // The unmatched rare term inflates totalIdf (the denominator) without
    // adding to matchedIdf, so it legitimately dampens the score.
    expect(withUnmatchedRareTerm.rareTermCoverage).toBeGreaterThan(0);
    expect(withUnmatchedRareTerm.rareTermCoverage).toBeLessThan(
      matched.rareTermCoverage
    );
  });
});

describe("recall feature rerank — IDF tie-break in rerankTopN", () => {
  it("promotes the rare-term gold above saturated topical distractors", () => {
    // The saturation case: every candidate is on-topic and shares the
    // common topic terms; only the gold carries the rare answer term. All
    // fusion scores are flat so the rerank decides alone.
    const query = compileRecallQueryProbes("deployment rollback retryconcurrency");
    const candidates = [
      candidate("distractor-1", "deployment rollback steps overview"),
      candidate("distractor-2", "deployment rollback timing discussion"),
      candidate("distractor-3", "deployment rollback ownership notes"),
      candidate(
        "gold",
        "deployment rollback retryconcurrency was set to four in the runbook"
      )
    ];

    const result = rerankTopN(query, candidates);

    expect(result[0]?.id).toBe("gold");
  });

  it("reorders golds that sit in the rank 21-50 band the old window missed", () => {
    const query = compileRecallQueryProbes("exact target phrase");
    const head: RerankCandidate<FakeCandidate>[] = [];
    for (let i = 0; i < 30; i += 1) {
      head.push(candidate(`filler-${i}`, `irrelevant filler content number ${i}`));
    }
    // The strong lexical match sits at rank 31 — beyond the old top-N of
    // 20, inside the widened top-N of 50.
    const gold = candidate("gold-rank-31", "this carries the exact target phrase verbatim");
    const candidates = [...head, gold];

    const result = rerankTopN(query, candidates);

    expect(RECALL_RERANK_TOP_N).toBe(50);
    // The gold is pulled into the reordered head, not stranded at rank 31.
    expect(result[0]?.id).toBe("gold-rank-31");
  });
});

describe("recall feature rerank — evidence-gist field (B2)", () => {
  it("returns identical features when no evidence gist is supplied (regression guard)", () => {
    const query = compileRecallQueryProbes("favorite programming language");
    const haystack = "The user said their favorite programming language is Rust.";

    const baseline = computeRerankFeatures(query, {
      content: haystack,
      hasEvidenceLexicalHit: false
    });
    const withEmptyGist = computeRerankFeatures(query, {
      content: haystack,
      hasEvidenceLexicalHit: false,
      evidenceGist: ""
    });
    const withWhitespaceGist = computeRerankFeatures(query, {
      content: haystack,
      hasEvidenceLexicalHit: false,
      evidenceGist: "   "
    });

    // Absent / empty / whitespace gist → content-only behavior preserved.
    expect(withEmptyGist).toEqual(baseline);
    expect(withWhitespaceGist).toEqual(baseline);
  });

  it("scores by the gist path when content does not match but gist does", () => {
    const query = compileRecallQueryProbes("backup retention schedule");
    const features = computeRerankFeatures(query, {
      // Content is an opaque distilled fact; the answer-bearing semantics
      // live in the evidence paraphrase.
      content: "Operator chose the conservative policy in the planning thread.",
      hasEvidenceLexicalHit: true,
      evidenceGist:
        "Operator explicitly mentioned the backup retention schedule should stay weekly."
    });

    // Gist path contributes a non-zero lexical signal; the content path's
    // raw exact-phrase / term-coverage features would be 0 for this query
    // against this content. Because the gist won, the returned breakdown
    // reflects gist-side features (non-zero exact-phrase / coverage).
    expect(features.exactPhrase).toBe(1);
    expect(features.termCoverage).toBeGreaterThan(0);
    expect(features.score).toBeGreaterThan(0);
  });

  it("propagates caller hasEvidenceLexicalHit into the gist path's field factor", () => {
    // invariant: gist path inherits caller.hasEvidenceLexicalHit
    // see also: computeRerankFeaturesForField in recall-feature-rerank.ts
    const query = compileRecallQueryProbes("rollback procedure schedule");
    const withFlag = computeRerankFeatures(query, {
      content: "an unrelated distilled fact about lunch preferences",
      hasEvidenceLexicalHit: true,
      evidenceGist: "the rollback procedure schedule stays weekly"
    });
    const withoutFlag = computeRerankFeatures(query, {
      content: "an unrelated distilled fact about lunch preferences",
      hasEvidenceLexicalHit: false,
      evidenceGist: "the rollback procedure schedule stays weekly"
    });

    // hasEvidenceLexicalHit=true triggers the evidence-only damp on the
    // gist path's own field factor; hasEvidenceLexicalHit=false does not.
    expect(withFlag.fieldFactor).toBe(RECALL_RERANK_EVIDENCE_ONLY_FACTOR);
    expect(withoutFlag.fieldFactor).toBe(1);
    // The damp must reduce the overall score: a strong gist match against
    // unrelated content earns less when the evidence-only flag is set.
    expect(withFlag.score).toBeLessThan(withoutFlag.score);
    expect(withFlag.score).toBeGreaterThan(0);
  });

  it("does not let gist rare-term coverage borrow content-pool IDF", () => {
    // invariant: gist path passes null poolIdf -> rareTermCoverage = 0
    // see also: computeRerankFeatures gist branch in recall-feature-rerank.ts
    const query = compileRecallQueryProbes("gistonlyrareterm");
    const pool = buildRerankPoolIdf([
      "alpha note one",
      "alpha note two",
      "alpha note three"
    ]);
    const features = computeRerankFeatures(
      query,
      {
        content: "an unrelated distilled fact",
        hasEvidenceLexicalHit: false,
        evidenceGist: "the gistonlyrareterm shows up only inside the gist"
      },
      pool
    );

    expect(features.rareTermCoverage).toBe(0);
  });

  it("prefers the higher-scoring field — content wins over an equally strong gist (max behavior)", () => {
    const query = compileRecallQueryProbes("backup retention schedule");

    // Both fields encode the same strong signal. The gist path is damped
    // by EVIDENCE_GIST_WEIGHT (< 1), so an equally strong content match
    // should beat the gist match under the max combinator.
    const contentMatches = "The backup retention schedule stays weekly.";
    const gistMatches = "The backup retention schedule stays weekly.";

    const both = computeRerankFeatures(query, {
      content: contentMatches,
      hasEvidenceLexicalHit: false,
      evidenceGist: gistMatches
    });
    const contentOnly = computeRerankFeatures(query, {
      content: contentMatches,
      hasEvidenceLexicalHit: false
    });
    const gistOnly = computeRerankFeatures(query, {
      content: "an unrelated distilled note",
      hasEvidenceLexicalHit: true,
      evidenceGist: gistMatches
    });

    // With both, the content path wins (its score is undamped). The combined
    // result must equal the content-only result — the gist path's damped
    // score is strictly smaller, so max picks content.
    expect(both.score).toBeCloseTo(contentOnly.score, 5);
    // And the gist path alone yields a strictly smaller score than the
    // content path on the same lexical signal (because of the damp).
    expect(gistOnly.score).toBeLessThan(contentOnly.score);
    expect(gistOnly.score).toBeGreaterThan(0);
  });
});
