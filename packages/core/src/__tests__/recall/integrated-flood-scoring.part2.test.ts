import { afterEach, describe, expect, it } from "vitest";
import {
  buildFloodFuelCoverageSummary,
  computeIntegratedFloodScore,
  structuralLikelihoodGate
} from "../../recall/scoring/integrated-flood-scoring.js";
import { resolveConformantPathWeight } from "../../recall/scoring/conformant-fusion-scoring.js";
import { createMemoryEntry, supplementary } from "./integrated-flood-scoring.test-support.js";

const CONF_ENV = [
  "ALAYA_RECALL_CONF_W_PATH"
] as const;

afterEach(() => {
  for (const name of CONF_ENV) {
    delete process.env[name];
  }
});

describe("computeIntegratedFloodScore", () => {
  it("adds evidence as an additive residual even when flood fuel is closed", () => {
    const entry = createMemoryEntry({
      object_id: "33333333-3333-4333-8333-333333333333",
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
    const lGate = structuralLikelihoodGate(0.25);
    expect(result.diagnostics.fuel_verified).toBe(false);
    expect(result.diagnostics.e_direct_status).toBe("active");
    expect(result.diagnostics.E_direct).toBeCloseTo(0.8, 12);
    expect(result.diagnostics.beta).toBe(1);
    expect(result.score).toBeCloseTo(0.25 + 0.8 * lGate, 12);
    expect(result.score).toBeGreaterThan(0.25);
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
        beta: 1,
        final_score: expect.any(Number),
        e_direct_status: "active"
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
    expect(beta).toBe(1);
    expect(result.score).toBeGreaterThanOrEqual(rObj);
    const lGate = structuralLikelihoodGate(rObj);
    expect(result.score).toBeCloseTo(
      rObj + 0.8 * lGate + lambda * omega * Flood * lGate,
      12
    );
  });

  it("applies L-gate: high R_obj shrinks flood bonus toward zero", () => {
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
    expect(high.score).toBe(1);
    expect(highBonus).toBeCloseTo(0.1, 12);
  });

  it("clamps an active non-default flood score and diagnostics to one", () => {
    process.env.ALAYA_RECALL_CONF_W_PATH = "2";
    const seed = createMemoryEntry({ object_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" });
    const targetId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const target = createMemoryEntry({ object_id: targetId, evidence_refs: ["ev-safe"] });
    const data = supplementary({
      pathInflowByTarget: { [targetId]: [{ seedObjectId: seed.object_id, weight: 1 }] },
      evidenceSupportVectorsByMemoryId: {
        [targetId]: [{ source_kind: "evidence_ref", source_id: "ev-safe", support: 1 }]
      }
    });
    const result = computeIntegratedFloodScore({
      entry: target,
      axisInputs: { R_obj: 0.2, A_path: 1, B_evidence: 1 },
      supplementaryData: data
    });

    expect(result.diagnostics.lambda).toBe(1);
    expect(result.diagnostics.beta).toBe(1);
    expect(result.diagnostics.path_status).toBe("active");
    expect(result.diagnostics.evidence_status).toBe("active");
    expect(result.diagnostics.fuel_verified).toBe(true);
    expect(result.diagnostics.Flood).toBe(1);
    expect(result.score).toBe(1);
    expect(result.diagnostics.final_score).toBe(1);
  });

  it("fails non-finite path fuel closed without changing the base score", () => {
    process.env.ALAYA_RECALL_CONF_W_PATH = "2";
    const seed = createMemoryEntry({ object_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" });
    const targetId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const target = createMemoryEntry({ object_id: targetId, evidence_refs: ["ev-safe"] });
    const result = computeIntegratedFloodScore({
      entry: target,
      axisInputs: { R_obj: 0.2, A_path: Number.POSITIVE_INFINITY, B_evidence: 0 },
      supplementaryData: supplementary({
        pathInflowByTarget: { [targetId]: [{ seedObjectId: seed.object_id, weight: 1 }] },
        evidenceSupportVectorsByMemoryId: {
          [targetId]: [{ source_kind: "evidence_ref", source_id: "ev-safe", support: 1 }]
        }
      })
    });

    expect(result.diagnostics.path_status).toBe("inactive:no_fuel");
    expect(result.diagnostics.fuel_verified).toBe(false);
    expect(result.score).toBe(0.2);
    expect(result.diagnostics.final_score).toBe(0.2);
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
        beta: 1,
        final_score: 1.3,
        slice_status: "active",
        path_status: "active",
        evidence_status: "active",
        e_direct_status: "inactive:no_evidence",
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
        beta: 1,
        final_score: 0.5,
        slice_status: "inactive:pass_through",
        path_status: "inactive:pass_through",
        evidence_status: "inactive:pass_through",
        e_direct_status: "inactive:no_evidence",
        fuel_verified: false
      }
    ]);
    expect(summary).toEqual({
      candidates_total: 2,
      cold_start_count: 1,
      fuel_verified_count: 1,
      slice_active_count: 1,
      path_active_count: 1,
      evidence_active_count: 1,
      h1_candidate_count: 0,
      h1_transferable_count: 0,
      h1_edge_winner_count: 0,
      h1_direct_winner_count: 0,
      h1_overlay_applied_count: 0,
      h1_evaluated_edge_count: 0,
      h1_seed_overlap_edge_count: 0,
      h1_transferred_edge_count: 0,
      h1_rejected_edge_count: 0,
      h1_newly_admitted_frontier_target_count: 0,
      h1_reason_counts: {
        transferred: 0,
        capped: 0,
        self_loop: 0,
        missing_edge_provenance: 0,
        missing_or_zero_input: 0,
        non_positive_conductance: 0,
        no_slice_match: 0
      }
    });
  });
});
