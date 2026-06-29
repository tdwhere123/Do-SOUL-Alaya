import { describe, expect, it } from "vitest";
import {
  buildPathInflowByTarget,
  scorePathRelationExpansion
} from "../../recall/path-relations.js";
import { createPathRelation } from "./recall-service-test-fixtures.js";

const SRC = "memory-src";
const TGT = "memory-tgt";

// Distinctive non-clamped weight (0.8*0.55 + 0.4*0.25 + 0.1 answers_with boost = 0.64) so a
// weight-source swap to e.g. the suppression scorer (0 on positive paths) cannot coincide.
function distinctivePath(
  overrides: Parameters<typeof createPathRelation>[0] = {}
): ReturnType<typeof createPathRelation> {
  return createPathRelation({
    sourceId: SRC,
    targetId: TGT,
    strength: 0.8,
    recallBias: 0.4,
    relationKind: "answers_with",
    governanceClass: "hint_only",
    stabilityClass: "volatile",
    ...overrides
  });
}

describe("buildPathInflowByTarget (conformant flood adjacency)", () => {
  it("source_to_target: edge seed = source, keyed under target (both in pool)", () => {
    const path = distinctivePath({ directionBias: "source_to_target" });
    const inflow = buildPathInflowByTarget([path], new Set([SRC, TGT]));
    expect(inflow).toEqual({ [TGT]: [{ seedObjectId: SRC, weight: scorePathRelationExpansion(path) }] });
  });

  it("target_to_source: edge seed = target, keyed under source (both in pool)", () => {
    const path = distinctivePath({ directionBias: "target_to_source" });
    const inflow = buildPathInflowByTarget([path], new Set([SRC, TGT]));
    expect(inflow).toEqual({ [SRC]: [{ seedObjectId: TGT, weight: scorePathRelationExpansion(path) }] });
  });

  it("bidirectional_asymmetric: yields both directions (both in pool)", () => {
    const path = distinctivePath({ directionBias: "bidirectional_asymmetric" });
    const weight = scorePathRelationExpansion(path);
    const inflow = buildPathInflowByTarget([path], new Set([SRC, TGT]));
    expect(inflow).toEqual({
      [TGT]: [{ seedObjectId: SRC, weight }],
      [SRC]: [{ seedObjectId: TGT, weight }]
    });
  });

  it("excludes the edge when its seed is not in the candidate pool", () => {
    const path = distinctivePath({ directionBias: "source_to_target" });
    expect(buildPathInflowByTarget([path], new Set([TGT]))).toEqual({});
  });

  it("excludes the edge when its target is not in the candidate pool", () => {
    const path = distinctivePath({ directionBias: "source_to_target" });
    expect(buildPathInflowByTarget([path], new Set([SRC]))).toEqual({});
  });

  it("excludes a recall-ineligible path (retired lifecycle)", () => {
    const path = distinctivePath({ directionBias: "source_to_target", status: "retired" });
    expect(buildPathInflowByTarget([path], new Set([SRC, TGT]))).toEqual({});
  });

  it("excludes a recall-ineligible path (non-positive recall_bias)", () => {
    const path = distinctivePath({ directionBias: "source_to_target", recallBias: 0 });
    expect(buildPathInflowByTarget([path], new Set([SRC, TGT]))).toEqual({});
  });

  it("P2: excludes a co-occurrence relation (co_recalled) — only answer edges carry π", () => {
    const path = distinctivePath({ directionBias: "source_to_target", relationKind: "co_recalled" });
    expect(buildPathInflowByTarget([path], new Set([SRC, TGT]))).toEqual({});
  });

  it("P2: excludes a co-occurrence relation (coheres_with)", () => {
    const path = distinctivePath({ directionBias: "source_to_target", relationKind: "coheres_with" });
    expect(buildPathInflowByTarget([path], new Set([SRC, TGT]))).toEqual({});
  });

  it("excludes a self-loop (source === target)", () => {
    const path = distinctivePath({ sourceId: SRC, targetId: SRC, directionBias: "bidirectional_asymmetric" });
    expect(buildPathInflowByTarget([path], new Set([SRC]))).toEqual({});
  });

  it("sources edge weight from scorePathRelationExpansion (guards a scorer swap)", () => {
    const path = distinctivePath({ directionBias: "source_to_target" });
    const expectedWeight = scorePathRelationExpansion(path);
    expect(expectedWeight).toBeCloseTo(0.64, 10);
    expect(expectedWeight).toBeGreaterThan(0);
    const edges = buildPathInflowByTarget([path], new Set([SRC, TGT]))[TGT] ?? [];
    expect(edges).toHaveLength(1);
    expect(edges[0]?.weight).toBe(expectedWeight);
  });
});
