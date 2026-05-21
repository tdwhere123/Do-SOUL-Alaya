import { describe, expect, it } from "vitest";
import { compileRecallQueryProbes } from "../recall-query-probes.js";
import {
  RECALL_RERANK_EVIDENCE_ONLY_FACTOR,
  RECALL_RERANK_TOP_N,
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
