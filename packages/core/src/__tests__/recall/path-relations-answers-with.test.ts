import { describe, expect, it } from "vitest";
import {
  answersWithPathFuelEnabled,
  buildPathInflowByTarget,
  scorePathRelationExpansion
} from "../../recall/expansion/path-relations.js";
import { createPathRelation } from "./recall-service-test-fixtures.js";

describe("answers_with path inflow", () => {
  it("path fuel is always on", () => {
    expect(answersWithPathFuelEnabled()).toBe(true);
  });

  it("uses answers_with as path-flood fuel", () => {
    const inflow = buildPathInflowByTarget(
      [
        createPathRelation({
          path_id: "path-answer",
          sourceId: "seed-memory",
          targetId: "answer-memory",
          relationKind: "answers_with",
          strength: 1,
          recallBias: 1
        })
      ],
      new Set(["seed-memory", "answer-memory"])
    );

    expect(inflow["answer-memory"]).toEqual([
      expect.objectContaining({ seedObjectId: "seed-memory" })
    ]);
    expect(inflow["answer-memory"]?.[0]?.weight ?? 0).toBeGreaterThan(0);
  });

  it("keeps non-answer relations inert for path-flood fuel", () => {
    const inflow = buildPathInflowByTarget(
      [
        createPathRelation({
          path_id: "path-co-recalled",
          sourceId: "seed-memory",
          targetId: "neighbor-memory",
          relationKind: "co_recalled",
          strength: 1,
          recallBias: 1
        })
      ],
      new Set(["seed-memory", "neighbor-memory"])
    );

    expect(inflow["neighbor-memory"]).toBeUndefined();
  });
});

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
  it("ranks answers_with above coheres_with", () => {
    expect(scorePathRelationExpansion(pathOf("answers_with"))).toBeGreaterThan(
      scorePathRelationExpansion(pathOf("coheres_with"))
    );
  });

  it("adds exactly the modest additive bonus over a co-occurrence edge", () => {
    const answersWith = scorePathRelationExpansion(pathOf("answers_with"));
    const cohereWith = scorePathRelationExpansion(pathOf("coheres_with"));
    expect(answersWith - cohereWith).toBeCloseTo(0.1, 10);
  });

  it("non-answers_with edges score the bonus-free formula", () => {
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
