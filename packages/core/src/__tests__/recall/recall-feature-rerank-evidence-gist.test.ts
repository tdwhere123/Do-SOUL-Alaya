import { describe, expect, it } from "vitest";
import { compileRecallQueryProbes } from "../../recall/recall-query-probes.js";
import {
  RECALL_RERANK_EVIDENCE_ONLY_FACTOR,
  buildRerankPoolIdf,
  computeRerankFeatures
} from "../../recall/recall-feature-rerank.js";

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

  it("hard-caps an oversized adversarial gist without blowing the tokenizer", () => {
    // Attacker-controlled gist text has no protocol upper bound. A huge
    // payload must be truncated before tokenization so the scorer remains
    // bounded under the top-N rerank loop.
    const query = compileRecallQueryProbes("favorite text editor");
    // ~200K chars of repeated junk plus a single answer-bearing phrase at
    // the head so the truncated prefix still scores meaningfully.
    const huge = `their favorite text editor is Helix. ${"junkjunk ".repeat(25000)}`;
    expect(huge.length).toBeGreaterThan(50000);

    const start = Date.now();
    const features = computeRerankFeatures(query, {
      content: "an unrelated distilled fact about meeting notes",
      hasEvidenceLexicalHit: true,
      evidenceGist: huge
    });
    const elapsedMs = Date.now() - start;

    // Bounded compute despite the giant input — well under any plausible
    // top-N rerank budget even on a slow CI box. Margin is loose to absorb
    // CI scheduler jitter (per-run variance has been observed in the
    // 100-1500 ms range on shared hardware); the regression we guard
    // against is unbounded O(n) tokenization, which would land well above
    // any plausible CI box ceiling.
    expect(elapsedMs).toBeLessThan(2000);
    // Answer-bearing phrase at the head survives the cap, so the gist path
    // still recognizes the match.
    expect(features.exactPhrase).toBe(1);
    expect(features.score).toBeGreaterThan(0);
    expect(features.score).toBeLessThanOrEqual(1);
  });

  it("damps a repeated-token gist below an honest content match", () => {
    // Repeated-token attack: gist is the query phrase pasted 100 times to
    // game exact-phrase + term-coverage. distinctTokenRatio collapses far
    // below the diversity threshold, so the damp scales the weighted gist
    // score down enough that an honest content match still wins.
    const query = compileRecallQueryProbes("favorite text editor");
    const repeated = "favorite text editor ".repeat(100).trim();
    const attackerGist = computeRerankFeatures(query, {
      content: "an unrelated distilled fact about lunch preferences",
      hasEvidenceLexicalHit: false,
      evidenceGist: repeated
    });
    // Diverse natural-language gist with the same phrase exactly once —
    // should pass the diversity gate untouched.
    const honestGist = computeRerankFeatures(query, {
      content: "an unrelated distilled fact about lunch preferences",
      hasEvidenceLexicalHit: false,
      evidenceGist:
        "the user mentioned their favorite text editor is Helix during the standup"
    });

    // Damp must measurably pull the attacker score below the honest one
    // even though the attacker's raw lexical features would be saturated.
    expect(attackerGist.score).toBeLessThan(honestGist.score);
    // And the damp visibly shrinks the field factor below the no-damp
    // baseline of 1.
    expect(attackerGist.fieldFactor).toBeLessThan(0.5);
  });

  it("damps a phrase-repetition padding-bypass via the distinct-token damp", () => {
    // Padding-bypass attack shape A: attacker repeats the query phrase
    // many times to saturate exact_phrase + term_coverage, and interleaves
    // a distinct padding token after each repetition to dodge the
    // distinct-token damp. Distinct counting in the concentration damp
    // bounds the numerator at querySet size, so repeating the same query
    // words K times scales the denominator by K and keeps distinct query
    // density low — this shape no longer trips the concentration damp.
    // But the same padding strategy still collapses uniqueTokens /
    // totalTokens below the diversity threshold, so the distinct-token
    // damp catches it.
    //
    // invariant: at least one damp must fire on a repetition-padded gist.
    const query = compileRecallQueryProbes("favorite text editor");
    // 8 × (3 query + 1 pad) = 32 tokens. distinctQueryTokensPresent = 3
    // (alice/cook/editor reduced to {favorite, text, editor}); distinct
    // density = 3 / 32 ≈ 0.094 — well under 0.55, concentration damp
    // returns 1. distinctTokenRatio = (3 + 8) / 32 ≈ 0.344 — under
    // GIST_MIN_DIVERSITY_RATIO (0.5), so diversity damp fires at
    // 0.344 / 0.5 ≈ 0.69. Composite picks the smaller damp.
    const blocks = Array.from({ length: 8 }, (_, blockIndex) =>
      `favorite text editor pad${blockIndex}`
    );
    const interleaved = blocks.join(" ");
    const attackerGist = computeRerankFeatures(query, {
      content: "an unrelated distilled fact about lunch preferences",
      hasEvidenceLexicalHit: false,
      evidenceGist: interleaved
    });
    // Honest natural-language gist with the same phrase once — passes both
    // damps untouched.
    const honestGist = computeRerankFeatures(query, {
      content: "an unrelated distilled fact about lunch preferences",
      hasEvidenceLexicalHit: false,
      evidenceGist:
        "the user mentioned their favorite text editor is Helix during the standup"
    });

    // At least one damp must visibly pull the attacker below the honest
    // gist score.
    expect(attackerGist.score).toBeLessThan(honestGist.score);
    // concentration damp by design does NOT fire on this shape (distinct
    // query density = 3 / 32 ≈ 0.094 << 0.55); diversity damp is the sole
    // load-bearing protection. Pin both the numerical damp value and the
    // semantic invariant so a future widening of GIST_MIN_DIVERSITY_RATIO
    // (or a switch back to a raw-occurrence concentration formulation) is
    // forced to acknowledge that this shape would silently slip past.
    // distinctTokenRatio = 11 / 32 = 0.34375; damp = 0.34375 / 0.5 = 0.6875.
    expect(attackerGist.fieldFactor).toBeCloseTo(11 / 16, 10);
    expect(attackerGist.fieldFactor).toBeLessThan(0.7);
    expect(honestGist.fieldFactor).toBe(1);
  });

  it("damps a distinct-query-saturation gist via the concentration damp", () => {
    // Padding-bypass attack shape B: attacker assembles N distinct query
    // terms plus minimal distinct padding, keeping distinctTokenRatio at
    // 1.0 so the diversity damp does not fire. The concentration damp now
    // gates on distinctQueryTokensPresent / totalTokens, which stays high
    // because every query term is present without repetition.
    //
    // invariant: when distinct query terms dominate the gist, the
    // concentration damp fires even if every token is unique.
    const query = compileRecallQueryProbes("favorite text editor name");
    // 4 distinct query terms + 2 distinct padding tokens = 6 tokens.
    // distinctQueryTokensPresent = 4; distinct density = 4 / 6 ≈ 0.67 —
    // above GIST_QUERY_CONCENTRATION_THRESHOLD (0.55). distinctTokenRatio
    // = 6 / 6 = 1.0 — diversity damp returns 1, so concentration is the
    // load-bearing damp here.
    const attackerGist = computeRerankFeatures(query, {
      content: "an unrelated distilled fact about lunch preferences",
      hasEvidenceLexicalHit: false,
      evidenceGist: "favorite text editor name pad alpha"
    });
    const honestGist = computeRerankFeatures(query, {
      content: "an unrelated distilled fact about lunch preferences",
      hasEvidenceLexicalHit: false,
      evidenceGist:
        "the user mentioned their favorite text editor name is Helix during the standup"
    });

    expect(attackerGist.score).toBeLessThan(honestGist.score);
    expect(attackerGist.fieldFactor).toBeLessThan(1);
    expect(honestGist.fieldFactor).toBe(1);
  });

  it("does not damp a legitimate paraphrase that repeats the same query word", () => {
    // invariant: repeating the same query word does not raise distinct
    // query density — the numerator is bounded by querySet size.
    // Regression guard against the raw-occurrence formulation that would
    // false-positive on natural paraphrases ("Alice cook ... Alice cook").
    const query = compileRecallQueryProbes("Alice cook");
    // Tokens: [alice, cook, yes, alice, cook, tonight] = 6 tokens.
    // queryTerms = {alice, cook}; distinctQueryTokensPresent = 2;
    // distinct density = 2 / 6 ≈ 0.33 — under threshold, no damp.
    // (Raw-occurrence density would be 4 / 6 ≈ 0.67 and would have
    // damped this legit shape.)
    const legitParaphrase = computeRerankFeatures(query, {
      content: "an unrelated distilled fact about lunch preferences",
      hasEvidenceLexicalHit: false,
      evidenceGist: "alice cook yes alice cook tonight"
    });
    const baselineHonestGist = computeRerankFeatures(query, {
      content: "an unrelated distilled fact about lunch preferences",
      hasEvidenceLexicalHit: false,
      evidenceGist: "the user mentioned alice will cook the dinner tonight"
    });

    // No concentration damp fired — fieldFactor is dominated only by the
    // distinct-token damp (which also passes at distinct ratio = 5/6 ≈
    // 0.83, well above the 0.5 threshold). fieldFactor must be 1.
    expect(legitParaphrase.fieldFactor).toBe(1);
    expect(legitParaphrase.score).toBeGreaterThan(0);
    // And the paraphrase scores in the same ballpark as a single-mention
    // honest gist of comparable length — the repeated subject token does
    // not penalize it relative to peers.
    expect(legitParaphrase.score).toBeGreaterThan(0.5 * baselineHonestGist.score);
  });

  it("does not damp a single-occurrence multi-term paraphrase", () => {
    // invariant: a natural-language gist that mentions each query term
    // exactly once with light connectors stays at density well under the
    // concentration threshold.
    const query = compileRecallQueryProbes("rollback procedure schedule");
    // Tokens: [the, rollback, procedure, schedule, stays, weekly] = 6
    // tokens; queryTerms = {rollback, procedure, schedule}; distinct
    // density = 3 / 6 = 0.5 — under threshold (0.55), no damp.
    const features = computeRerankFeatures(query, {
      content: "an unrelated distilled fact about lunch preferences",
      hasEvidenceLexicalHit: false,
      evidenceGist: "the rollback procedure schedule stays weekly"
    });

    expect(features.fieldFactor).toBe(1);
    expect(features.exactPhrase).toBe(1);
    expect(features.score).toBeGreaterThan(0);
  });

  it("concentration damp returns 1 when distinct-query density stays below the threshold (sparse query presence)", () => {
    // Boundary: query.lexical_terms non-empty but only one of them appears
    // in a long-enough gist. distinctQueryTokensPresent = 1, totalTokens = 8,
    // density = 0.125 — well below GIST_QUERY_CONCENTRATION_THRESHOLD (0.55).
    // invariant: concentration damp returns 1 on sparse query presence; the
    // observable proxy is fieldFactor = 1 on the gist branch (diversity damp
    // also returns 1 because distinct/total = 8/8 = 1.0).
    const query = compileRecallQueryProbes("alpha beta");
    const features = computeRerankFeatures(query, {
      content: "an unrelated distilled fact about lunch preferences",
      hasEvidenceLexicalHit: false,
      // 8 distinct tokens, 1 of them ("alpha") is a query term. "the" is
      // length-3 so it survives splitLexicalTokens (which does not drop stop
      // words on the candidate side).
      evidenceGist: "the team mentioned alpha during the standup yesterday morning"
    });

    expect(features.fieldFactor).toBe(1);
    // Single matched term still contributes term-coverage credit, so the
    // gist branch is the path under test (not a silent fall-through to the
    // content-only baseline).
    expect(features.termCoverage).toBe(0.5);
    expect(features.score).toBeGreaterThan(0);
  });

  it("fully saturated gist (every token is a distinct query term) hits GIST_CONCENTRATION_MIN_DAMP", () => {
    // Boundary: query terms equal gist tokens one-for-one. density = 1.0,
    // excess = 0.45, raw damp = 1 - 0.45 / 0.5 = 0.1, clamped to
    // GIST_CONCENTRATION_MIN_DAMP (0.2). distinctTokenDamp is 1 (every
    // token is unique). composite gistDiversityDamp = 0.2.
    // invariant: the concentration damp floors at GIST_CONCENTRATION_MIN_DAMP
    // even on the maximum-density attacker shape — it pulls hard but does
    // not zero a candidate that may carry legitimate signal.
    // invariant: the test uses 5 tokens, just above GIST_SHORT_TOKEN_THRESHOLD
    // (4), so the short-circuit does not fire.
    const query = compileRecallQueryProbes("alpha beta gamma delta epsilon");
    const features = computeRerankFeatures(query, {
      content: "an unrelated distilled fact about lunch preferences",
      hasEvidenceLexicalHit: false,
      evidenceGist: "alpha beta gamma delta epsilon"
    });

    // fieldFactor on the gist branch = gistEvidenceOnlyDamp(1) ×
    // distinctTokenDamp(1) × concentrationDamp(floor 0.2) = 0.2.
    expect(features.fieldFactor).toBeCloseTo(0.2, 10);
  });

  it("damp path engages at tokens.length = GIST_SHORT_TOKEN_THRESHOLD + 1 (boundary transition)", () => {
    // Boundary: 5 tokens — exactly one above GIST_SHORT_TOKEN_THRESHOLD (4).
    // Below or equal to the threshold both damps short-circuit to 1; above
    // it the damp path engages. Pin the transition by constructing a 5-token
    // gist whose density (3/5 = 0.6) just clears the concentration threshold
    // (0.55) so the damp produces an observably-non-1 fieldFactor.
    // invariant: GIST_SHORT_TOKEN_THRESHOLD + 1 is the smallest gist length
    // at which the damp path can fire — a regression that off-by-one'd the
    // <= comparison to < would silently let a 5-token full-saturation gist
    // through.
    const query = compileRecallQueryProbes("alpha beta gamma");
    const features = computeRerankFeatures(query, {
      content: "an unrelated distilled fact about lunch preferences",
      hasEvidenceLexicalHit: false,
      // 5 tokens, 3 distinct query terms present. density = 3/5 = 0.6.
      // excess = 0.05, damp = 1 - 0.05 / 0.5 = 0.9. distinctTokenDamp = 1.
      evidenceGist: "alpha beta gamma delta epsilon"
    });

    expect(features.fieldFactor).toBeCloseTo(0.9, 10);
    expect(features.fieldFactor).toBeLessThan(1);
  });

  it("documents the distinct-nonsense padding attack budget ceiling (I-1 regression)", () => {
    // invariant: the distinct-nonsense / stop-word padding shape is a
    // designed-open attack budget — N distinct query terms wrapped in M
    // distinct neutral / stop-word pads where uniqueTokens / totalTokens
    // = 1.0 (diversity damp clears) AND N / (N + M) ≤
    // GIST_QUERY_CONCENTRATION_THRESHOLD (concentration damp clears).
    // Concrete shape pinned here: N = 3, M = 8.
    //   diversity damp:    uniqueTokens / totalTokens = 11 / 11 = 1.0 ≥ 0.5
    //   concentration damp: distinctQueryTokensPresent / totalTokens
    //                       = 3 / 11 ≈ 0.273 ≤ 0.55
    // invariant: the only remaining brake on this shape is
    // EVIDENCE_GIST_WEIGHT (0.7); the gist-side fieldFactor must stay 1
    // because both hygiene damps are designed to clear.
    // see also: tightening either damp closes this attack surface but
    //   couples to natural short paraphrases — co-verify with the
    //   LoCoMo bench when changing any of GIST_MIN_DIVERSITY_RATIO /
    //   GIST_QUERY_CONCENTRATION_THRESHOLD / GIST_SHORT_TOKEN_THRESHOLD.
    // invariant: candidate-side tokenizer (splitLexicalTokens) does NOT
    // drop stop words. All 8 padding words below clear the length->2
    // filter ("the"/"and"/"but"/"for" = 3; "with"/"from"/"this"/"that" = 4).
    const query = compileRecallQueryProbes("favorite text editor");
    const features = computeRerankFeatures(query, {
      content: "an unrelated distilled fact about lunch preferences",
      hasEvidenceLexicalHit: false,
      // 3 distinct query terms + 8 distinct neutral / stop-word pads = 11
      // distinct tokens. Every token unique.
      evidenceGist: "favorite text editor the and but for with from this that"
    });

    // Both hygiene damps cleared — fieldFactor = 1 documents the open
    // attack budget. The only remaining suppressor is EVIDENCE_GIST_WEIGHT
    // (0.7), folded into the score itself, not into fieldFactor.
    expect(features.fieldFactor).toBe(1);
    // Exact-phrase fires because the query "favorite text editor" appears
    // verbatim in the gist — this is the attacker's payload landing intact.
    expect(features.exactPhrase).toBe(1);
    expect(features.termCoverage).toBe(1);
    // invariant: gist-branch score is bounded by EVIDENCE_GIST_WEIGHT
    // (0.7). A regression that raises the gist multiplier or removes the
    // cap surfaces here as a ceiling breach.
    expect(features.score).toBeLessThanOrEqual(0.7);
  });

  it("leaves a short emphatic gist (yes yes yes) above the diversity / concentration damps", () => {
    // Regression guard for the round 5 false positive: a 3-token emphatic
    // answer ("yes yes yes") trips both the distinct-ratio and
    // query-concentration signals (ratio 1/3, density 1.0). Both damps
    // skip gists at or below GIST_SHORT_TOKEN_THRESHOLD because emphatic
    // legitimate answers are bounded by the upper EVIDENCE_GIST_WEIGHT
    // cap already — no headroom to amplify.
    const query = compileRecallQueryProbes("did the user say yes");
    const shortEmphatic = computeRerankFeatures(query, {
      content: "an unrelated distilled note about scheduling",
      hasEvidenceLexicalHit: true,
      evidenceGist: "yes yes yes"
    });
    // No damp applied — fieldFactor reflects only the evidence-only damp
    // (gist branch entered with no content signal but evidence-FTS hit).
    expect(shortEmphatic.fieldFactor).toBeCloseTo(RECALL_RERANK_EVIDENCE_ONLY_FACTOR, 5);
    expect(shortEmphatic.score).toBeGreaterThan(0);
  });

  it("filters control / null-byte payloads through the shared tokenizer", () => {
    // Regression guard: splitLexicalTokens splits on every non-L/N/_./@#-
    // codepoint, so control bytes and NULs are natural delimiters. Pin the
    // contract: a gist saturated with control characters reduces to just
    // its real tokens — no NaN, no infinite proximity, no leaked literal
    // control chars in the matched-term set.
    const query = compileRecallQueryProbes("rollback procedure");
    const gist = "the\u0000rollback\u0001procedure\u0007stays\u001fweekly\ufffdRTL\u202eend";
    const features = computeRerankFeatures(query, {
      content: "an unrelated distilled fact about lunch preferences",
      hasEvidenceLexicalHit: true,
      evidenceGist: gist
    });

    expect(Number.isFinite(features.score)).toBe(true);
    expect(features.score).toBeGreaterThan(0);
    expect(features.score).toBeLessThanOrEqual(1);
    // Both query terms ("rollback", "procedure") survive the tokenizer
    // because splitLexicalTokens treats NUL / control bytes / the unicode
    // replacement char / RTL override as natural split codepoints.
    expect(features.termCoverage).toBe(1);
  });

  it("uses the highest-rank ref's gist semantics — empty gist on the top ref does not block scoring", () => {
    // The gist path scores whatever non-empty gist the caller selected. If
    // the highest-rank ref's gist is empty the caller-side fallback (see
    // collectEvidenceGistsByMemoryId) picks the next non-empty ref; this
    // test pins the scorer's contract end of that handoff — given a
    // non-empty gist string (i.e. the fallback already fired), the scorer
    // produces a meaningful signal, and given an empty string it collapses
    // to the content-only baseline.
    const query = compileRecallQueryProbes("backup retention schedule");
    const opaqueContent = "Operator chose the conservative policy in the planning thread.";
    const fallbackGist =
      "Operator explicitly mentioned the backup retention schedule should stay weekly.";

    const withFallback = computeRerankFeatures(query, {
      content: opaqueContent,
      hasEvidenceLexicalHit: true,
      evidenceGist: fallbackGist
    });
    const withEmpty = computeRerankFeatures(query, {
      content: opaqueContent,
      hasEvidenceLexicalHit: true,
      evidenceGist: ""
    });

    // With a usable fallback gist the scorer surfaces gist-side features.
    expect(withFallback.exactPhrase).toBe(1);
    expect(withFallback.score).toBeGreaterThan(0);
    // With an empty gist the scorer must collapse to the content-only
    // baseline (no gist credit, no exception).
    expect(withEmpty.score).toBe(0);
  });
});
