import { describe, expect, it, vi } from "vitest";
import type { RecallPolicy } from "@do-soul/alaya-protocol";

const contributionCalls = vi.hoisted(() => [] as string[]);

vi.mock("../../recall/delivery/fusion-delivery-adaptive-scoring.js", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("../../recall/delivery/fusion-delivery-adaptive-scoring.js")
  >();
  return {
    ...original,
    resolveFusionContribution: (
      params: Parameters<typeof original.resolveFusionContribution>[0]
    ): number => {
      contributionCalls.push(`${params.candidate.entry.object_id}:${params.stream}`);
      return original.resolveFusionContribution(params);
    }
  };
});

import { buildRecallFusionDetails } from "../../recall/delivery/fusion-delivery-scoring.js";
import { aggregateFamilyContributions } from "../../recall/delivery/fusion-delivery-families.js";
import { compileRecallQueryProbes } from "../../recall/query/recall-query-probes.js";
import type {
  RecallFusionBreakdown,
  RecallSupplementaryData
} from "../../recall/runtime/recall-service-types.js";
import { createMemoryEntry } from "./recall-service-test-fixtures.js";

function supplementaryData(ids: readonly string[]): RecallSupplementaryData {
  return {
    queryProbes: compileRecallQueryProbes("materialization router evidence"),
    ftsRanks: { [ids[0]!]: 1, [ids[1]!]: 0.8 },
    trigramFtsRanks: { [ids[0]!]: 0.7 },
    synthesisFtsRanks: {},
    evidenceFtsRanks: { [ids[0]!]: 0.9, [ids[1]!]: 0.6 },
    sourceProximityScores: {},
    sourceCohortKeys: {},
    structuralScores: { [ids[0]!]: 0.9, [ids[1]!]: 0.5 },
    graphExpansionScores: {},
    entitySeedScores: {},
    pathExpansionScores: {},
    pathSuppressionScores: {},
    embeddingSimilarityScores: { [ids[0]!]: 0.8, [ids[1]!]: 0.4 },
    graphSupportCounts: {},
    budgetPenaltyFactor: 0,
    plasticityFactors: {},
    graphAndPathColdScore: 0,
    recallsEdgeCount: 0,
    weightTransferAmount: 0,
    evidenceGistsByMemoryId: {},
    governanceCeilingByMemoryId: {}
  };
}

function expectedContributionCalls(
  details: ReadonlyMap<string, RecallFusionBreakdown>
): readonly string[] {
  return [...details.values()].flatMap((breakdown) =>
    Object.entries(breakdown.per_stream_rank)
      .filter(([, rank]) => rank !== null)
      .map(([stream]) => `${breakdown.object_id}:${stream}`)
  ).sort();
}

describe("fusion delivery stream snapshots", () => {
  it("reuses each candidate-stream contribution across axis and delivery diagnostics", () => {
    contributionCalls.length = 0;
    const entries = [
      createMemoryEntry({
        object_id: "11111111-1111-4111-8111-111111111111",
        content: "Materialization router evidence is persisted."
      }),
      createMemoryEntry({
        object_id: "22222222-2222-4222-8222-222222222222",
        content: "Materialization router evidence is projected."
      })
    ];
    const details = buildRecallFusionDetails({
      candidates: entries.map((entry, index) => ({
        entry,
        effectiveScore: index === 0 ? 0.8 : 0.4,
        effectiveFactors: { activation: 0.4, relevance: 0.6, embedding_similarity: 0.8 },
        structuralScore: index === 0 ? 0.9 : 0.5
      })),
      policy: {} as RecallPolicy,
      supplementaryData: supplementaryData(entries.map((entry) => entry.object_id)),
      nowIso: "2026-03-20T10:20:30.000Z"
    });

    expect([...contributionCalls].sort()).toEqual(expectedContributionCalls(details));
    const ranked = [...details.values()].sort((left, right) => left.fused_rank - right.fused_rank);
    expect(ranked.map((row) => row.object_id)).toEqual(entries.map((entry) => entry.object_id));
    for (const row of ranked) {
      const familyBase = aggregateFamilyContributions(row.fused_rank_contribution_per_stream);
      expect(row.per_axis_contribution?.object).toBeCloseTo(familyBase, 8);
      expect(row.flood_potential?.R_obj).toBeCloseTo(familyBase, 8);
      expect(row.flood_potential?.final_score).toBe(row.fused_score);
    }
  });
});
