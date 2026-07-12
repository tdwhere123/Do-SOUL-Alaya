import { describe, expect, it } from "vitest";
import type { RecallPolicy } from "@do-soul/alaya-protocol";
import {
  applyPathSuppressionToFusionScores,
  buildEmptyRecallFusionBreakdown,
  buildRecallFusionDetails,
  compareFusedRecallCandidates
} from "../../recall/delivery/fusion-delivery-scoring.js";
import type { FusedRecallCandidateInput } from
  "../../recall/delivery/fusion-delivery-scoring-candidate.js";
import { compileRecallQueryProbes } from "../../recall/query/recall-query-probes.js";
import type { RecallSupplementaryData } from
  "../../recall/runtime/recall-service-types.js";
import { createMemoryEntry } from "./recall-service-test-fixtures.js";

describe("fusion relevance properties", () => {
  it("matches comparator sign to scalar order for arbitrary candidate pairs", () => {
    for (let seed = 1; seed <= 257; seed += 1) {
      const left = candidate(seed, pseudoRandom(seed));
      const right = candidate(seed + 1000, pseudoRandom(seed * 17));
      const expected = compareScalarThenIdentity(left, right);
      expect(Math.sign(compareFusedRecallCandidates(left, right))).toBe(Math.sign(expected));
    }
  });

  it("keeps scores and ranks invariant under input permutations", () => {
    for (let size = 1; size <= 12; size += 1) {
      const candidates = Array.from({ length: size }, (_, index) =>
        candidate(index + 1, pseudoRandom(index + size + 1))
      );
      const forward = fusionProjection(candidates);
      const reversed = fusionProjection([...candidates].reverse());
      const rotated = fusionProjection([...candidates.slice(1), candidates[0]!]);
      expect(reversed).toEqual(forward);
      expect(rotated).toEqual(forward);
    }
  });

  it("recomputes suppression ties from candidate identity instead of old rank", () => {
    const left = candidate(1, 0.8).fusion;
    const right = candidate(2, 0.7).fusion;
    const fusion = new Map([
      [left.candidate_key, { ...left, fused_rank: 2 }],
      [right.candidate_key, { ...right, fused_rank: 1 }]
    ]);
    const suppressed = applyPathSuppressionToFusionScores(fusion, {
      [left.object_id]: 0.2,
      [right.object_id]: 0.1
    });
    expect(suppressed.get(left.candidate_key)?.fused_score).toBeCloseTo(0.6, 12);
    expect(suppressed.get(right.candidate_key)?.fused_score).toBeCloseTo(0.6, 12);
    expect(suppressed.get(left.candidate_key)?.fused_rank).toBe(1);
    expect(suppressed.get(right.candidate_key)?.fused_rank).toBe(2);
  });
});

function candidate(seed: number, fusedScore: number): FusedRecallCandidateInput {
  const objectId = `candidate-${seed.toString().padStart(4, "0")}`;
  const fusion = buildEmptyRecallFusionBreakdown(objectId);
  return {
    entry: createMemoryEntry({ object_id: objectId, activation_score: pseudoRandom(seed * 31) }),
    effectiveScore: pseudoRandom(seed * 47),
    effectiveFactors: { activation: 0, relevance: 0 },
    fusion: { ...fusion, fused_score: fusedScore, fused_rank: 10_000 - seed }
  };
}

function compareScalarThenIdentity(
  left: FusedRecallCandidateInput,
  right: FusedRecallCandidateInput
): number {
  const scoreDelta = right.fusion.fused_score - left.fusion.fused_score;
  return scoreDelta !== 0
    ? scoreDelta
    : left.fusion.candidate_key.localeCompare(right.fusion.candidate_key);
}

function fusionProjection(candidates: readonly FusedRecallCandidateInput[]) {
  const details = buildRecallFusionDetails({
    candidates,
    policy: {} as RecallPolicy,
    supplementaryData: supplementary(),
    nowIso: "2026-07-12T00:00:00.000Z"
  });
  return [...details.values()]
    .map((row) => [row.candidate_key, row.fused_score, row.fused_rank] as const)
    .sort(([left], [right]) => left.localeCompare(right));
}

function supplementary(): RecallSupplementaryData {
  return {
    queryProbes: compileRecallQueryProbes("arbitrary property query"),
    ftsRanks: {}, trigramFtsRanks: {}, synthesisFtsRanks: {}, evidenceFtsRanks: {},
    sourceProximityScores: {}, sourceCohortKeys: {}, structuralScores: {},
    graphExpansionScores: {}, entitySeedScores: {}, pathExpansionScores: {},
    pathSuppressionScores: {}, embeddingSimilarityScores: {}, graphSupportCounts: {},
    budgetPenaltyFactor: 0, plasticityFactors: {}, graphAndPathColdScore: 0,
    recallsEdgeCount: 0, weightTransferAmount: 0, evidenceGistsByMemoryId: {},
    governanceCeilingByMemoryId: {}
  };
}

function pseudoRandom(seed: number): number {
  return ((seed * 48_271) % 2_147_483_647) / 2_147_483_647;
}
