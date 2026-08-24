import { describe, expect, it } from "vitest";
import { createMemoryEntry } from "../recall-service-test-fixtures.js";
import { attributeOpenSemanticFactorActivations } from
  "../../../recall/field/open-semantic-factors/candidate-attribution.js";
import type { OpenSemanticFactorActivationReceipt } from
  "../../../recall/field/open-semantic-factors/activation.js";
import type { CoarseRecallCandidate } from
  "../../../recall/runtime/recall-service-types.js";
import { assertOpenSemanticCandidateActivations } from
  "../../../recall/delivery/selection-boundary/validation/open-semantic-candidate-activation-receipt.js";
import type { SerializedRecallSupplementaryData } from
  "../../../recall/delivery/selection-boundary/selection-boundary-types.js";

describe("open semantic factor candidate attribution", () => {
  it("maps complete solution evidence to linked and direct candidates", () => {
    const memory = candidate(createMemoryEntry({
      object_id: "memory-1",
      evidence_refs: ["evidence-b", "evidence-a"]
    }));
    const direct = candidate(createMemoryEntry({ object_id: "evidence-a" }), {
      objectKind: "evidence_capsule"
    });

    const activations = attributeOpenSemanticFactorActivations({
      candidates: [memory, direct],
      activation: composedActivation(false)
    });

    expect([...activations]).toEqual([
      ["workspace_local:memory_entry:memory-1", expect.objectContaining({
        score: 1,
        evidence_ids: ["evidence-a", "evidence-b"],
        solution_count: 3,
        proposition_match_count: 2
      })],
      ["workspace_local:evidence_capsule:evidence-a", expect.objectContaining({
        score: 1,
        evidence_ids: ["evidence-a"],
        solution_count: 2,
        proposition_match_count: 2
      })]
    ]);
  });

  it("deduplicates repeated stored evidence references before sealing a receipt", () => {
    const activations = attributeOpenSemanticFactorActivations({
      candidates: [candidate(createMemoryEntry({
        object_id: "memory-duplicate-refs",
        evidence_refs: ["evidence-b", "evidence-a", "evidence-b"]
      }))],
      activation: composedActivation(false)
    });
    const data = {
      openSemanticFactorCandidateActivationsByCandidateKey: [...activations]
    } as unknown as SerializedRecallSupplementaryData;

    expect([...activations.values()][0]?.evidence_ids).toEqual([
      "evidence-a",
      "evidence-b"
    ]);
    expect(() => assertOpenSemanticCandidateActivations(data)).not.toThrow();
  });

  it("keeps observed cover when mixed reconstructed partners share a candidate", () => {
    const activations = attributeOpenSemanticFactorActivations({
      candidates: [candidate(createMemoryEntry({
        object_id: "memory-mixed",
        evidence_refs: ["evidence-a", "evidence-b"]
      }))],
      activation: composedActivation(false, {
        evidence_id: "evidence-b",
        state: "reconstructed",
        activation: 0.5,
        solution_count: 1,
        proposition_match_count: 1
      })
    });

    expect([...activations.values()][0]).toEqual(expect.objectContaining({
      state: "observed",
      score: 1,
      evidence_ids: ["evidence-a", "evidence-b"]
    }));
  });

  it("attributes reconstructed-only members without observed cover", () => {
    const activations = attributeOpenSemanticFactorActivations({
      candidates: [candidate(createMemoryEntry({
        object_id: "memory-reconstructed",
        evidence_refs: ["evidence-b"]
      }))],
      activation: composedActivation(false, {
        evidence_id: "evidence-a",
        state: "reconstructed",
        activation: 0.4,
        solution_count: 1,
        proposition_match_count: 0
      }, {
        evidence_id: "evidence-b",
        state: "reconstructed",
        activation: 0.5,
        solution_count: 1,
        proposition_match_count: 1
      })
    });

    expect([...activations.values()][0]).toEqual(expect.objectContaining({
      state: "reconstructed",
      score: 0.5,
      evidence_ids: ["evidence-b"]
    }));
  });

  it("does not promote partial or non-composed searches", () => {
    const candidates = [candidate(createMemoryEntry({
      object_id: "memory-1",
      evidence_refs: ["evidence-a"]
    }))];
    expect(attributeOpenSemanticFactorActivations({
      candidates,
      activation: composedActivation(true)
    })).toEqual(new Map());
    expect(attributeOpenSemanticFactorActivations({
      candidates,
      activation: { ...composedActivation(false), status: "no_match" }
    })).toEqual(new Map());
  });

  it("seals attributed activation receipts into selection-boundary state", () => {
    const activations = attributeOpenSemanticFactorActivations({
      candidates: [candidate(createMemoryEntry({
        object_id: "memory-1",
        evidence_refs: ["evidence-a"]
      }))],
      activation: composedActivation(false)
    });
    const data = {
      openSemanticFactorCandidateActivationsByCandidateKey: [...activations]
    } as unknown as SerializedRecallSupplementaryData;

    expect(() => assertOpenSemanticCandidateActivations(data)).not.toThrow();
    expect(() => assertOpenSemanticCandidateActivations({
      ...data,
      openSemanticFactorCandidateActivationsByCandidateKey: [[
        "workspace_local:memory_entry:memory-1",
        { ...activations.values().next().value!, receipt_digest: "sha256:forged" as const }
      ]]
    } as unknown as SerializedRecallSupplementaryData)).toThrow(/selection boundary fidelity mismatch/u);
  });

  it("rejects an unknown activation state at the selection boundary", () => {
    const activations = attributeOpenSemanticFactorActivations({
      candidates: [candidate(createMemoryEntry({
        object_id: "memory-1",
        evidence_refs: ["evidence-a"]
      }))],
      activation: composedActivation(false)
    });
    const receipt = activations.values().next().value;
    expect(() => assertOpenSemanticCandidateActivations({
      openSemanticFactorCandidateActivationsByCandidateKey: [[
        "workspace_local:memory_entry:memory-1",
        { ...receipt, state: "inferred" }
      ]]
    } as unknown as SerializedRecallSupplementaryData)).toThrow(
      /selection boundary fidelity mismatch/u
    );
  });
});

function composedActivation(
  truncated: boolean,
  ...entryOverrides: OpenSemanticFactorActivationReceipt["entries"]
): OpenSemanticFactorActivationReceipt {
  const defaults: OpenSemanticFactorActivationReceipt["entries"] = [
    {
      evidence_id: "evidence-a",
      state: "observed",
      activation: 1,
      solution_count: 2,
      proposition_match_count: 2
    },
    {
      evidence_id: "evidence-b",
      state: "observed",
      activation: 1,
      solution_count: 3,
      proposition_match_count: 1
    }
  ];
  const overrides = new Map(entryOverrides.map((entry) => [entry.evidence_id, entry]));
  const entries = defaults.map((entry) => overrides.get(entry.evidence_id) ?? entry);
  return {
    schema_version: 2,
    operator_id: "open_semantic_solution_membership_activation_v2",
    status: "composed",
    composition_receipt_digest: "sha256:composition",
    entry_count: entries.length,
    truncated,
    entries,
    missing_evidence_policy: "no_op",
    ranking_effect: "candidate_attribution",
    receipt_digest: "sha256:activation"
  };
}

function candidate(
  entry: CoarseRecallCandidate["entry"],
  overrides: Partial<CoarseRecallCandidate> = {}
): CoarseRecallCandidate {
  return Object.freeze({ entry, originPlane: "workspace_local", ...overrides });
}
