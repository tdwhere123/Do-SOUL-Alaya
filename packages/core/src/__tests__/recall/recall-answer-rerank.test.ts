import { describe, expect, it, vi } from "vitest";
import { RECALL_FUSION_FAMILY_IDS } from "../../recall/delivery/fusion-delivery-families.js";
import { buildEmptyRecallFusionBreakdown } from "../../recall/delivery/fusion-delivery-scoring.js";
import type { FineAssessmentCandidate } from "../../recall/delivery/fine-assessment-selection.js";
import { collectAnswerRelevanceScores } from "../../recall/rerank/recall-answer-rerank.js";
import { createMemoryEntry } from "./recall-service-test-fixtures.js";

describe("collectAnswerRelevanceScores", () => {
  it.each([
    { maxEntries: 0, expectedCount: 0 },
    { maxEntries: 2, expectedCount: 2 * RECALL_FUSION_FAMILY_IDS.length },
    { maxEntries: 10, expectedCount: 10 * RECALL_FUSION_FAMILY_IDS.length }
  ])("derives the CE head from max_entries=$maxEntries", async ({
    maxEntries,
    expectedCount
  }) => {
    const candidates = Array.from({ length: 55 }, (_, index) =>
      candidate(`candidate-${index + 1}`, 55 - index)
    ).reverse();
    const score = vi.fn(async (_query: string, passages: readonly string[]) =>
      passages.map((_, index) => index / passages.length)
    );

    const result = await collectAnswerRelevanceScores({
      service: { score },
      queryText: "which candidate answers",
      candidates,
      maxEntries,
      warn: vi.fn()
    });

    expect(score).toHaveBeenCalledTimes(expectedCount === 0 ? 0 : 1);
    if (expectedCount > 0) {
      expect(score.mock.calls[0]?.[1]).toHaveLength(expectedCount);
      expect(score.mock.calls[0]?.[1][0]).toBe("content candidate-55");
    }
    expect(result.scores).toHaveLength(expectedCount);
    expect(result.diagnostics).toEqual({
      status: expectedCount === 0 ? "not_applicable" : "returned",
      expected_count: expectedCount,
      scored_count: expectedCount,
      failure_class: null
    });
  });

  it("keeps fused-order ties stable at the resource boundary", async () => {
    const candidates = [
      candidate("rank-1", 1),
      candidate("tie-a", 2),
      candidate("tie-b", 2),
      candidate("tie-c", 2),
      candidate("tie-d", 2),
      candidate("tail", 3)
    ];
    const score = vi.fn(async (_query: string, passages: readonly string[]) =>
      passages.map(() => 0.5)
    );

    await collectAnswerRelevanceScores({
      service: { score },
      queryText: "query",
      candidates,
      maxEntries: 1,
      warn: vi.fn()
    });

    expect(score.mock.calls[0]?.[1]).toEqual([
      "content rank-1",
      "content tie-a",
      "content tie-b",
      "content tie-c",
      "content tie-d"
    ]);
  });

  it("reports bounded failure classes and fails closed to fusion order", async () => {
    const warn = vi.fn();
    const candidates = [candidate("a", 1), candidate("b", 2)];
    const invalid = await collectAnswerRelevanceScores({
      service: { score: async () => [0.5] },
      queryText: "query",
      candidates,
      maxEntries: 10,
      warn
    });
    const rejected = await collectAnswerRelevanceScores({
      service: { score: async () => { throw new Error("model missing"); } },
      queryText: "query",
      candidates,
      maxEntries: 10,
      warn
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
      service: undefined,
      queryText: "query",
      candidates: candidateSet,
      maxEntries: 10,
      warn: vi.fn()
    });
    const notApplicable = await collectAnswerRelevanceScores({
      service: { score: async () => [0.5] },
      queryText: null,
      candidates: candidateSet,
      maxEntries: 10,
      warn: vi.fn()
    });
    const invalidValue = await collectAnswerRelevanceScores({
      service: { score: async () => [Number.NaN] },
      queryText: "query",
      candidates: candidateSet,
      maxEntries: 10,
      warn: vi.fn()
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
