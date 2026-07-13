import { describe, expect, it, vi } from "vitest";
import { buildEmptyRecallFusionBreakdown } from "../../recall/delivery/fusion-delivery-scoring.js";
import type { FineAssessmentCandidate } from "../../recall/delivery/fine-assessment-selection.js";
import { collectAnswerRelevanceScores } from "../../recall/rerank/recall-answer-rerank.js";
import { createMemoryEntry } from "./recall-service-test-fixtures.js";

describe("collectAnswerRelevanceScores", () => {
  it("scores the fused top-50 in stable rank order", async () => {
    const candidates = Array.from({ length: 52 }, (_, index) =>
      candidate(`candidate-${index + 1}`, 52 - index)
    ).reverse();
    const score = vi.fn(async (_query: string, passages: readonly string[]) =>
      passages.map((_, index) => index / passages.length)
    );

    const result = await collectAnswerRelevanceScores({
      service: { score }, queryText: "which candidate answers", candidates, warn: vi.fn()
    });

    expect(score).toHaveBeenCalledTimes(1);
    expect(score.mock.calls[0]?.[1]).toHaveLength(50);
    expect(score.mock.calls[0]?.[1][0]).toBe("content candidate-52");
    expect(result.scores).toHaveLength(50);
    expect(result.diagnostics).toEqual({
      status: "returned",
      expected_count: 50,
      scored_count: 50,
      failure_class: null
    });
  });

  it("reports bounded failure classes and fails closed to fusion order", async () => {
    const warn = vi.fn();
    const candidates = [candidate("a", 1), candidate("b", 2)];
    const invalid = await collectAnswerRelevanceScores({
      service: { score: async () => [0.5] }, queryText: "query", candidates, warn
    });
    const rejected = await collectAnswerRelevanceScores({
      service: { score: async () => { throw new Error("model missing"); } },
      queryText: "query", candidates, warn
    });

    expect(invalid).toEqual({
      scores: new Map(),
      diagnostics: {
        status: "failed",
        expected_count: 2,
        scored_count: 1,
        failure_class: "invalid_score_count"
      }
    });
    expect(rejected).toEqual({
      scores: new Map(),
      diagnostics: {
        status: "failed",
        expected_count: 2,
        scored_count: 0,
        failure_class: "service_error"
      }
    });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("distinguishes not requested, not applicable, and invalid score values", async () => {
    const candidateSet = [candidate("a", 1)];
    const notRequested = await collectAnswerRelevanceScores({
      service: undefined, queryText: "query", candidates: candidateSet, warn: vi.fn()
    });
    const notApplicable = await collectAnswerRelevanceScores({
      service: { score: async () => [0.5] }, queryText: null, candidates: candidateSet, warn: vi.fn()
    });
    const invalidValue = await collectAnswerRelevanceScores({
      service: { score: async () => [Number.NaN] }, queryText: "query", candidates: candidateSet, warn: vi.fn()
    });

    expect(notRequested.diagnostics.status).toBe("not_requested");
    expect(notApplicable.diagnostics.status).toBe("not_applicable");
    expect(invalidValue.diagnostics).toEqual({
      status: "failed",
      expected_count: 1,
      scored_count: 0,
      failure_class: "invalid_score_value"
    });
  });
});

function candidate(objectId: string, fusedRank: number): FineAssessmentCandidate {
  return {
    entry: createMemoryEntry({ object_id: objectId, content: `content ${objectId}` }),
    effectiveScore: 0.5,
    effectiveFactors: { activation: 0.5, relevance: 0.5 },
    fusion: {
      ...buildEmptyRecallFusionBreakdown(objectId),
      fused_rank: fusedRank,
      fused_score: 1 / fusedRank
    }
  };
}
