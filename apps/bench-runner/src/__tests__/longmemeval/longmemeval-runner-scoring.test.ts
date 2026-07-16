import { describe, expect, it } from "vitest";
import {
  buildLongMemEvalQualityMetrics,
  buildQuestionDiagnostic
} from "../../longmemeval/diagnostics.js";
import {
  buildLongMemEvalSidecarKey,
  deriveLongMemEvalGoldMemoryIds,
  scoreLongMemEvalRecallHits
} from "../../longmemeval/runner.js";

describe("LongMemEval runner", () => {

  it("computes evidence and path stream quality metrics from recall diagnostics", () => {
    const row = buildQuestionDiagnostic({
      questionId: "q-native-streams",
      goldMemoryIds: ["memory-gold"],
      answerSessionIds: ["session-a"],
      deliveredResults: [
        {
          object_id: "memory-gold",
          rank: 1,
          relevance_score: 0.91,
          plane_first_admitted: "evidence_anchor",
          plane_winning_admission: "path_expansion"
        }
      ],
      hitAt1: true,
      hitAt5: true,
      hitAt10: true,
      degradationReason: null,
      embeddingMode: "disabled",
      recallResult: {
        diagnostics: {
          candidate_pool: [
            {
              object_id: "memory-gold",
              final_rank: 1,
              pre_budget_rank: 1,
              fused_rank: 1,
              per_stream_rank: {
                evidence_fts: 1,
                evidence_structural_agreement: null,
                path_expansion: 2
              },
              plane_first_admitted: "evidence_anchor",
              plane_winning_admission: "path_expansion",
              source_planes: ["evidence_anchor", "path_expansion"],
              source_channels: ["evidence_fts", "path_expansion"]
            }
          ]
        }
      }
    });

    const metrics = buildLongMemEvalQualityMetrics([row]);
    expect(metrics.evidence_stream_gold_delivery_count).toBe(1);
    expect(metrics.evidence_stream_gold_delivery_rate).toBe(1);
    expect(metrics.path_stream_top10_count).toBe(1);
    expect(metrics.path_stream_top10_rate).toBe(1);
    expect(metrics.evaluator_identity_issue_denominator).toBe(1);
    expect(metrics.evaluator_identity_unscorable_denominator).toBe(1);
  });

  it("scores LongMemEval R@K from ranked results only, not active constraints", () => {
    const sidecar = new Map([
      [
        buildLongMemEvalSidecarKey("memory_entry", "gold-constraint"),
        {
          objectId: "gold-constraint",
          objectKind: "memory_entry" as const,
          sessionId: "session-a",
          hasAnswer: true
        }
      ],
      [
        buildLongMemEvalSidecarKey("memory_entry", "decoy-top"),
        {
          objectId: "decoy-top",
          objectKind: "memory_entry" as const,
          sessionId: "session-b",
          hasAnswer: false
        }
      ]
    ]);
    const scoring = scoreLongMemEvalRecallHits({
      results: [{ object_id: "decoy-top", relevance_score: 0.91 }],
      sidecar,
      answerSessionIds: new Set(["session-a"])
    });
    const row = buildQuestionDiagnostic({
      questionId: "q-active-constraint-only",
      goldMemoryIds: ["gold-constraint"],
      answerSessionIds: ["session-a"],
      deliveredResults: [
        {
          object_id: "decoy-top",
          rank: 1,
          relevance_score: 0.91
        }
      ],
      activeConstraintResults: [{ object_id: "gold-constraint", rank: 1 }],
      hitAt1: scoring.hitAt1,
      hitAt5: scoring.hitAt5,
      hitAt10: scoring.hitAt10,
      degradationReason: null,
      embeddingMode: "disabled",
      recallResult: {
        diagnostics: {
          candidate_pool: []
        }
      }
    });

    expect(scoring).toMatchObject({
      hitAt1: false,
      hitAt5: false,
      hitAt10: false,
      firstTier: "hot"
    });
    expect(row.hit_at_5).toBe(false);
    expect(row.hit_at_10).toBe(false);
    expect(row.miss_classification).toBe("active_constraint_only");
    expect(row.gold[0]).toMatchObject({
      object_id: "gold-constraint",
      candidate_status: "active_constraint_delivered",
      final_rank: null,
      active_constraint_rank: 1
    });
  });

  it("does not count same-id synthesis_capsule results as LongMemEval memory gold hits", () => {
    const sidecar = new Map([
      [
        buildLongMemEvalSidecarKey("memory_entry", "shared-object"),
        {
          objectId: "shared-object",
          objectKind: "memory_entry" as const,
          sessionId: "session-a",
          hasAnswer: true
        }
      ]
    ]);

    const synthesisOnly = scoreLongMemEvalRecallHits({
      results: [
        {
          object_id: "shared-object",
          object_kind: "synthesis_capsule",
          relevance_score: 0.99
        }
      ],
      sidecar,
      answerSessionIds: new Set(["session-a"])
    });
    expect(synthesisOnly).toMatchObject({
      hitAt1: false,
      hitAt5: false,
      hitAt10: false,
      firstTier: "hot"
    });

    const memoryEntry = scoreLongMemEvalRecallHits({
      results: [
        {
          object_id: "shared-object",
          object_kind: "memory_entry",
          relevance_score: 0.99
        }
      ],
      sidecar,
      answerSessionIds: new Set(["session-a"])
    });
    expect(memoryEntry.hitAt1).toBe(true);
  });

  it("derives LongMemEval gold ids from memory_entry sidecar entries only", () => {
    const sidecar = new Map([
      [
        buildLongMemEvalSidecarKey("memory_entry", "shared-object"),
        {
          objectId: "shared-object",
          objectKind: "memory_entry" as const,
          sessionId: "session-a",
          hasAnswer: true
        }
      ],
      [
        buildLongMemEvalSidecarKey("synthesis_capsule", "shared-object"),
        {
          objectId: "shared-object",
          objectKind: "synthesis_capsule" as const,
          sessionId: "session-a",
          hasAnswer: true
        }
      ],
      [
        buildLongMemEvalSidecarKey("memory_entry", "decoy-object"),
        {
          objectId: "decoy-object",
          objectKind: "memory_entry" as const,
          sessionId: "session-b",
          hasAnswer: true
        }
      ]
    ]);

    expect(deriveLongMemEvalGoldMemoryIds(sidecar, new Set(["session-a"]))).toEqual([
      "shared-object"
    ]);
  });

  it("classifies empty-gold rows separately from candidate absence", () => {
    const row = buildQuestionDiagnostic({
      questionId: "q-no-gold",
      goldMemoryIds: [],
      answerSessionIds: ["session-no-answer"],
      deliveredResults: [
        {
          object_id: "decoy",
          rank: 1,
          relevance_score: 0.9
        }
      ],
      hitAt1: false,
      hitAt5: false,
      hitAt10: false,
      degradationReason: null,
      embeddingMode: "disabled",
      recallResult: {
        diagnostics: {
          candidate_pool: []
        }
      }
    });

    expect(row.miss_classification).toBe("no_gold");
    const metrics = buildLongMemEvalQualityMetrics([row]);
    expect(metrics.no_gold_count).toBe(1);
    expect(metrics.candidate_absent_count).toBe(0);
    expect(metrics.miss_distribution).toMatchObject({ no_gold: 1 });
  });

  it("rejects an answerable hit marker without evaluator gold identity", () => {
    const row = buildQuestionDiagnostic({
      questionId: "q-empty-gold-hit-marker",
      goldMemoryIds: [],
      answerSessionIds: ["session-a"],
      deliveredResults: [{ object_id: "decoy", rank: 1, relevance_score: 0.9 }],
      hitAt1: true,
      hitAt5: true,
      hitAt10: true,
      degradationReason: null,
      embeddingMode: "disabled",
      recallResult: { diagnostics: { candidate_pool: [] } }
    });

    expect(row.miss_classification).toBe("no_gold");
    expect(row.cohort_ledger).toMatchObject({
      retrieval_status: "not_applicable",
      evaluation_issue_reason: "empty_gold_identity",
      final_verdict: "evaluation_unscorable"
    });
    const metrics = buildLongMemEvalQualityMetrics([row]);
    expect(metrics.no_gold_count).toBe(1);
    expect(metrics.candidate_absent_count).toBe(0);
  });


});
