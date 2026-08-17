import { describe, expect, it } from "vitest";
import { FIELD_PINS } from "../fine-assessment-selection-fixtures.js";
import { selectFineAssessmentCandidates } from
  "../../../recall/delivery/fine-assessment-selection.js";
import {
  materializeFineAssessmentSelectionBoundary
} from "../../../recall/delivery/selection-boundary/selection-boundary-capture.js";
import {
  replayFineAssessmentSelectionBoundary,
  type FineAssessmentSelectionBoundaryCase
} from "../../../recall/delivery/selection-boundary/selection-boundary-replay.js";
import {
  createConfig,
  createRankedCandidate,
  createSupplementaryData,
  rankMap
} from "../fine-assessment-selection-fixtures.js";

describe("Select_Gamma boundary objective", () => {
  it("records Select_Gamma as the complete live objective", () => {
    const { boundary } = captureBoundary();

    expect(boundary.schema_version).toBe(2);
    expect(boundary.expected.coverage_objective).toEqual({
      schema_version: 1,
      operator_id: "select_gamma_v1",
      mathematical_class: "monotone_submodular",
      configuration_digest: null
    });
    expect(boundary.expected.visible_result_sha256)
      .toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(boundary.expected).not.toHaveProperty("visible_result");
  });

  it("carries Gamma authority exclusions into boundary diagnostics", () => {
    const hidden = createRankedCandidate("hidden", 1, 1);
    let boundary: FineAssessmentSelectionBoundaryCase | undefined;
    const result = selectFineAssessmentCandidates({
      ...FIELD_PINS,
      orderedCandidates: [hidden],
      config: createConfig(),
      supplementaryData: createSupplementaryData({
        governanceCeilingByMemoryId: { hidden: "hidden" }
      }),
      tokenEstimator: { estimate: () => 5 },
      rankByCandidateKey: rankMap([hidden]),
      captureAnswerFeatures: true,
      selectionBoundaryObserver: (pending) => {
        boundary = materializeFineAssessmentSelectionBoundary(pending);
        return undefined;
      }
    });
    if (boundary === undefined) throw new Error("selection boundary was not observed");

    expect(result.candidates).toEqual([]);
    expect(result.diagnostics[0]?.dropped_reason).toBe("ineligible");
    expect(boundary.expected.pre_projection?.admission_actions[0]).toMatchObject({
      dropped_reason: "ineligible",
      witness: { kind: "ineligible", risk: "clear", authority: "blocked" }
    });
    expect(() => replayFineAssessmentSelectionBoundary(boundary)).not.toThrow();
  });

  it("persists Gamma source and lineage identity receipts", () => {
    const base = createRankedCandidate("identified", 1, 1);
    const identified = {
      ...base,
      evidenceSourceIdentity: "source-1"
    };
    let boundary: FineAssessmentSelectionBoundaryCase | undefined;
    selectFineAssessmentCandidates({
      ...FIELD_PINS,
      orderedCandidates: [identified],
      config: createConfig(),
      supplementaryData: createSupplementaryData({
        sourceCohortKeys: { identified: "lineage-1" }
      }),
      tokenEstimator: { estimate: () => 5 },
      rankByCandidateKey: rankMap([identified]),
      captureAnswerFeatures: true,
      selectionBoundaryObserver: (pending) => {
        boundary = materializeFineAssessmentSelectionBoundary(pending);
        return undefined;
      }
    });
    if (boundary === undefined) throw new Error("selection boundary was not observed");

    expect(boundary.expected.pre_projection?.admission_actions[0]?.witness)
      .toMatchObject({
        kind: "retained",
        source: { status: "available", key: "source-1" },
        lineage: { status: "available", key: "lineage-1" }
      });
    expect(() => replayFineAssessmentSelectionBoundary(boundary)).not.toThrow();
  });
});

function captureBoundary() {
  const candidates = [
    createRankedCandidate("candidate-1", 1, 1),
    createRankedCandidate("candidate-2", 2, 0.8)
  ];
  let boundary: FineAssessmentSelectionBoundaryCase | undefined;
  const result = selectFineAssessmentCandidates({
    ...FIELD_PINS,
    orderedCandidates: candidates,
    config: createConfig(),
    supplementaryData: createSupplementaryData(),
    tokenEstimator: { estimate: () => 5 },
    rankByCandidateKey: rankMap(candidates),
    captureAnswerFeatures: true,
    selectionBoundaryObserver: (pending) => {
      boundary = materializeFineAssessmentSelectionBoundary(pending);
      return undefined;
    }
  });
  if (boundary === undefined) throw new Error("selection boundary was not observed");
  return { boundary, result };
}
