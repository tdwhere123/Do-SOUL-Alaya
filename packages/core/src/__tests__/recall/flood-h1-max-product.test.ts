import { describe, expect, it } from "vitest";
import type { RecallPolicy } from "@do-soul/alaya-protocol";
import {
  installCoreConfigFromProcessEnv,
  resetCoreConfigForTests
} from "../../config/index.js";
import { computeH1MaxProductTransfer } from
  "../../recall/flood/h1-max-product.js";
import { buildRecallFusionDetails } from
  "../../recall/delivery/fusion-delivery-scoring.js";
import { compileRecallQueryProbes } from
  "../../recall/query/recall-query-probes.js";
import type { FloodEdgeTransferInput } from
  "../../recall/flood/edge-transfer.js";
import type { SliceCompatibilityV1 } from
  "../../recall/flood/slice-key-selector.js";
import type { PathInflowEdge } from
  "../../recall/runtime/recall-service-types.js";
import type { RecallSupplementaryData } from
  "../../recall/runtime/recall-service-types.js";
import { createMemoryEntry } from "./recall-service-test-fixtures.js";

describe("H=1 max-product flood transfer", () => {
  it("selects the strongest parallel path and records its trace", () => {
    const result = computeH1MaxProductTransfer({
      ...input([
        edge("path-low", 0.4),
        edge("path-high", 0.7)
      ]),
      directPotential: 0
    });

    expect(result.potential).toBeCloseTo(0.56, 15);
    expect(result.pathContribution).toBeCloseTo(0.56, 15);
    expect(result.winner).toMatchObject({
      path_id: "path-high",
      input_potential: 0.8,
      edge_conductance: 0.7,
      decision: "transferred"
    });
    expect(result.winner?.capped_transfer).toBeCloseTo(0.56, 15);
    expect(result.transitionCounts).toMatchObject({
      evaluated_edge_count: 2,
      seed_overlap_edge_count: 2,
      transferred_edge_count: 2,
      rejected_edge_count: 0,
      reason_counts: { transferred: 2 }
    });
  });

  it("preserves a stronger direct target without path contribution", () => {
    const result = computeH1MaxProductTransfer({
      ...input([edge("path-high", 0.7)]),
      directPotential: 0.9
    });

    expect(result.potential).toBe(0.9);
    expect(result.pathContribution).toBe(0);
    expect(result.winner).toBeNull();
  });

  it("rejects invalid or conflicting edges while missing optional slice metadata passes", () => {
    const rejected = compatibility("rejected", "no_slice_match");
    const result = computeH1MaxProductTransfer({
      ...input([
        edge("path-conflict", 1),
        edge(undefined, 1),
        edge("path-pass-through", 0.7)
      ]),
      directPotential: 0,
      enforceSliceCompatibility: true,
      sliceCompatibilityByPathId: new Map([["path-conflict", rejected]])
    });

    expect(result.potential).toBeCloseTo(0.56, 15);
    expect(result.winner?.path_id).toBe("path-pass-through");
    expect(result.traces).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path_id: "path-conflict",
        decision: "rejected",
        reason: "no_slice_match"
      }),
      expect.objectContaining({
        decision: "rejected",
        reason: "missing_edge_provenance"
      }),
      expect.objectContaining({
        path_id: "path-pass-through",
        slice_compatibility: "not_evaluated",
        decision: "transferred"
      })
    ]));
  });

  it("counts every edge transition before diagnostic trace truncation", () => {
    const rejected = compatibility("rejected", "no_slice_match");
    const result = computeH1MaxProductTransfer({
      ...input([
        edge("path-transfer", 0.7),
        edge("path-conflict", 1),
        edge(undefined, 1)
      ]),
      directPotential: 0,
      traceLimit: 1,
      sliceCompatibilityByPathId: new Map([["path-conflict", rejected]])
    });

    expect(result.traces).toHaveLength(1);
    expect(result.truncatedCount).toBe(2);
    expect(result.transitionCounts).toMatchObject({
      evaluated_edge_count: 3,
      seed_overlap_edge_count: 3,
      transferred_edge_count: 1,
      rejected_edge_count: 2,
      reason_counts: {
        transferred: 1,
        missing_edge_provenance: 1,
        no_slice_match: 1
      }
    });
  });

  it("breaks equal-transfer ties by path id", () => {
    const result = computeH1MaxProductTransfer({
      ...input([edge("path-z", 0.7), edge("path-a", 0.7)]),
      directPotential: 0
    });

    expect(result.winner?.path_id).toBe("path-a");
  });

  it("applies the total flood cap to the strongest transfer", () => {
    const result = computeH1MaxProductTransfer({
      ...input([edge("path-capped", 1)]),
      capTotal: 0.3,
      directPotential: 0
    });

    expect(result.potential).toBe(0.3);
    expect(result.strongestTransfer).toBe(0.3);
  });

  it("uses the max-product potential as the final score only when explicitly enabled", () => {
    const seed = createMemoryEntry({ object_id: "seed" });
    const target = createMemoryEntry({ object_id: "target" });
    const supplementaryData = supplementary(
      seed.object_id,
      target.object_id,
      edge("path-final-score", 1)
    );
    const run = (h1MaxProduct: boolean) => buildRecallFusionDetails({
      candidates: [seed, target].map((entry) => ({
        entry,
        effectiveScore: 0,
        effectiveFactors: { activation: 0, relevance: 0 }
      })),
      policy: {} as RecallPolicy,
      supplementaryData,
      nowIso: "2026-07-30T00:00:00.000Z",
      h1MaxProduct
    });

    const targetKey = `workspace_local:memory_entry:${target.object_id}`;
    const h0 = run(false).get(targetKey)!;
    const h1 = run(true).get(targetKey)!;

    expect(h0.fused_score).toBe(0);
    expect(h1.fused_score).toBeGreaterThan(0);
    expect(h1.flood_potential).toMatchObject({
      final_score: h1.fused_score,
      A_path: expect.any(Number),
      path_status: "active",
      score_mode: "rrf_seeded_h1_max_product",
      h1_max_product: {
        seed_basis: "rrf_family_base",
        winner: "edge",
        winning_edge_trace: { path_id: "path-final-score" }
      }
    });
    expect(h1.flood_fuel_coverage).toMatchObject({
      h1_candidate_count: 2,
      h1_transferable_count: 1,
      h1_edge_winner_count: 1,
      h1_direct_winner_count: 1,
      h1_evaluated_edge_count: 1,
      h1_seed_overlap_edge_count: 1,
      h1_transferred_edge_count: 1,
      h1_rejected_edge_count: 0,
      h1_newly_admitted_frontier_target_count: 0,
      h1_reason_counts: { transferred: 1 }
    });
  });

  it("activates through the installed runtime configuration", () => {
    const seed = createMemoryEntry({ object_id: "seed" });
    const target = createMemoryEntry({ object_id: "target" });
    try {
      installCoreConfigFromProcessEnv({
        ALAYA_RECALL_CONF_H1_MAX_PRODUCT: "on"
      });
      const result = buildRecallFusionDetails({
        candidates: [seed, target].map((entry) => ({
          entry,
          effectiveScore: 0,
          effectiveFactors: { activation: 0, relevance: 0 }
        })),
        policy: {} as RecallPolicy,
        supplementaryData: supplementary(
          seed.object_id,
          target.object_id,
          edge("runtime-path", 1)
        ),
        nowIso: "2026-07-30T00:00:00.000Z"
      }).get(`workspace_local:memory_entry:${target.object_id}`);

      expect(result?.flood_potential).toMatchObject({
        score_mode: "rrf_seeded_h1_max_product",
        h1_max_product: {
          winner: "edge",
          winning_edge_trace: { path_id: "runtime-path" }
        }
      });
    } finally {
      resetCoreConfigForTests();
    }
  });
});

