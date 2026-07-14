import { afterEach, describe, expect, it, vi } from "vitest";
import type { RecallPolicy } from "@do-soul/alaya-protocol";
import {
  applyEmbeddingPathModulation,
  buildConflictGateContext,
  resolveFusionContribution,
  resolveRrfFusionWeights,
  selectWouldOutrankSuppressedKeys,
  shouldSuppressConflictStreamContribution
} from "../../recall/delivery/fusion-delivery-adaptive-scoring.js";
import { activeFusionStreams, RECALL_FUSION_DEFAULT_WEIGHTS } from "../../recall/delivery/fusion-delivery-streams.js";
import { compileRecallQueryProbes } from "../../recall/query/recall-query-probes.js";
import type { RecallFusionStream, RecallSupplementaryData } from "../../recall/runtime/recall-service-types.js";
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

describe("conflict would-outrank suppression", () => {
  it("suppresses conflict lanes for emb-unsupported candidates that clear the emb-head floor", () => {
    const decisiveKey = "workspace_local:memory_entry:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const pileKey = "workspace_local:memory_entry:dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const gate = buildConflictGateContext({
      candidateKeys: [decisiveKey, pileKey],
      embeddingRanks: new Map([[decisiveKey, 1]]),
      embeddingScores: {
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa": 0.9
      }
    });
    expect(gate.poolEmbeddingDecisive).toBe(true);

    const embWeight = RECALL_FUSION_DEFAULT_WEIGHTS.embedding_similarity;
    const pathWeight = RECALL_FUSION_DEFAULT_WEIGHTS.path_expansion;
    const contributionsByKey = new Map<string, Partial<Record<RecallFusionStream, number>>>([
      [decisiveKey, { embedding_similarity: embWeight / 61 }],
      [pileKey, { path_expansion: pathWeight / 61, structural: pathWeight / 61, graph_expansion: pathWeight / 61 }]
    ]);
    const suppressed = selectWouldOutrankSuppressedKeys({ gate, contributionsByKey });
    expect(suppressed.has(pileKey)).toBe(true);
    expect(suppressed.has(decisiveKey)).toBe(false);
    expect(shouldSuppressConflictStreamContribution({
      stream: "path_expansion",
      candidateKey: pileKey,
      suppressedCandidateKeys: suppressed
    })).toBe(true);
    expect(shouldSuppressConflictStreamContribution({
      stream: "lexical_fts",
      candidateKey: pileKey,
      suppressedCandidateKeys: suppressed
    })).toBe(false);
  });

  it("keeps conflict lanes for emb-scored rescue-band candidates (emb rank ≤ 2×decisive)", () => {
    const decisiveKey = "workspace_local:memory_entry:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const rescueKey = "workspace_local:memory_entry:99999999-9999-4999-8999-999999999999";
    const gate = buildConflictGateContext({
      candidateKeys: [decisiveKey, rescueKey],
      embeddingRanks: new Map([
        [decisiveKey, 1],
        [rescueKey, 10]
      ]),
      embeddingScores: {
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa": 0.9,
        "99999999-9999-4999-8999-999999999999": 0.7
      }
    });
    const embWeight = RECALL_FUSION_DEFAULT_WEIGHTS.embedding_similarity;
    const pathWeight = RECALL_FUSION_DEFAULT_WEIGHTS.path_expansion;
    const contributionsByKey = new Map<string, Partial<Record<RecallFusionStream, number>>>([
      [decisiveKey, { embedding_similarity: embWeight / 61 }],
      [rescueKey, {
        embedding_similarity: embWeight / 70,
        path_expansion: pathWeight / 61,
        structural: pathWeight / 61
      }]
    ]);
    const suppressed = selectWouldOutrankSuppressedKeys({ gate, contributionsByKey });
    expect(suppressed.has(rescueKey)).toBe(false);
  });

  it("suppresses weak-emb conflict piles outside the fused-rescue band", () => {
    const decisiveKey = "workspace_local:memory_entry:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const weakEmbPileKey = "workspace_local:memory_entry:cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const gate = buildConflictGateContext({
      candidateKeys: [decisiveKey, weakEmbPileKey],
      embeddingRanks: new Map([
        [decisiveKey, 1],
        // First rank past 2×decisive (10): emb presence alone is not support.
        [weakEmbPileKey, 11]
      ]),
      embeddingScores: {
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa": 0.9,
        "cccccccc-cccc-4ccc-8ccc-cccccccccccc": 0.4
      }
    });
    const embWeight = RECALL_FUSION_DEFAULT_WEIGHTS.embedding_similarity;
    const pathWeight = RECALL_FUSION_DEFAULT_WEIGHTS.path_expansion;
    const contributionsByKey = new Map<string, Partial<Record<RecallFusionStream, number>>>([
      [decisiveKey, { embedding_similarity: embWeight / 61 }],
      [weakEmbPileKey, {
        embedding_similarity: embWeight / 71,
        path_expansion: pathWeight / 61,
        structural: pathWeight / 61,
        graph_expansion: pathWeight / 61
      }]
    ]);
    const suppressed = selectWouldOutrankSuppressedKeys({ gate, contributionsByKey });
    expect(suppressed.has(weakEmbPileKey)).toBe(true);
  });
});

describe("applyEmbeddingPathModulation", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("skips path×cosine boost when the embedding pool is decisive", () => {
    const memory = createMemoryEntry({
      object_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
    });
    const supplementaryData = {
      ...emptySupplementaryData("path modulation"),
      embeddingSimilarityScores: { [memory.object_id]: 0.95 }
    };
    const gate = buildConflictGateContext({
      candidateKeys: [`workspace_local:memory_entry:${memory.object_id}`],
      embeddingRanks: new Map([[`workspace_local:memory_entry:${memory.object_id}`, 1]]),
      embeddingScores: { [memory.object_id]: 0.95 }
    });
    const boosted = applyEmbeddingPathModulation(
      1,
      { entry: memory, effectiveFactors: { activation: 0, relevance: 0 } },
      supplementaryData,
      "path_expansion"
    );
    const gated = applyEmbeddingPathModulation(
      1,
      { entry: memory, effectiveFactors: { activation: 0, relevance: 0 } },
      supplementaryData,
      "path_expansion",
      gate
    );
    expect(boosted).toBeGreaterThan(1);
    expect(gated).toBe(1);
  });
});
