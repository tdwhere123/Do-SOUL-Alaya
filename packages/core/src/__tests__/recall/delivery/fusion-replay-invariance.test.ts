import { describe, expect, it } from "vitest";
import type { RecallPolicy } from "@do-soul/alaya-protocol";
import { buildRecallFusionDetails } from "../../../recall/delivery/fusion-delivery-scoring.js";
import { compileRecallQueryProbes } from "../../../recall/query/recall-query-probes.js";
import type { RecallSupplementaryData } from "../../../recall/runtime/recall-service-types.js";
import { createMemoryEntry } from "../recall-service-test-fixtures.js";

const ALPHA_CONTENT = "Alpha replay-stable memory.";
const ZEBRA_CONTENT = "Zebra replay-stable memory.";

function emptySupplementaryData(): RecallSupplementaryData {
  return {
    queryProbes: compileRecallQueryProbes("stable replay"),
    ftsRanks: {},
    trigramFtsRanks: {},
    synthesisFtsRanks: {},
    evidenceFtsRanks: {},
    evidenceProjectionMatchesByRef: {},
    sourceProximityScores: {},
    sourceCohortKeys: {},
    structuralScores: {},
    graphExpansionScores: {},
    entitySeedScores: {},
    pathExpansionScores: {},
    pathSuppressionScores: {},
    embeddingSimilarityScores: {},
    evidenceSemanticActivationsByCandidateKey: new Map(),
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

function buildContentRanks(params: Readonly<{
  readonly alphaId: string;
  readonly zebraId: string;
  readonly alphaScore: number;
  readonly zebraScore: number;
}>): Readonly<Record<string, number>> {
  const entries = [
    createMemoryEntry({
      object_id: params.alphaId,
      content: ALPHA_CONTENT,
      created_at: "2026-08-06T03:00:00.001Z",
      activation_score: params.alphaScore
    }),
    createMemoryEntry({
      object_id: params.zebraId,
      content: ZEBRA_CONTENT,
      created_at: "2026-08-06T03:00:00.002Z",
      activation_score: params.zebraScore
    })
  ];
  const fusion = buildRecallFusionDetails({
    candidates: entries.map((entry) => ({
      entry,
      effectiveScore: entry.activation_score ?? 0,
      effectiveFactors: { activation: entry.activation_score ?? 0, relevance: 0 }
    })),
    policy: {} as RecallPolicy,
    supplementaryData: emptySupplementaryData(),
    nowIso: "2026-08-06T03:01:00.000Z"
  });
  return Object.freeze(Object.fromEntries(entries.map((entry) => [
    entry.content,
    fusion.get(`workspace_local:memory_entry:${entry.object_id}`)?.per_stream_rank.workspace_activation
  ])) as Record<string, number>);
}

describe("fusion replay invariance", () => {
  it("does not amplify sub-precision dynamics drift or random IDs into relevance order", () => {
    const first = buildContentRanks({
      alphaId: "99999999-9999-4999-8999-999999999999",
      zebraId: "11111111-1111-4111-8111-111111111111",
      alphaScore: 0.9324999723600726,
      zebraScore: 0.9324999994735418
    });
    const replay = buildContentRanks({
      alphaId: "11111111-1111-4111-8111-111111111111",
      zebraId: "99999999-9999-4999-8999-999999999999",
      alphaScore: 0.9324999989503825,
      zebraScore: 0.93249997340969
    });

    expect(first).toEqual(replay);
    expect(first[ALPHA_CONTENT]).toBe(1);
  });
});