function input(inflow: readonly PathInflowEdge[]): FloodEdgeTransferInput {
  return {
    inflow,
    targetObjectId: "target",
    rObjectById: new Map([["seed", 0.8]]),
    capPerSource: 1,
    capTotal: 1,
    rhoPath: 0.5
  };
}

function edge(pathId: string | undefined, weight: number): PathInflowEdge {
  return {
    pathId,
    relationKind: "answers_with",
    seedObjectId: "seed",
    targetObjectId: "target",
    seedAnchor: { kind: "object", object_id: "seed" },
    targetAnchor: { kind: "object", object_id: "target" },
    pathSourceVersion: "2026-07-30T00:00:00.000Z",
    weight
  };
}

function compatibility(
  decision: SliceCompatibilityV1["decision"],
  reason: SliceCompatibilityV1["reason"]
): SliceCompatibilityV1 {
  return { decision, reason, matches: [] };
}

function supplementary(
  seedObjectId: string,
  targetObjectId: string,
  inflow: PathInflowEdge
): RecallSupplementaryData {
  return {
    queryProbes: compileRecallQueryProbes("release database"),
    ftsRanks: { [seedObjectId]: 1 },
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
    evidenceSemanticScoresByCandidateKey: new Map(),
    graphSupportCounts: {},
    budgetPenaltyFactor: 0,
    plasticityFactors: {},
    graphAndPathColdScore: 0,
    recallsEdgeCount: 1,
    weightTransferAmount: 0,
    evidenceGistsByMemoryId: {},
    governanceCeilingByMemoryId: {},
    pathInflowByTarget: { [targetObjectId]: [inflow] }
  };
}
