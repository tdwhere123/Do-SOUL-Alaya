import { describe, expect, it } from "vitest";
import {
  isAbstentionQuestionId,
  resolvePremiseInvalid,
  scoreAbstentionQuestion
} from "../../../longmemeval/diagnostics/abstention.js";
import {
  ABSTENTION_FUSED_MARGIN_SCALE,
  computeAbstentionConfidenceScore
} from "../../../longmemeval/diagnostics/abstention-confidence.js";
import {
  buildLongMemEvalQualityMetrics,
  buildQuestionDiagnostic
} from "../../../longmemeval/diagnostics.js";
import {
  buildLongMemEvalSidecarKey,
  resolveLongMemEvalHitVerdict
} from "../../../longmemeval/runner.js";

function deliveredResult(
  rank: number,
  relevanceScore: number,
  abstentionConfidenceScore?: number
) {
  return {
    object_id: `obj-${rank}`,
    rank,
    relevance_score: relevanceScore,
    ...(abstentionConfidenceScore === undefined
      ? {}
      : { abstention_confidence_score: abstentionConfidenceScore })
  };
}

describe("abstention confidence producer (fused-margin)", () => {
  it("maps a large fused top1-top2 margin to high confidence", () => {
    // RRF-scale dominance: top1≈1/61, top2≈1/1000 → margin / (1/60) ≥ 0.91.
    const score = computeAbstentionConfidenceScore([
      1 / 61,
      1 / 1000,
      1 / 1200,
      1 / 1500
    ]);
    expect(score).toBeGreaterThanOrEqual(0.91);
    expect(score).toBeLessThanOrEqual(1);
  });

  it("maps a tiny fused margin to low confidence", () => {
    const score = computeAbstentionConfidenceScore([
      1 / 60,
      1 / 61,
      1 / 62,
      1 / 63
    ]);
    expect(score).not.toBeNull();
    expect(score!).toBeLessThan(0.1);
  });

  it("returns null when fewer than two fused scores exist", () => {
    expect(computeAbstentionConfidenceScore([])).toBeNull();
    expect(computeAbstentionConfidenceScore([1.2])).toBeNull();
    expect(computeAbstentionConfidenceScore([null, undefined])).toBeNull();
  });

  it("never uses relevance_score and clamps to [0, 1]", () => {
    const score = computeAbstentionConfidenceScore([
      ABSTENTION_FUSED_MARGIN_SCALE * 3,
      0
    ]);
    expect(score).toBe(1);
  });

  it("is invariant to post-fusion delivery ordering", () => {
    const scores = [0.540067, 0.548017, 0.522949, 0.49932, 0.467685];
    expect(computeAbstentionConfidenceScore(scores)).toBe(
      computeAbstentionConfidenceScore([scores[1], scores[0], ...scores.slice(2)])
    );
  });

  it("uses only the delivered top-five prefix", () => {
    const prefix = [0.2, 0.2, 0.2, 0.2, 0.2];
    expect(computeAbstentionConfidenceScore([...prefix, 1])).toBe(
      computeAbstentionConfidenceScore(prefix)
    );
  });
});

describe("LongMemEval abstention scoring (fail-closed until calibrated)", () => {
  it("detects abstention question ids by the `_abs` suffix", () => {
    expect(isAbstentionQuestionId("0862e8bf_abs")).toBe(true);
    expect(isAbstentionQuestionId("76d63226")).toBe(false);
    expect(isAbstentionQuestionId("gpt4_59c863d7")).toBe(false);
  });

  it("keeps premise_invalid always false via the invariant helper", () => {
    expect(resolvePremiseInvalid()).toBe(false);
  });

  it.each([
    ["empty", []],
    ["single score", [{ relevance_score: 1, abstention_confidence_score: 0.2 }]],
    ["finite margin", [
      { relevance_score: 1, abstention_confidence_score: 0.95 },
      { relevance_score: 1, abstention_confidence_score: 0.05 }
    ]]
  ])("keeps %s unscorable and never credits recall hits", (_label, results) => {
    expect(scoreAbstentionQuestion({ results })).toEqual({
      status: "uncalibrated",
      scorable: false,
      hitAt1: false,
      hitAt5: false,
      hitAt10: false
    });
  });
});

