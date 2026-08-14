import { describe, expect, it } from "vitest";
import {
  computeIntegratedFloodScore,
  structuralLikelihoodGate
} from "../../recall/scoring/integrated-flood-scoring.js";
import { resolveConformantPathWeight } from "../../recall/scoring/conformant-fusion-scoring.js";
import { createMemoryEntry, entityQueryKey, supplementary } from "./integrated-flood-scoring.test-support.js";

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

  it("absent query fiber stays identity and still allows fuel_verified when path+evidence fuel present", () => {
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
    expect(result.diagnostics.slice_status).toBe("inactive:no_slice");
    expect(result.diagnostics.Slice).toBe(1);
    expect(result.diagnostics.fuel_verified).toBe(true);
    expect(result.score).toBeGreaterThan(0.2);
  });

  it("activates the slice axis on a matching entity fiber", () => {
    const seed = createMemoryEntry({ object_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    const targetId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const target = createMemoryEntry({
      object_id: targetId,
      canonical_entities: ["Ada Lovelace"],
      evidence_refs: ["ev-fiber"]
    });
    const result = computeIntegratedFloodScore({
      entry: target,
      axisInputs: { R_obj: 0.2, A_path: 0.5, B_evidence: 0.7 },
      supplementaryData: supplementary({
        queryRoutingKeys: [entityQueryKey(target.workspace_id, "Ada Lovelace")],
        pathInflowByTarget: {
          [targetId]: [{ seedObjectId: seed.object_id, weight: 1 }]
        },
        evidenceSupportVectorsByMemoryId: {
          [targetId]: [{ source_kind: "evidence_ref", source_id: "ev-fiber", support: 0.7 }]
        }
      })
    });
    expect(result.diagnostics.slice_status).toBe("active");
    expect(result.diagnostics.Slice).toBe(1);
    expect(result.diagnostics.fuel_verified).toBe(true);
    expect(result.score).toBeGreaterThan(0.2);
  });

  it("withholds flood fuel when the candidate is off the query fiber", () => {
    const seed = createMemoryEntry({ object_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    const targetId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const target = createMemoryEntry({
      object_id: targetId,
      canonical_entities: ["Charles Babbage"],
      evidence_refs: ["ev-fiber"]
    });
    const result = computeIntegratedFloodScore({
      entry: target,
      axisInputs: { R_obj: 0.2, A_path: 0.5, B_evidence: 0.7 },
      supplementaryData: supplementary({
        queryRoutingKeys: [entityQueryKey(target.workspace_id, "Ada Lovelace")],
        pathInflowByTarget: {
          [targetId]: [{ seedObjectId: seed.object_id, weight: 1 }]
        },
        evidenceSupportVectorsByMemoryId: {
          [targetId]: [{ source_kind: "evidence_ref", source_id: "ev-fiber", support: 0.7 }]
        }
      })
    });
    expect(result.diagnostics.slice_status).toBe("inactive:no_slice_match");
    expect(result.diagnostics.Slice).toBe(0);
    expect(result.diagnostics.fuel_verified).toBe(false);
    expect(result.score).toBeCloseTo(
      0.2 + 0.7 * structuralLikelihoodGate(0.2),
      12
    );
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
    const lGate = structuralLikelihoodGate(0.1);
    expect(warmResult.score).toBeCloseTo(
      0.1 +
        0.6 * lGate +
        resolveConformantPathWeight() *
          warmResult.diagnostics.omega *
          warmResult.diagnostics.Flood *
          lGate,
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
    expect(result.diagnostics.e_direct_status).toBe("inactive:no_evidence");
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
    expect(result.score).toBeCloseTo(
      0.25 + 0.8 * structuralLikelihoodGate(0.25),
      12
    );
  });

  it("does not treat an unavailable path index as pass-through identity", () => {
    const entry = createMemoryEntry({ object_id: "77777777-7777-4777-8777-777777777777" });
    const result = computeIntegratedFloodScore({
      entry,
      axisInputs: { R_obj: 0.4, A_path: 0, B_evidence: 0 },
      supplementaryData: supplementary({
        pathInflowAvailability: "unavailable"
      })
    });
    expect(result.diagnostics.path_status).toBe("inactive:index_unavailable");
    expect(result.diagnostics.A_path).not.toBe(1);
    expect(result.diagnostics.fuel_verified).toBe(false);
    expect(result.score).toBeCloseTo(0.4, 12);
  });

  it("does not treat a path-index storage fault as pass-through identity", () => {
    const entry = createMemoryEntry({ object_id: "88888888-8888-4888-8888-888888888888" });
    const result = computeIntegratedFloodScore({
      entry,
      axisInputs: { R_obj: 0.4, A_path: 0, B_evidence: 0 },
      supplementaryData: supplementary({
        pathInflowAvailability: "storage_error"
      })
    });
    expect(result.diagnostics.path_status).toBe("inactive:storage_error");
    expect(result.diagnostics.A_path).not.toBe(1);
    expect(result.diagnostics.fuel_verified).toBe(false);
    expect(result.score).toBeCloseTo(0.4, 12);
  });

  it("does not count ineligible capsules as path-graph pass-through", () => {
    const entry = createMemoryEntry({ object_id: "99999999-9999-4999-8999-999999999999" });
    const result = computeIntegratedFloodScore({
      entry,
      memorySupplementEligible: false,
      axisInputs: { R_obj: 0.4, A_path: 0, B_evidence: 0 },
      supplementaryData: supplementary({
        pathInflowAvailability: "unavailable"
      })
    });
    expect(result.diagnostics.path_status).toBe("inactive:not_applicable");
    expect(result.diagnostics.A_path).toBe(1);
    expect(result.diagnostics.fuel_verified).toBe(false);
    expect(result.score).toBeCloseTo(0.4, 12);
  });
});
