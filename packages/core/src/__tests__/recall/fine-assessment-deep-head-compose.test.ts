import { describe, expect, it } from "vitest";
import { composeFineAssessmentDeepHeadDelivery } from
  "../../recall/delivery/fine-assessment-deep-head.js";
import type { RecallDeepHeadAssessment } from
  "../../recall/rerank/deep-head.js";

function assessment(
  overrides: Partial<RecallDeepHeadAssessment> = {}
): RecallDeepHeadAssessment {
  return Object.freeze({
    scores: new Map([["workspace_local:memory_entry:a", 0.91]]),
    traceByCandidateKey: new Map(),
    embeddingObserved: false,
    relevanceUpperBoundReceipt: null,
    ...overrides
  });
}

describe("composeFineAssessmentDeepHeadDelivery", () => {
  it("keeps fused order and Gamma relevance when embedding was not observed", () => {
    const composed = composeFineAssessmentDeepHeadDelivery(assessment());
    expect(composed.orderScores.size).toBe(0);
    expect(composed.coverageRelevance.size).toBe(0);
    expect(composed.coverageRelevanceUpperBound).toBeNull();
  });

  it("lets observed embedding rescore the eligible pool", () => {
    const scores = new Map([["workspace_local:memory_entry:a", 0.91]]);
    const composed = composeFineAssessmentDeepHeadDelivery(assessment({
      embeddingObserved: true,
      scores
    }));
    expect(composed.orderScores).toBe(scores);
    expect(composed.coverageRelevance).toBe(scores);
  });
});