describe("resolveLongMemEvalHitVerdict — abstention routing", () => {
  it("keeps id-equality scoring byte-identical for answerable questions", () => {
    const sidecar = new Map([
      [
        buildLongMemEvalSidecarKey("memory_entry", "gold-a"),
        {
          objectId: "gold-a",
          objectKind: "memory_entry" as const,
          sessionId: "session-a",
          hasAnswer: true
        }
      ],
      [
        buildLongMemEvalSidecarKey("memory_entry", "decoy"),
        {
          objectId: "decoy",
          objectKind: "memory_entry" as const,
          sessionId: "session-b",
          hasAnswer: false
        }
      ]
    ]);
    const input = {
      results: [
        { object_id: "decoy", relevance_score: 0.95 },
        { object_id: "gold-a", relevance_score: 0.5 }
      ],
      sidecar,
      answerSessionIds: new Set(["session-a"])
    };
    const answerable = resolveLongMemEvalHitVerdict({
      ...input,
      isAbstention: false
    });
    expect(answerable).toMatchObject({
      hitAt1: false,
      hitAt5: true,
      hitAt10: true
    });
  });

  it("never credits an abstention hit when confidence is absent", () => {
    const verdict = resolveLongMemEvalHitVerdict({
      isAbstention: true,
      results: [{ object_id: "decoy", relevance_score: 1 }],
      sidecar: new Map(),
      answerSessionIds: new Set()
    });
    expect(verdict).toMatchObject({
      hitAt1: false,
      hitAt5: false,
      hitAt10: false
    });
  });

  it("keeps fused-margin confidence diagnostic-only", () => {
    const verdict = resolveLongMemEvalHitVerdict({
      isAbstention: true,
      results: [
        { object_id: "decoy-a", relevance_score: 1, fused_score: 1 / 61 },
        { object_id: "decoy-b", relevance_score: 1, fused_score: 1 / 1000 }
      ],
      sidecar: new Map(),
      answerSessionIds: new Set()
    });
    expect(verdict).toMatchObject({ hitAt1: false, hitAt5: false, hitAt10: false });
  });
});

