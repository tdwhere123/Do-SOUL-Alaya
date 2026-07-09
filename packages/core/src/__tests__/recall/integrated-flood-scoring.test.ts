import { afterEach, describe, expect, it } from "vitest";
import { compileRecallQueryProbes } from "../../recall/query/recall-query-probes.js";
import {
  buildFloodFuelCoverageSummary,
  computeIntegratedFloodScore,
  structuralLikelihoodGate
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

  it("default FACET_SLICE off still allows fuel_verified when path+evidence fuel present", () => {
    delete process.env.ALAYA_RECALL_FACET_SLICE;
    const seed = createMemoryEntry({ object_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    const targetId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const target = createMemoryEntry({ object_id: targetId, evidence_refs: ["ev-slice"] });
    const result = computeIntegratedFloodScore({
      entry: target,
      axisInputs: { R_obj: 0.2, A_path: 0.5, B_evidence: 0.7 },
      supplementaryData: supplementary({
        pathInflowByTarget: {
          [targetId]: [{ seedObjectId: seed.object_id, weight: 1 }]
        },
        evidenceSupportVectorsByMemoryId: {
          [targetId]: [{ source_kind: "evidence_ref", source_id: "ev-slice", support: 0.7 }]
        }
      })
    });
    expect(result.diagnostics.slice_status).toBe("inactive:pass_through");
    expect(result.diagnostics.Slice).toBe(1);
    expect(result.diagnostics.fuel_verified).toBe(true);
    expect(result.score).toBeGreaterThan(0.2);
  });

  it("FACET_SLICE on with zero facet overlap withholds fuel_verified", () => {
    process.env.ALAYA_RECALL_FACET_SLICE = "1";
    const seed = createMemoryEntry({ object_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" });
    const targetId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const target = createMemoryEntry({
      object_id: targetId,
      evidence_refs: ["ev-slice-miss"],
      facet_tags: []
    });
    const result = computeIntegratedFloodScore({
      entry: target,
      axisInputs: { R_obj: 0.2, A_path: 0.5, B_evidence: 0.7 },
      supplementaryData: supplementary({
        querySoughtFacets: ["location_place"],
        pathInflowByTarget: {
          [targetId]: [{ seedObjectId: seed.object_id, weight: 1 }]
        },
        evidenceSupportVectorsByMemoryId: {
          [targetId]: [{ source_kind: "evidence_ref", source_id: "ev-slice-miss", support: 0.7 }]
        }
      })
    });
    expect(result.diagnostics.slice_status).toBe("inactive:no_fuel");
    expect(result.diagnostics.Slice).toBe(0);
    expect(result.diagnostics.path_status).toBe("active");
    expect(result.diagnostics.evidence_status).toBe("active");
    expect(result.diagnostics.fuel_verified).toBe(false);
    expect(result.score).toBeCloseTo(0.2, 12);
  });

  it("path fuel changes only eligible candidates with verified path and evidence inflow", () => {
    const cold = createMemoryEntry({ object_id: "11111111-1111-4111-8111-111111111111" });
    const targetId = "22222222-2222-4222-8222-222222222222";
    const target = createMemoryEntry({ object_id: targetId, evidence_refs: ["ev-a"] });
    const data = supplementary({
      pathInflowByTarget: {
        [targetId]: [{ seedObjectId: cold.object_id, weight: 1 }]
      },
      evidenceSupportVectorsByMemoryId: {
        [targetId]: [{ source_kind: "evidence_ref", source_id: "ev-a", support: 0.6 }]
      }
    });
    const coldResult = computeIntegratedFloodScore({
      entry: cold,
      axisInputs: { R_obj: 0.5, A_path: 0, B_evidence: 0 },
      supplementaryData: data
    });
    const warmResult = computeIntegratedFloodScore({
      entry: target,
      axisInputs: { R_obj: 0.1, A_path: 0.4, B_evidence: 0.6 },
      supplementaryData: data
    });
    expect(coldResult.diagnostics.fuel_verified).toBe(false);
    expect(coldResult.score).toBeCloseTo(0.5, 12);
    expect(warmResult.diagnostics.fuel_verified).toBe(true);
    expect(warmResult.score).toBeCloseTo(
      0.1 +
        resolveConformantPathWeight() *
          warmResult.diagnostics.omega *
          warmResult.diagnostics.Flood *
          structuralLikelihoodGate(0.1),
      9
    );
    expect(warmResult.score).toBeGreaterThan(0.1);
  });

  it("does not let path inflow act as flood fuel without evidence support", () => {
    const seed = createMemoryEntry({ object_id: "55555555-5555-4555-8555-555555555555" });
    const target = createMemoryEntry({ object_id: "66666666-6666-4666-8666-666666666666" });
    const result = computeIntegratedFloodScore({
      entry: target,
      axisInputs: { R_obj: 0.3, A_path: 0.7, B_evidence: 0 },
      supplementaryData: supplementary({
        pathInflowByTarget: {
          [target.object_id]: [{ seedObjectId: seed.object_id, weight: 1 }]
        }
      })
    });

    expect(result.diagnostics.path_status).toBe("active");
    expect(result.diagnostics.evidence_status).toBe("inactive:pass_through");
    expect(result.diagnostics.fuel_verified).toBe(false);
    expect(result.score).toBeCloseTo(0.3, 12);
  });

  it("does not let evidence support act as flood fuel without path potential", () => {
    const entry = createMemoryEntry({
      object_id: "44444444-4444-4444-8444-444444444444",
      evidence_refs: ["ev-a"]
    });
    const result = computeIntegratedFloodScore({
      entry,
      axisInputs: { R_obj: 0.25, A_path: 0, B_evidence: 0.8 },
      supplementaryData: supplementary({
        evidenceSupportVectorsByMemoryId: {
          [entry.object_id]: [{ source_kind: "evidence_ref", source_id: "ev-a", support: 0.8 }]
        }
      })
    });
    expect(result.diagnostics.evidence_status).toBe("active");
    expect(result.diagnostics.path_status).toBe("inactive:pass_through");
    expect(result.diagnostics.fuel_verified).toBe(false);
    expect(result.score).toBeCloseTo(0.25, 12);
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

  it("keeps fuel activation monotone: omega scales the flood bonus, never base R_obj", () => {
    const seed = createMemoryEntry({ object_id: "77777777-7777-4777-8777-777777777777" });
    const targetId = "88888888-8888-4888-8888-888888888888";
    const target = createMemoryEntry({
      object_id: targetId,
      evidence_refs: ["ev-excerpt"],
      manifestation_state: "excerpt"
    });
    const data = supplementary({
      pathInflowByTarget: {
        [targetId]: [{ seedObjectId: seed.object_id, weight: 1 }]
      },
      evidenceSupportVectorsByMemoryId: {
        [targetId]: [{ source_kind: "evidence_ref", source_id: "ev-excerpt", support: 0.8 }]
      }
    });
    const rObj = 0.42;
    const result = computeIntegratedFloodScore({
      entry: target,
      axisInputs: { R_obj: rObj, A_path: 0.5, B_evidence: 0.8 },
      supplementaryData: data
    });
    const { omega, Flood, lambda, beta } = result.diagnostics;
    expect(result.diagnostics.fuel_verified).toBe(true);
    expect(omega).toBeLessThan(1);
    expect(beta).toBe(0);
    expect(result.score).toBeGreaterThanOrEqual(rObj);
    const lGate = structuralLikelihoodGate(rObj);
    expect(result.score).toBeCloseTo(rObj + lambda * omega * Flood * lGate, 12);
  });

  it("applies Card D L-gate: high R_obj shrinks flood bonus toward zero", () => {
    const seed = createMemoryEntry({ object_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    const targetId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const target = createMemoryEntry({
      object_id: targetId,
      evidence_refs: ["ev-l"],
      manifestation_state: "full_eligible"
    });
    const data = supplementary({
      pathInflowByTarget: {
        [targetId]: [{ seedObjectId: seed.object_id, weight: 1 }]
      },
      evidenceSupportVectorsByMemoryId: {
        [targetId]: [{ source_kind: "evidence_ref", source_id: "ev-l", support: 1 }]
      }
    });
    const low = computeIntegratedFloodScore({
      entry: target,
      axisInputs: { R_obj: 0.2, A_path: 1, B_evidence: 1 },
      supplementaryData: data
    });
    const high = computeIntegratedFloodScore({
      entry: target,
      axisInputs: { R_obj: 0.9, A_path: 1, B_evidence: 1 },
      supplementaryData: data
    });
    expect(low.diagnostics.fuel_verified).toBe(true);
    expect(high.diagnostics.fuel_verified).toBe(true);
    const lowBonus = low.score - 0.2;
    const highBonus = high.score - 0.9;
    expect(lowBonus).toBeGreaterThan(highBonus);
    expect(structuralLikelihoodGate(0.9)).toBeCloseTo(0.1, 12);
    expect(highBonus).toBeCloseTo(
      resolveConformantPathWeight() * high.diagnostics.Flood * 0.1,
      12
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
