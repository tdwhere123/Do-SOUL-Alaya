import { describe, expect, it } from "vitest";

import {
  reconstructFineAssessmentComposition,
  SELECTION_COMPOSITION_FIDELITY_MISMATCH
} from
  "../../recall/delivery/selection-boundary/selection-boundary-composition.js";
import {
  SELECTION_BOUNDARY_FIDELITY_MISMATCH
} from
  "../../recall/delivery/selection-boundary/selection-boundary-restore.js";
import type { FineAssessmentSelectionBoundaryCase } from
  "../../recall/delivery/selection-boundary/selection-boundary-types.js";
import { captureFineAssessmentSelectionBoundary } from
  "./selection-boundary-live-capture-fixture.js";

describe("fine-assessment selection composition reconstruction", () => {
  it("rebuilds delivery inputs and packet identity from a live fineAssess capture", () => {
    const boundary = captureLiveBoundary();
    const reconstructed = reconstructFineAssessmentComposition(boundary);

    expect(reconstructed.branch.replacePublicRelevance).toBe(false);
    expect(reconstructed.result.candidates.map((candidate) =>
      candidate.object_id
    )).toEqual(
      boundary.expected.candidate_keys.map((key) => key.split(":").at(-1))
    );
  });

  it("fails loud when a token estimate was never captured live", () => {
    const boundary = captureLiveBoundary();
    const stripped: FineAssessmentSelectionBoundaryCase = {
      ...boundary,
      input: {
        ...boundary.input,
        token_estimates_by_content: []
      }
    };

    expect(() => reconstructFineAssessmentComposition(stripped))
      .toThrow(SELECTION_BOUNDARY_FIDELITY_MISMATCH);
    expect(() => reconstructFineAssessmentComposition(stripped)).toThrow(
      /captured token estimate missing: expected token_estimates_by_content entry for content sha256:[0-9a-f]{64} \(chars=\d+\), actual absent among 0 captured contents/u
    );
  });

  it("fails loud when a captured delivery rank drifts from recomputation", () => {
    const boundary = captureLiveBoundary();
    const [first, ...rest] = boundary.input.rank_by_candidate_key;
    const drifted: FineAssessmentSelectionBoundaryCase = {
      ...boundary,
      input: {
        ...boundary.input,
        rank_by_candidate_key: [
          [first![0], first![1] + 1],
          ...rest
        ]
      }
    };

    expect(() => reconstructFineAssessmentComposition(drifted))
      .toThrow(SELECTION_COMPOSITION_FIDELITY_MISMATCH);
  });

  it("rebuilds the projection ledger and rejects post-settlement drift", () => {
    const boundary = captureLiveBoundary();
    const projection = boundary.expected.pre_projection;
    if (projection === undefined) throw new Error("pre-projection was not captured");
    expect(() => reconstructFineAssessmentComposition(boundary)).not.toThrow();
    let tokenTotal = 0;
    const admissionActions = projection.admission_actions.map((action) => {
      if (action.witness.kind !== "retained") return action;
      const tokenEstimate = action.witness.token_estimate +
        (action.pre_projection_rank === 1 ? 1 : 0);
      const driftedAction = {
        ...action,
        witness: {
          ...action.witness,
          token_total_before: tokenTotal,
          token_estimate: tokenEstimate
        }
      };
      tokenTotal += tokenEstimate;
      return driftedAction;
    });
    const drifted: FineAssessmentSelectionBoundaryCase = {
      ...boundary,
      expected: {
        ...boundary.expected,
        pre_projection: {
          ...projection,
          token_total: tokenTotal,
          admission_actions: admissionActions
        }
      }
    };

    expect(() => reconstructFineAssessmentComposition(drifted))
      .toThrow(SELECTION_COMPOSITION_FIDELITY_MISMATCH);
  });
});

function captureLiveBoundary(): FineAssessmentSelectionBoundaryCase {
  return captureFineAssessmentSelectionBoundary(
    "surface-selection-composition"
  );
}