describe("abstention miss classification and KPI breakdown", () => {
  it("classifies every recall-only abstention as uncalibrated", () => {
    const row = buildQuestionDiagnostic({
      questionId: "0862e8bf_abs",
      goldMemoryIds: [],
      answerSessionIds: [],
      deliveredResults: [deliveredResult(1, 0.99)],
      hitAt1: false,
      hitAt5: false,
      hitAt10: false,
      isAbstention: true,
      degradationReason: null,
      embeddingMode: "disabled",
      recallResult: { diagnostics: { candidate_pool: [] } }
    });
    expect(row.miss_classification).toBe("abstention_uncalibrated");
    expect(row.cohort_ledger?.final_verdict).toBe("abstention_uncalibrated");
    expect(row.premise_invalid).toBe(false);
  });

  it("surfaces an auditable abstention breakdown in the quality metrics", () => {
    const first = buildQuestionDiagnostic({
      questionId: "0862e8bf_abs",
      goldMemoryIds: [],
      answerSessionIds: [],
      deliveredResults: [deliveredResult(1, 0.2)],
      hitAt1: false,
      hitAt5: false,
      hitAt10: false,
      isAbstention: true,
      degradationReason: null,
      embeddingMode: "disabled",
      recallResult: { diagnostics: { candidate_pool: [] } }
    });
    const second = buildQuestionDiagnostic({
      questionId: "19b5f2b3_abs",
      goldMemoryIds: [],
      answerSessionIds: [],
      deliveredResults: [deliveredResult(1, 0.95)],
      hitAt1: false,
      hitAt5: false,
      hitAt10: false,
      isAbstention: true,
      degradationReason: null,
      embeddingMode: "disabled",
      recallResult: { diagnostics: { candidate_pool: [] } }
    });
    const metrics = buildLongMemEvalQualityMetrics([first, second]);
    expect(metrics.abstention).toEqual({
      schema_version: "bench-abstention.v2",
      total: 2,
      scored: 0,
      unscorable: 2,
      method: "fused_margin_diagnostic_only",
      calibration_status: "uncalibrated",
      gate_eligible: false
    });
    expect(metrics.miss_distribution).toMatchObject({
      abstention_uncalibrated: 2
    });
    expect(metrics.candidate_absent_denominator).toBe(0);
    expect(metrics.non_monotonic_denominator).toBe(0);
    expect(metrics.no_gold_count).toBe(0);
    expect(metrics.evaluator_identity_issue_denominator).toBe(2);
    expect(metrics.evaluator_identity_unscorable_denominator).toBe(2);
  });

  it("rejects cohort-less legacy abstention rows from current aggregation", () => {
    const current = buildQuestionDiagnostic({
      questionId: "legacy_abs",
      goldMemoryIds: [],
      answerSessionIds: [],
      deliveredResults: [],
      hitAt1: false,
      hitAt5: false,
      hitAt10: false,
      isAbstention: true,
      degradationReason: null,
      embeddingMode: "disabled",
      recallResult: { diagnostics: { candidate_pool: [] } }
    });
    const { cohort_ledger: _cohortLedger, ...legacy } = current;

    expect(() => buildLongMemEvalQualityMetrics([legacy]))
      .toThrow(/no current cohort ledger/u);
  });

  it("persists fused-margin abstention_confidence_score on delivered_results", () => {
    const row = buildQuestionDiagnostic({
      questionId: "q-abs_abs",
      goldMemoryIds: [],
      answerSessionIds: [],
      deliveredResults: [
        {
          object_id: "decoy-a",
          rank: 1,
          relevance_score: 0.99,
          fused_score: 2.4
        },
        {
          object_id: "decoy-b",
          rank: 2,
          relevance_score: 0.98,
          fused_score: 0.5
        }
      ],
      hitAt1: false,
      hitAt5: false,
      hitAt10: false,
      isAbstention: true,
      degradationReason: null,
      embeddingMode: "disabled",
      recallResult: { diagnostics: { candidate_pool: [] } }
    });
    expect(row.premise_invalid).toBe(false);
    expect(row.delivered_results[0]?.abstention_confidence_score).toBeGreaterThanOrEqual(0.91);
    expect(row.delivered_results[0]?.abstention_confidence_score).toBe(
      row.delivered_results[1]?.abstention_confidence_score
    );
  });

  it("replaces null diagnostic confidence with the fused-margin derivation", () => {
    const row = buildQuestionDiagnostic({
      questionId: "q-null_abs",
      goldMemoryIds: [],
      answerSessionIds: [],
      deliveredResults: [
        { object_id: "a", rank: 1, relevance_score: 1, fused_score: 0.2,
          abstention_confidence_score: null },
        { object_id: "b", rank: 2, relevance_score: 1, fused_score: 0.01,
          abstention_confidence_score: null }
      ],
      hitAt1: false,
      hitAt5: false,
      hitAt10: false,
      isAbstention: true,
      degradationReason: null,
      embeddingMode: "disabled",
      recallResult: { diagnostics: { candidate_pool: [] } }
    });

    expect(row.delivered_results[0]?.abstention_confidence_score).toBeGreaterThanOrEqual(0.91);
    expect(row.delivered_results[1]?.abstention_confidence_score).toBe(
      row.delivered_results[0]?.abstention_confidence_score
    );
  });
});
