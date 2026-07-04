import { afterEach, describe, expect, it } from "vitest";
import type { MemoryEntry } from "@do-soul/alaya-protocol";
import { compileRecallQueryProbes } from "../../recall/query/recall-query-probes.js";
import {
  buildFloodFuelCoverageSummary,
  computeIntegratedFloodScore
} from "../../recall/scoring/integrated-flood-scoring.js";
import { resolveConformantPathWeight } from "../../recall/scoring/conformant-fusion-scoring.js";
import type { RecallSupplementaryData } from "../../recall/runtime/recall-service-types.js";
import { createMemoryEntry } from "./recall-service-test-fixtures.js";

const CONF_ENV = [
  "ALAYA_RECALL_CONF_W_PATH",
  "ALAYA_RECALL_CONF_EVIDENCE_BETA",
  "ALAYA_RECALL_FACET_SLICE"
] as const;

afterEach(() => {
  for (const name of CONF_ENV) {
    delete process.env[name];
  }
});

function supplementary(overrides: Partial<RecallSupplementaryData> = {}): RecallSupplementaryData {
  return {
    queryProbes: compileRecallQueryProbes("how does staging rotate credentials"),
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
    governanceCeilingByMemoryId: {},
    ...overrides
  };
}

describe("computeIntegratedFloodScore", () => {
  it("cold-start output equals R_obj when no verified fuel", () => {
    const entry = createMemoryEntry({ object_id: "11111111-1111-4111-8111-111111111111" });
    const result = computeIntegratedFloodScore({
      entry,
      axisInputs: { R_obj: 0.42, A_path: 0, B_evidence: 0 },
      supplementaryData: supplementary()
    });
    expect(result.score).toBeCloseTo(0.42, 12);
    expect(result.diagnostics.final_score).toBeCloseTo(0.42, 12);
    expect(result.diagnostics.fuel_verified).toBe(false);
    expect(result.diagnostics.Flood).toBe(0);
    expect(result.diagnostics.path_status).toBe("inactive:pass_through");
    expect(result.diagnostics.evidence_status).toBe("inactive:pass_through");
  });

  it("path fuel changes only eligible candidates with verified inflow", () => {
    const cold = createMemoryEntry({ object_id: "11111111-1111-4111-8111-111111111111" });
    const targetId = "22222222-2222-4222-8222-222222222222";
    const target = createMemoryEntry({ object_id: targetId });
    const data = supplementary({
      pathInflowByTarget: {
        [targetId]: [{ seedObjectId: cold.object_id, weight: 1 }]
      }
    });
    const coldResult = computeIntegratedFloodScore({
      entry: cold,
      axisInputs: { R_obj: 0.5, A_path: 0, B_evidence: 0 },
      supplementaryData: data
    });
    const warmResult = computeIntegratedFloodScore({
      entry: target,
      axisInputs: { R_obj: 0.1, A_path: 0.4, B_evidence: 0 },
      supplementaryData: data
    });
    expect(coldResult.diagnostics.fuel_verified).toBe(false);
    expect(coldResult.score).toBeCloseTo(0.5, 12);
    expect(warmResult.diagnostics.fuel_verified).toBe(true);
    expect(warmResult.score).toBeCloseTo(
      warmResult.diagnostics.omega * (0.1 + resolveConformantPathWeight() * warmResult.diagnostics.Flood),
      9
    );
    expect(warmResult.score).toBeGreaterThan(0.1);
  });

  it("diagnostic names match the integrated flood contract", () => {
    const entry = createMemoryEntry({
      object_id: "33333333-3333-4333-8333-333333333333",
      evidence_refs: ["ev-a"]
    });
    const result = computeIntegratedFloodScore({
      entry,
      axisInputs: { R_obj: 0.2, A_path: 0, B_evidence: 0.5 },
      supplementaryData: supplementary({
        evidenceSupportVectorsByMemoryId: {
          [entry.object_id]: [{ source_kind: "evidence_ref", source_id: "ev-a", support: 0.5 }]
        }
      })
    });
    expect(result.diagnostics).toEqual(
      expect.objectContaining({
        R_obj: 0.2,
        Slice: expect.any(Number),
        A_path: expect.any(Number),
        B_evidence: expect.any(Number),
        E_direct: 0.5,
        omega: expect.any(Number),
        Flood: expect.any(Number),
        lambda: resolveConformantPathWeight(),
        beta: 0,
        final_score: expect.any(Number),
        e_direct_status: "inactive:beta_disabled"
      })
    );
  });

  it("summarizes fuel coverage across candidates", () => {
    const summary = buildFloodFuelCoverageSummary([
      {
        R_obj: 1,
        Slice: 1,
        A_path: 1,
        B_evidence: 1,
        E_direct: 0,
        omega: 1,
        Flood: 0.5,
        lambda: 0.6,
        beta: 0,
        final_score: 1.3,
        slice_status: "active",
        path_status: "active",
        evidence_status: "active",
        e_direct_status: "inactive:beta_disabled",
        fuel_verified: true
      },
      {
        R_obj: 0.5,
        Slice: 1,
        A_path: 1,
        B_evidence: 1,
        E_direct: 0,
        omega: 1,
        Flood: 0,
        lambda: 0.6,
        beta: 0,
        final_score: 0.5,
        slice_status: "inactive:pass_through",
        path_status: "inactive:pass_through",
        evidence_status: "inactive:pass_through",
        e_direct_status: "inactive:beta_disabled",
        fuel_verified: false
      }
    ]);
    expect(summary).toEqual({
      candidates_total: 2,
      cold_start_count: 1,
      fuel_verified_count: 1,
      slice_active_count: 1,
      path_active_count: 1,
      evidence_active_count: 1
    });
  });
});
