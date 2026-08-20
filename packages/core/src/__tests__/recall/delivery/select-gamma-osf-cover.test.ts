import { describe, expect, it } from "vitest";
import { buildFineAssessmentSelectGammaBinding } from
  "../../../recall/delivery/select-gamma/bind-fine-assessment.js";
import { createSelectionContext } from
  "../../../recall/delivery/fine-assessment-selection/coverage-order.js";
import {
  OPEN_SEMANTIC_FACTOR_CANDIDATE_ACTIVATION_OPERATOR_ID
} from "../../../recall/field/open-semantic-factors/candidate-attribution.js";
import type { IntegratedFloodCandidateDiagnostics } from
  "../../../recall/runtime/recall-service-types.js";
import {
  createCandidate,
  createConfig,
  createSupplementaryData
} from "../fine-assessment-selection-fixtures.js";

describe("Select_Gamma open-semantic cover", () => {
  it("withholds f3 cover from reconstructed-only activation while keeping score fuel", () => {
    const bound = bindCoveredCandidate(osfActivation("reconstructed"));
    expect(Object.keys(bound.cover).sort()).toEqual(["slice"]);
    expect(bound.cover).not.toHaveProperty("f3");
  });

  it("keeps f3 cover when any attributed evidence is observed", () => {
    const bound = bindCoveredCandidate(osfActivation("observed"));
    expect(Object.keys(bound.cover).sort()).toEqual(["f3", "slice"]);
  });
});

function bindCoveredCandidate(
  activation: ReturnType<typeof osfActivation>
) {
  const candidate = withSlice(createCandidate("attributed"));
  const params = {
    workspace_id: candidate.entry.workspace_id,
    orderedCandidates: [candidate],
    generation_id: `sha256:${"c".repeat(64)}`,
    condition_digest: `sha256:${"d".repeat(64)}`,
    config: createConfig(),
    supplementaryData: createSupplementaryData({
      openSemanticFactorCandidateActivationsByCandidateKey: new Map([
        [candidate.fusion.candidate_key, activation]
      ])
    }),
    tokenEstimator: { estimate: () => 6 },
    rankByCandidateKey: new Map([[candidate.fusion.candidate_key, 1]])
  };
  return buildFineAssessmentSelectGammaBinding(
    params,
    createSelectionContext(params)
  ).candidates[0]!;
}

function osfActivation(state: "observed" | "reconstructed") {
  return {
    schema_version: 1 as const,
    operator_id: OPEN_SEMANTIC_FACTOR_CANDIDATE_ACTIVATION_OPERATOR_ID,
    state,
    score: 0.7,
    evidence_ids: Object.freeze(["evidence-1"]),
    solution_count: 1,
    proposition_match_count: 1,
    receipt_digest: `sha256:${"e".repeat(64)}` as const
  };
}

function withSlice(candidate: ReturnType<typeof createCandidate>) {
  const flood: IntegratedFloodCandidateDiagnostics = {
    R_obj: 0,
    Slice: 1,
    A_path: 0,
    B_evidence: 0,
    E_direct: 0,
    omega: 1,
    Flood: 0,
    lambda: 0.6,
    beta: 1,
    final_score: 0,
    slice_status: "active",
    path_status: "inactive:pass_through",
    evidence_status: "inactive:no_evidence",
    e_direct_status: "inactive:not_applicable",
    fuel_verified: true
  };
  return {
    ...candidate,
    fusion: {
      ...candidate.fusion,
      flood_potential: flood
    }
  };
}
