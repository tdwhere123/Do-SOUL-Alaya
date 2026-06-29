import { describe, expect, it } from "vitest";
import { scorePathRelationExpansion } from "../../recall/path-relations.js";
import { createPathRelation } from "./recall-service-test-fixtures.js";

// Equal strength / governance / stability so only relation_kind differs.
function pathOf(relationKind: string): ReturnType<typeof createPathRelation> {
  return createPathRelation({
    sourceId: "src",
    targetId: "tgt",
    relationKind,
    strength: 0.8,
    recallBias: 0.4,
    governanceClass: "recall_allowed",
    stabilityClass: "volatile"
  });
}

describe("scorePathRelationExpansion answers_with weighting", () => {
  it("ranks answers_with above coheres_with at identical strength/governance", () => {
    expect(scorePathRelationExpansion(pathOf("answers_with"))).toBeGreaterThan(
      scorePathRelationExpansion(pathOf("coheres_with"))
    );
  });

  it("adds exactly the modest additive bonus over a co-occurrence edge", () => {
    const answersWith = scorePathRelationExpansion(pathOf("answers_with"));
    const cohereWith = scorePathRelationExpansion(pathOf("coheres_with"));
    expect(answersWith - cohereWith).toBeCloseTo(0.1, 10);
  });

  it("off = byte-equivalent: a non-answers_with edge scores the bonus-free formula", () => {
    // 0.8*0.55 + 0.4*0.25 + 0.15 (recall_allowed) + 0 (volatile) + 0 (no answerhood bonus).
    expect(scorePathRelationExpansion(pathOf("coheres_with"))).toBeCloseTo(0.69, 10);
    expect(scorePathRelationExpansion(pathOf("co_recalled"))).toBeCloseTo(0.69, 10);
    expect(scorePathRelationExpansion(pathOf("supports"))).toBeCloseTo(0.69, 10);
  });

  it("clamps to 1 when the bonus would overflow", () => {
    const saturated = createPathRelation({
      sourceId: "src",
      targetId: "tgt",
      relationKind: "answers_with",
      strength: 1,
      recallBias: 1,
      governanceClass: "recall_allowed",
      stabilityClass: "pinned"
    });
    expect(scorePathRelationExpansion(saturated)).toBe(1);
  });
});
