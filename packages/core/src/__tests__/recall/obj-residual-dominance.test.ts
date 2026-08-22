import { describe, expect, it } from "vitest";
import {
  buildEmptyRecallFusionBreakdown,
  compareFusedRecallCandidates
} from "../../recall/delivery/fusion-delivery-scoring.js";
import { computeIntegratedFloodScore } from "../../recall/scoring/integrated-flood-scoring.js";
import type { FusedRecallCandidateInput } from
  "../../recall/delivery/fusion-delivery-scoring-candidate.js";
import { createMemoryEntry, supplementary } from "./integrated-flood-scoring.test-support.js";

describe("object-score residual dominance", () => {
  it("cannot let verified flood residual invert a strictly higher R_obj", () => {
    const seed = createMemoryEntry({ object_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    const weakId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const weak = createMemoryEntry({ object_id: weakId, evidence_refs: ["ev-weak"] });
    const strong = createMemoryEntry({ object_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" });
    const data = supplementary({
      pathInflowByTarget: {
        [weakId]: [{ seedObjectId: seed.object_id, weight: 1 }]
      },
      evidenceSupportVectorsByMemoryId: {
        [weakId]: [{ source_kind: "evidence_ref", source_id: "ev-weak", support: 1 }]
      }
    });
    const floodedWeak = computeIntegratedFloodScore({
      entry: weak,
      axisInputs: { R_obj: 0.04, A_path: 1, B_evidence: 1 },
      supplementaryData: data
    });
    const stronger = computeIntegratedFloodScore({
      entry: strong,
      axisInputs: { R_obj: 0.08, A_path: 0, B_evidence: 0 },
      supplementaryData: data
    });
    expect(floodedWeak.diagnostics.fuel_verified).toBe(true);
    expect(floodedWeak.diagnostics.Flood).toBeGreaterThan(0);
    expect(stronger.score).toBeGreaterThan(floodedWeak.score);
    expect(stronger.score).toBeCloseTo(0.08, 12);
    expect(floodedWeak.score).toBeCloseTo(0.04, 12);

    const ordered = [fused(weak, floodedWeak.score), fused(strong, stronger.score)]
      .sort(compareFusedRecallCandidates);
    expect(ordered.map((row) => row.entry.object_id)).toEqual([
      strong.object_id,
      weak.object_id
    ]);
  });
});

function fused(
  entry: ReturnType<typeof createMemoryEntry>,
  fusedScore: number
): FusedRecallCandidateInput {
  return {
    entry,
    effectiveScore: fusedScore,
    effectiveFactors: { activation: 0, relevance: 0 },
    fusion: Object.freeze({
      ...buildEmptyRecallFusionBreakdown(entry.object_id),
      fused_score: fusedScore
    })
  };
}
