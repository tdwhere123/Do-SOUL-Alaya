import { describe, expect, it } from "vitest";
import {
  ABSTENTION_FALSE_CONFIDENT_THRESHOLD,
  isAbstentionQuestionId,
  resolvePremiseInvalid,
  scoreAbstentionQuestion
} from "../../longmemeval/abstention.js";
import {
  ABSTENTION_FUSED_MARGIN_SCALE,
  computeAbstentionConfidenceScore
} from "../../longmemeval/abstention-confidence.js";
import {
  buildLongMemEvalQualityMetrics,
  buildQuestionDiagnostic
} from "../../longmemeval/diagnostics.js";
import {
  buildLongMemEvalSidecarKey,
  resolveLongMemEvalHitVerdict
} from "../../longmemeval/runner.js";

const THR = ABSTENTION_FALSE_CONFIDENT_THRESHOLD;

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
    expect(score).toBeGreaterThanOrEqual(THR);
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
});

describe("LongMemEval abstention scoring (calibrated confidence)", () => {
  it("detects abstention question ids by the `_abs` suffix", () => {
    expect(isAbstentionQuestionId("0862e8bf_abs")).toBe(true);
    expect(isAbstentionQuestionId("76d63226")).toBe(false);
    expect(isAbstentionQuestionId("gpt4_59c863d7")).toBe(false);
  });

  it("keeps premise_invalid always false via the invariant helper", () => {
    expect(resolvePremiseInvalid()).toBe(false);
  });

  it("scores a correct abstention: explicit confidence stays below the threshold at every k", () => {
    const result = scoreAbstentionQuestion({
      results: Array.from({ length: 10 }, (_, i) => ({
        relevance_score: 1,
        abstention_confidence_score: THR - 0.05 - i * 0.01
      }))
    });
    expect(result).toMatchObject({
      correctAt1: true,
      correctAt5: true,
      correctAt10: true,
      threshold: THR
    });
  });

  it("scores a false-confident abstention: top-1 crosses the threshold", () => {
    const result = scoreAbstentionQuestion({
      results: [
        { relevance_score: 1, abstention_confidence_score: THR + 0.02 },
        ...Array.from({ length: 9 }, () => ({ relevance_score: 0.1 }))
      ]
    });
    expect(result).toMatchObject({
      correctAt1: false,
      correctAt5: false,
      correctAt10: false
    });
  });

  it("does not treat saturated retrieval relevance as answerability confidence", () => {
    const result = scoreAbstentionQuestion({
      results: [{ relevance_score: 1 }]
    });
    expect(result).toMatchObject({
      correctAt1: true,
      correctAt5: true,
      correctAt10: true
    });
  });

  it("treats no delivered results as a correct abstention at every k", () => {
    const result = scoreAbstentionQuestion({ results: [] });
    expect(result).toMatchObject({
      correctAt1: true,
      correctAt5: true,
      correctAt10: true
    });
  });

  it("applies the per-k boundary: a cross at rank 5 spares R@1 but fails R@5/R@10", () => {
    const results = Array.from({ length: 10 }, (_, i) => ({
      relevance_score: 1,
      abstention_confidence_score: i === 4 ? THR + 0.01 : THR - 0.1
    }));
    const result = scoreAbstentionQuestion({ results });
    expect(result.correctAt1).toBe(true);
    expect(result.correctAt5).toBe(false);
    expect(result.correctAt10).toBe(false);
  });

  it("applies the per-k boundary: a cross at rank 6 spares R@1/R@5 but fails R@10", () => {
    const results = Array.from({ length: 10 }, (_, i) => ({
      relevance_score: 1,
      abstention_confidence_score: i === 5 ? THR + 0.01 : THR - 0.1
    }));
    const result = scoreAbstentionQuestion({ results });
    expect(result.correctAt1).toBe(true);
    expect(result.correctAt5).toBe(true);
    expect(result.correctAt10).toBe(false);
  });

  it("treats a score exactly at the threshold as false-confident", () => {
    const result = scoreAbstentionQuestion({
      results: [{ relevance_score: 1, abstention_confidence_score: THR }]
    });
    expect(result.correctAt1).toBe(false);
  });

  it("ignores a cross at rank 11+ (only top-10 is delivered)", () => {
    const results = Array.from({ length: 12 }, (_, i) => ({
      relevance_score: 1,
      abstention_confidence_score: i >= 10 ? THR + 0.05 : THR - 0.1
    }));
    const result = scoreAbstentionQuestion({ results });
    expect(result).toMatchObject({
      correctAt1: true,
      correctAt5: true,
      correctAt10: true
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

  it("re-scores abstention questions by calibrated confidence", () => {
    const verdict = resolveLongMemEvalHitVerdict({
      isAbstention: true,
      results: [
        {
          object_id: "decoy",
          relevance_score: 0.2,
          abstention_confidence_score: THR + 0.02
        }
      ],
      sidecar: new Map(),
      answerSessionIds: new Set()
    });
    expect(verdict).toMatchObject({
      hitAt1: false,
      hitAt5: false,
      hitAt10: false
    });
  });

  it("credits an abstention question that stayed unconfident", () => {
    const verdict = resolveLongMemEvalHitVerdict({
      isAbstention: true,
      results: [{ object_id: "decoy", relevance_score: 1 }],
      sidecar: new Map(),
      answerSessionIds: new Set()
    });
    expect(verdict).toMatchObject({
      hitAt1: true,
      hitAt5: true,
      hitAt10: true
    });
  });

  it("derives false-confident from a large fused_score margin", () => {
    const verdict = resolveLongMemEvalHitVerdict({
      isAbstention: true,
      results: [
        { object_id: "decoy-a", relevance_score: 1, fused_score: 1 / 61 },
        { object_id: "decoy-b", relevance_score: 1, fused_score: 1 / 1000 }
      ],
      sidecar: new Map(),
      answerSessionIds: new Set()
    });
    expect(verdict.hitAt1).toBe(false);
  });

  it("derives correct abstention from a tiny fused_score margin", () => {
    const verdict = resolveLongMemEvalHitVerdict({
      isAbstention: true,
      results: [
        { object_id: "decoy-a", relevance_score: 1, fused_score: 1 / 60 },
        { object_id: "decoy-b", relevance_score: 1, fused_score: 1 / 61 }
      ],
      sidecar: new Map(),
      answerSessionIds: new Set()
    });
    expect(verdict.hitAt1).toBe(true);
  });
});

describe("abstention miss classification and KPI breakdown", () => {
  it("classifies a correct abstention as `abstained_correctly`", () => {
    const row = buildQuestionDiagnostic({
      questionId: "0862e8bf_abs",
      goldMemoryIds: [],
      answerSessionIds: [],
      deliveredResults: [deliveredResult(1, THR - 0.2)],
      hitAt1: true,
      hitAt5: true,
      hitAt10: true,
      isAbstention: true,
      degradationReason: null,
      embeddingMode: "disabled",
      recallResult: { diagnostics: { candidate_pool: [] } }
    });
    expect(row.miss_classification).toBe("abstained_correctly");
    expect(row.premise_invalid).toBe(false);
  });

  it("classifies a false-confident abstention as `abstain_false_confident`", () => {
    const row = buildQuestionDiagnostic({
      questionId: "19b5f2b3_abs",
      goldMemoryIds: [],
      answerSessionIds: [],
      deliveredResults: [deliveredResult(1, THR + 0.02)],
      hitAt1: false,
      hitAt5: false,
      hitAt10: false,
      isAbstention: true,
      degradationReason: null,
      embeddingMode: "disabled",
      recallResult: { diagnostics: { candidate_pool: [] } }
    });
    expect(row.miss_classification).toBe("abstain_false_confident");
    expect(row.miss_classification).not.toBe("no_gold");
  });

  it("surfaces an auditable abstention breakdown in the quality metrics", () => {
    const correct = buildQuestionDiagnostic({
      questionId: "0862e8bf_abs",
      goldMemoryIds: [],
      answerSessionIds: [],
      deliveredResults: [deliveredResult(1, THR - 0.2)],
      hitAt1: true,
      hitAt5: true,
      hitAt10: true,
      isAbstention: true,
      degradationReason: null,
      embeddingMode: "disabled",
      recallResult: { diagnostics: { candidate_pool: [] } }
    });
    const falseConfident = buildQuestionDiagnostic({
      questionId: "19b5f2b3_abs",
      goldMemoryIds: [],
      answerSessionIds: [],
      deliveredResults: [
        deliveredResult(1, THR - 0.2),
        deliveredResult(2, THR - 0.2),
        deliveredResult(3, THR + 0.02)
      ],
      hitAt1: true,
      hitAt5: false,
      hitAt10: false,
      isAbstention: true,
      degradationReason: null,
      embeddingMode: "disabled",
      recallResult: { diagnostics: { candidate_pool: [] } }
    });
    const metrics = buildLongMemEvalQualityMetrics([correct, falseConfident]);
    expect(metrics.abstention).toMatchObject({
      schema_version: "bench-abstention.v1",
      total: 2,
      false_confident_threshold: THR,
      correct_at_1: 2,
      correct_at_5: 1,
      correct_at_10: 1,
      false_confident_at_1: 0,
      false_confident_at_5: 1,
      false_confident_at_10: 1
    });
    expect(metrics.miss_distribution).toMatchObject({
      abstained_correctly: 1,
      abstain_false_confident: 1
    });
    expect(metrics.no_gold_count).toBe(0);
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
    expect(row.delivered_results[0]?.abstention_confidence_score).toBeGreaterThanOrEqual(
      THR
    );
    expect(row.delivered_results[0]?.abstention_confidence_score).toBe(
      row.delivered_results[1]?.abstention_confidence_score
    );
  });
});
