import { describe, expect, it } from "vitest";
import {
  ABSTENTION_FALSE_CONFIDENT_THRESHOLD,
  isAbstentionQuestionId,
  scoreAbstentionQuestion
} from "../longmemeval/abstention.js";
import {
  buildLongMemEvalQualityMetrics,
  buildQuestionDiagnostic
} from "../longmemeval/diagnostics.js";
import {
  buildLongMemEvalSidecarKey,
  resolveLongMemEvalHitVerdict
} from "../longmemeval/runner.js";

const THR = ABSTENTION_FALSE_CONFIDENT_THRESHOLD;

function deliveredResult(rank: number, relevanceScore: number) {
  return {
    object_id: `obj-${rank}`,
    rank,
    relevance_score: relevanceScore
  };
}

describe("LongMemEval abstention scoring (calibrated confidence)", () => {
  it("detects abstention question ids by the `_abs` suffix", () => {
    expect(isAbstentionQuestionId("0862e8bf_abs")).toBe(true);
    expect(isAbstentionQuestionId("76d63226")).toBe(false);
    expect(isAbstentionQuestionId("gpt4_59c863d7")).toBe(false);
  });

  it("scores a correct abstention: recall stays below the threshold at every k", () => {
    const result = scoreAbstentionQuestion({
      results: Array.from({ length: 10 }, (_, i) => ({
        relevance_score: THR - 0.05 - i * 0.01
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
        { relevance_score: THR + 0.02 },
        ...Array.from({ length: 9 }, () => ({ relevance_score: 0.1 }))
      ]
    });
    expect(result).toMatchObject({
      correctAt1: false,
      correctAt5: false,
      correctAt10: false
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
      relevance_score: i === 4 ? THR + 0.01 : THR - 0.1
    }));
    const result = scoreAbstentionQuestion({ results });
    expect(result.correctAt1).toBe(true);
    expect(result.correctAt5).toBe(false);
    expect(result.correctAt10).toBe(false);
  });

  it("applies the per-k boundary: a cross at rank 6 spares R@1/R@5 but fails R@10", () => {
    const results = Array.from({ length: 10 }, (_, i) => ({
      relevance_score: i === 5 ? THR + 0.01 : THR - 0.1
    }));
    const result = scoreAbstentionQuestion({ results });
    expect(result.correctAt1).toBe(true);
    expect(result.correctAt5).toBe(true);
    expect(result.correctAt10).toBe(false);
  });

  it("treats a score exactly at the threshold as false-confident", () => {
    const result = scoreAbstentionQuestion({
      results: [{ relevance_score: THR }]
    });
    expect(result.correctAt1).toBe(false);
  });

  it("ignores a cross at rank 11+ (only top-10 is delivered)", () => {
    const results = Array.from({ length: 12 }, (_, i) => ({
      relevance_score: i >= 10 ? THR + 0.05 : THR - 0.1
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
      results: [{ object_id: "decoy", relevance_score: THR + 0.02 }],
      sidecar: new Map(),
      answerSessionIds: new Set()
    });
    // A false-confident top-1 makes the abstention question a miss at k.
    expect(verdict).toMatchObject({
      hitAt1: false,
      hitAt5: false,
      hitAt10: false
    });
  });

  it("credits an abstention question that stayed unconfident", () => {
    const verdict = resolveLongMemEvalHitVerdict({
      isAbstention: true,
      results: [{ object_id: "decoy", relevance_score: THR - 0.2 }],
      sidecar: new Map(),
      answerSessionIds: new Set()
    });
    expect(verdict).toMatchObject({
      hitAt1: true,
      hitAt5: true,
      hitAt10: true
    });
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
    // An `_abs` row must never fall back to `no_gold` once it is scored.
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
      // top-1 clean, rank-3 crosses: correct@1, false@5 and false@10.
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
    // Abstention rows never inflate the `no_gold` counter.
    expect(metrics.no_gold_count).toBe(0);
  });
});
