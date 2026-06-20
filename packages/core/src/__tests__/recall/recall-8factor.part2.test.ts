import { describe, expect, it } from "vitest";
import { MemoryDimension, RecallContextEventType, type ActivationWeights } from "@do-soul/alaya-protocol";
import { RecallService } from "../../recall/recall-service.js";
import { PATH_PLASTICITY_WEIGHT } from "../../recall/recall-service-helpers.js";
import { createDependencies, createMemoryEntry, createSlot, createTaskSurface, expectScoreWeightTotalConserved } from "./recall-8factor-test-fixtures.js";

import { FALSE_CONFIDENT_ACCEPTANCE_THRESHOLD } from "./recall-8factor.test-support.js";

describe("RecallService 8-factor scoring", () => {
// invariant: shouldCalibrateWeakEvidence must NOT fire when query-grounded
  // evidence sits at or above WEAK_EVIDENCE_CALIBRATION_GATE. Strong-
  // evidence queries keep the un-calibrated score shape; full-weak queries
  // with no prior signal do not enter the calibration branch at all.
  it("does not reshape strong query-grounded evidence below saturation", async () => {
    const { dependencies, searchByKeyword } = createDependencies(
      [
        createMemoryEntry({
          object_id: "strong-multi-evidence",
          content: "Strong multi-signal evidence",
          activation_score: 1,
          confidence: 1
        })
      ],
      [],
      {},
      {
        // graph_support count 3 → normalizeGraphSupport returns 1.0 (above
        // WEAK_EVIDENCE_CALIBRATION_GATE). queryEvidenceCalibrationStrength
        // = max(relevance, graph_support, embedding) ≥ 1.0, so the gate
        // condition `< 0.72` is false.
        graphSupportByMemoryId: { "strong-multi-evidence": 3 }
      }
    );
    searchByKeyword.mockResolvedValue([
      { object_id: "strong-multi-evidence", normalized_rank: 0.9 }
    ]);
    const service = new RecallService(dependencies);

    const result = await service.recall({
      taskSurface: createTaskSurface("Strong multi-signal evidence"),
      workspaceId: "workspace-1",
      runId: "run-1",
      strategy: "build"
    });

    const strong = result.candidates.find(
      (candidate) => candidate.object_id === "strong-multi-evidence"
    );
    const factors = strong?.score_factors;
    expect(factors?.graph_support).toBeCloseTo(1);

    // gate did not fire → weighted_relevance is content_relevance *
    // resolved relevance weight (no evidenceContributionCalibration shrink).
    const expectedWeightedRelevance =
      (factors?.content_relevance ?? 0) *
      (factors?.resolved_activation_weights?.relevance ?? 0);
    expect(factors?.weighted_relevance ?? 0).toBeCloseTo(expectedWeightedRelevance);

    // gate did not fire → adjusted_base_weight equals base_weight minus
    // queryEvidenceTransfer (no priorEvidenceCalibration shrink).
    const expectedAdjustedBaseWeight = Math.max(
      0,
      (factors?.base_weight ?? 0) - (factors?.query_evidence_transfer ?? 0)
    );
    expect(factors?.adjusted_base_weight ?? 0).toBeCloseTo(expectedAdjustedBaseWeight);
  });

it("calibrates weak-evidence candidates carrying a prior signal", async () => {
    const { dependencies, searchByKeyword } = createDependencies(
      [
        createMemoryEntry({
          object_id: "weak-prior-heavy",
          content: "Tangential prior text",
          activation_score: 1,
          confidence: 1
        })
      ],
      [],
      {},
      {
        graphSupportByMemoryId: { "weak-prior-heavy": 0 }
      }
    );
    // normalized_rank 0.5 → content_relevance ≈ 0.31, below floor 0.72.
    searchByKeyword.mockResolvedValue([
      { object_id: "weak-prior-heavy", normalized_rank: 0.5 }
    ]);
    const service = new RecallService(dependencies);

    const result = await service.recall({
      taskSurface: createTaskSurface("missing answer query"),
      workspaceId: "workspace-1",
      runId: "run-1",
      strategy: "build"
    });

    const weak = result.candidates.find(
      (candidate) => candidate.object_id === "weak-prior-heavy"
    );
    const factors = weak?.score_factors;

    // gate fired → weighted_relevance strictly less than the un-calibrated
    // upper bound (content_relevance * resolved relevance weight).
    const upperWeightedRelevance =
      (factors?.content_relevance ?? 0) *
      (factors?.resolved_activation_weights?.relevance ?? 0);
    expect(factors?.weighted_relevance ?? 0).toBeLessThan(upperWeightedRelevance);

    // gate fired → adjusted_base_weight strictly less than the un-calibrated
    // upper bound (base_weight - queryEvidenceTransfer).
    const upperAdjustedBaseWeight =
      (factors?.base_weight ?? 0) - (factors?.query_evidence_transfer ?? 0);
    expect(factors?.adjusted_base_weight ?? 0).toBeLessThan(upperAdjustedBaseWeight);
    expect(weak?.relevance_score ?? 1).toBeLessThan(FALSE_CONFIDENT_ACCEPTANCE_THRESHOLD);
  });

it("does not calibrate when neither prior nor evidence is present", async () => {
    const { dependencies, searchByKeyword } = createDependencies(
      [
        createMemoryEntry({
          object_id: "all-weak",
          content: "Dormant unrelated text",
          activation_score: 0,
          confidence: 0
        })
      ],
      [],
      {},
      {
        graphSupportByMemoryId: { "all-weak": 0 }
      }
    );
    // no FTS hit → content_relevance 0, graph_support 0, plasticity absent,
    // activation 0, confidence 0 → prior-side inner condition is false.
    searchByKeyword.mockResolvedValue([]);
    const service = new RecallService(dependencies);

    const result = await service.recall({
      taskSurface: createTaskSurface("missing answer query"),
      workspaceId: "workspace-1",
      runId: "run-1",
      strategy: "build"
    });

    const allWeak = result.candidates.find(
      (candidate) => candidate.object_id === "all-weak"
    );
    const factors = allWeak?.score_factors;
    expect(factors?.content_relevance ?? 0).toBe(0);

    // gate did not fire (no prior signal) → weighted_relevance equals the
    // un-calibrated product. Both sides are 0 here but the equality still
    // pins the "no reshape" semantics.
    const expectedWeightedRelevance =
      (factors?.content_relevance ?? 0) *
      (factors?.resolved_activation_weights?.relevance ?? 0);
    expect(factors?.weighted_relevance ?? 0).toBeCloseTo(expectedWeightedRelevance);

    // adjusted_base_weight equals base_weight - queryEvidenceTransfer, with
    // no priorEvidenceCalibration shrink.
    const expectedAdjustedBaseWeight = Math.max(
      0,
      (factors?.base_weight ?? 0) - (factors?.query_evidence_transfer ?? 0)
    );
    expect(factors?.adjusted_base_weight ?? 0).toBeCloseTo(expectedAdjustedBaseWeight);
  });

it.each([
    {
      caseName: "no graph, no path",
      graphSupport: 0,
      pathPlasticity: undefined,
      expectedRelevanceWeight: 0.3,
      expectedGraphWeight: 0,
      expectedGraphFactor: 0,
      expectedPathFactor: 0,
      effectivePathWeight: 0
    },
    {
      caseName: "only graph",
      graphSupport: 3,
      pathPlasticity: undefined,
      expectedRelevanceWeight: 0.1,
      expectedGraphWeight: 0.05,
      expectedGraphFactor: 1,
      expectedPathFactor: 0,
      effectivePathWeight: PATH_PLASTICITY_WEIGHT
    },
    {
      caseName: "only path",
      graphSupport: 0,
      pathPlasticity: 0.6,
      expectedRelevanceWeight: 0.1,
      expectedGraphWeight: 0.05,
      expectedGraphFactor: 0,
      expectedPathFactor: 0.6,
      effectivePathWeight: PATH_PLASTICITY_WEIGHT
    },
    {
      caseName: "both",
      graphSupport: 3,
      pathPlasticity: 0.6,
      expectedRelevanceWeight: 0.1,
      expectedGraphWeight: 0.05,
      expectedGraphFactor: 1,
      expectedPathFactor: 0.6,
      effectivePathWeight: PATH_PLASTICITY_WEIGHT
    }
  ])(
    "keeps score weight total stable with dynamic graph/path reallocation when $caseName",
    async ({
      graphSupport,
      pathPlasticity,
      expectedRelevanceWeight,
      expectedGraphWeight,
      expectedGraphFactor,
      expectedPathFactor,
      effectivePathWeight
    }) => {
      const { dependencies, searchByKeyword } = createDependencies(
        [
          createMemoryEntry({
            object_id: "memory-1",
            content: "Dynamic scoring evidence"
          })
        ],
        [],
        {},
        {
          graphSupportByMemoryId: { "memory-1": graphSupport },
          ...(pathPlasticity === undefined
            ? {}
            : { pathPlasticityByMemoryId: { "memory-1": pathPlasticity } })
        }
      );
      searchByKeyword.mockResolvedValue([{ object_id: "memory-1", normalized_rank: 1 }]);
      const service = new RecallService(dependencies);

      const result = await service.recall({
        taskSurface: createTaskSurface("Dynamic scoring evidence"),
        workspaceId: "workspace-1",
        runId: "run-1",
        strategy: "build"
      });

      const candidate = result.candidates[0];
      const weights = candidate?.score_factors?.resolved_activation_weights;
      expect(weights).toBeDefined();
      expect(weights?.relevance).toBeCloseTo(expectedRelevanceWeight);
      expect(weights?.graph_support).toBeCloseTo(expectedGraphWeight);
      expect(candidate?.score_factors?.graph_support).toBeCloseTo(expectedGraphFactor);
      expect(candidate?.score_factors?.path_plasticity).toBeCloseTo(expectedPathFactor);
      expectScoreWeightTotalConserved(weights as ActivationWeights, effectivePathWeight);
    }
  );

it("graduates cold-mode transfer by inbound RECALLS edge count and records audit telemetry", async () => {
    const { dependencies, searchByKeyword, append } = createDependencies(
      [
        createMemoryEntry({
          object_id: "memory-1",
          content: "Graduated cold score evidence"
        })
      ],
      [],
      {},
      {
        graphSupportByMemoryId: { "memory-1": 0 },
        recallsEdgeCountByMemoryId: { "memory-1": 25 }
      }
    );
    searchByKeyword.mockResolvedValue([{ object_id: "memory-1", normalized_rank: 1 }]);
    const service = new RecallService(dependencies);

    const result = await service.recall({
      taskSurface: createTaskSurface("Graduated cold score evidence"),
      workspaceId: "workspace-1",
      runId: "run-1",
      strategy: "build"
    });

    const factors = result.candidates[0]?.score_factors;
    const weights = factors?.resolved_activation_weights;
    expect(weights).toBeDefined();
    expect(weights?.relevance).toBeCloseTo(0.2);
    expect(weights?.graph_support).toBeCloseTo(0.025);
    expect(factors?.graph_path_cold_score).toBeCloseTo(0.5);
    expect(factors?.recalls_edge_count).toBe(25);
    expect(factors?.weight_transfer_amount).toBeCloseTo(0.1);
    expectScoreWeightTotalConserved(weights as ActivationWeights, 0.075);
    const transferEvent = append.mock.calls
      .map((call) => call[0])
      .find((entry) => entry.event_type === RecallContextEventType.SOUL_RECALL_WEIGHT_TRANSFER);
    expect(transferEvent).toMatchObject({
      entity_type: "recall_weight_transfer",
      workspace_id: "workspace-1",
      run_id: "run-1",
      payload_json: expect.objectContaining({
        cold_score: 0.5,
        recalls_edge_count: 25,
        recalls_threshold: 50
      })
    });
    expect(
      (transferEvent?.payload_json as { readonly transferred_amount?: number })?.transferred_amount
    ).toBeCloseTo(0.1);
  });

// invariant: cold graph/path transfer is candidate-set scoped. Mixed candidate
  // sets with any graph/path support keep baseline weights so candidates with
  // real graph evidence are not inflated by a cold-path transfer.
  it("keeps baseline weights when only some candidates have graph/path support (mixed)", async () => {
    const memories = [
      createMemoryEntry({
        object_id: "memory-cold",
        content: "Cold candidate - no graph, no path"
      }),
      createMemoryEntry({
        object_id: "memory-warm",
        content: "Warm candidate — has graph support"
      })
    ];
    const { dependencies, searchByKeyword } = createDependencies(
      memories,
      [],
      {},
      {
        graphSupportByMemoryId: { "memory-cold": 0, "memory-warm": 3 }
      }
    );
    searchByKeyword.mockResolvedValue([
      { object_id: "memory-cold", normalized_rank: 1 },
      { object_id: "memory-warm", normalized_rank: 1 }
    ]);
    const service = new RecallService(dependencies);

    const result = await service.recall({
      taskSurface: createTaskSurface("Mixed cold/warm scoring evidence"),
      workspaceId: "workspace-1",
      runId: "run-1",
      strategy: "build"
    });

    for (const candidate of result.candidates) {
      const weights = candidate.score_factors?.resolved_activation_weights;
      expect(weights).toBeDefined();
      // Baseline relevance + graph_support, NOT the cold-reallocation
      // relevance: 0.3 / graph_support: 0 shape.
      expect(weights?.relevance).toBeCloseTo(0.1);
      expect(weights?.graph_support).toBeCloseTo(0.05);
    }
  });

it("orders identical memories by confidence sub-weight", async () => {
    const memories = [
      createMemoryEntry({
        object_id: "memory-low-confidence",
        content: "shared identical content body",
        confidence: 0.2
      }),
      createMemoryEntry({
        object_id: "memory-high-confidence",
        content: "shared identical content body",
        confidence: 0.95
      })
    ];
    const { dependencies, searchByKeyword } = createDependencies(memories);
    searchByKeyword.mockResolvedValue([]);
    const service = new RecallService(dependencies);

    const result = await service.recall({
      taskSurface: createTaskSurface("shared identical content body"),
      workspaceId: "workspace-1",
      runId: "run-1",
      strategy: "build"
    });

    const high = result.candidates.find((candidate) => candidate.object_id === "memory-high-confidence");
    const low = result.candidates.find((candidate) => candidate.object_id === "memory-low-confidence");

    expect(high).toBeDefined();
    expect(low).toBeDefined();
    expect(high?.score_factors?.confidence).toBeCloseTo(0.95);
    expect(low?.score_factors?.confidence).toBeCloseTo(0.2);
    expect(high?.relevance_score ?? 0).toBeGreaterThan(low?.relevance_score ?? 0);
    expect(high?.relevance_score ?? -1).toBeLessThanOrEqual(1);
    expect(low?.relevance_score ?? 2).toBeGreaterThanOrEqual(0);
  });

it("applies conflict penalty to non-winner claim-like entries", async () => {
    const memories = [
      createMemoryEntry({
        object_id: "claim-1",
        dimension: MemoryDimension.PROCEDURE,
        activation_score: 0.65,
        content: "Loser"
      }),
      createMemoryEntry({
        // Distinct memory ID; the slot's winner_claim_id is a ClaimForm ID, not a memory ID.
        object_id: "winner-claim-1",
        dimension: MemoryDimension.PROCEDURE,
        activation_score: 0.65,
        content: "Winner"
      })
    ];
    // "claim-form-winner-1" is the ClaimForm object_id stored in the slot.
    // Its source_object_refs points to the backing memory "winner-claim-1".
    const claimSourceRefs = { "claim-form-winner-1": ["winner-claim-1"] };
    const { dependencies } = createDependencies(memories, [createSlot()], claimSourceRefs);
    const service = new RecallService(dependencies);

    const result = await service.recall({
      taskSurface: createTaskSurface("claim review"),
      workspaceId: "workspace-1",
      runId: "run-1",
      strategy: "analyze"
    });

    const winner = result.candidates.find((candidate) => candidate.object_id === "winner-claim-1");
    const loser = result.candidates.find((candidate) => candidate.object_id === "claim-1");

    expect(winner?.relevance_score).toBeGreaterThan(loser?.relevance_score ?? 0);
  });
});
