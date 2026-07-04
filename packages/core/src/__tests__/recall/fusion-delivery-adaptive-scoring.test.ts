import { afterEach, describe, expect, it, vi } from "vitest";
import type { RecallPolicy } from "@do-soul/alaya-protocol";
import {
  resolveFusionContribution,
  resolveRrfFusionWeights
} from "../../recall/delivery/fusion-delivery-adaptive-scoring.js";
import { activeFusionStreams, RECALL_FUSION_DEFAULT_WEIGHTS } from "../../recall/delivery/fusion-delivery-streams.js";
import { compileRecallQueryProbes } from "../../recall/query/recall-query-probes.js";
import type { RecallSupplementaryData } from "../../recall/runtime/recall-service-types.js";
import { createMemoryEntry } from "./recall-service-test-fixtures.js";

function emptySupplementaryData(query: string): RecallSupplementaryData {
  return {
    queryProbes: compileRecallQueryProbes(query),
    ftsRanks: {},
    trigramFtsRanks: {},
    synthesisFtsRanks: {},
    evidenceFtsRanks: {},
    sourceProximityScores: {},
    sourceCohortKeys: {},
    structuralScores: {},
    graphExpansionScores: {},
    entitySeedScores: {},
    pathExpansionScores: {},
    pathSuppressionScores: {},
    embeddingSimilarityScores: {},
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

describe("resolveRrfFusionWeights", () => {
  it("honors policy fusion_weights overrides", () => {
    const streams = activeFusionStreams();
    const resolved = resolveRrfFusionWeights({
      policy: {
        scoring_weight_overrides: {
          fusion_weights: {
            lexical_fts: 9,
            lexical_fts_rrf_k: 10
          }
        }
      } as unknown as RecallPolicy,
      queryProbes: compileRecallQueryProbes("how does routing work?"),
      streams,
      baseWeights: RECALL_FUSION_DEFAULT_WEIGHTS
    });

    expect(resolved.weights.lexical_fts).toBe(9);
    expect(resolved.kByStream.lexical_fts).toBe(10);
  });
});

describe("resolveFusionContribution", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses weight * reliability / (k + rank)", () => {
    vi.stubEnv("ALAYA_RECALL_PATH_EMB_MODULATION", "off");
    const memory = createMemoryEntry({
      object_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
    });
    const resolved = resolveRrfFusionWeights({
      policy: {
        scoring_weight_overrides: {
          fusion_weights: {
            embedding_similarity: 6,
            embedding_similarity_rrf_k: 10
          }
        }
      } as unknown as RecallPolicy,
      queryProbes: compileRecallQueryProbes("embedding probe"),
      streams: ["embedding_similarity"],
      baseWeights: RECALL_FUSION_DEFAULT_WEIGHTS
    });

    const contribution = resolveFusionContribution({
      candidate: {
        entry: memory,
        effectiveFactors: { activation: 0, relevance: 0 }
      },
      supplementaryData: emptySupplementaryData("embedding probe"),
      resolved,
      stream: "embedding_similarity",
      rank: 1
    });

    expect(contribution).toBeCloseTo(6 / 11, 6);
  });
});
