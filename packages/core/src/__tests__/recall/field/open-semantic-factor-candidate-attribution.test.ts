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
    } as SerializedRecallSupplementaryData;

    expect(() => assertOpenSemanticCandidateActivations(data)).not.toThrow();
    expect(() => assertOpenSemanticCandidateActivations({
      ...data,
      openSemanticFactorCandidateActivationsByCandidateKey: [[
        "workspace_local:memory_entry:memory-1",
        { ...activations.values().next().value, receipt_digest: "sha256:forged" }
      ]]
    })).toThrow(/selection boundary fidelity mismatch/u);
  });
});

function composedActivation(truncated: boolean): OpenSemanticFactorActivationReceipt {
  return {
    schema_version: 1,
    operator_id: "open_semantic_solution_membership_activation_v1",
    status: "composed",
    composition_receipt_digest: "sha256:composition",
    entry_count: 2,
    truncated,
    entries: [
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
    ],
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
