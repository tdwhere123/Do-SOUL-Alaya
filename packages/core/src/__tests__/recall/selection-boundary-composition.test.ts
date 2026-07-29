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
    expect(reconstructed.branch.finalOrderAfterCoverage).toBe(
      boundary.input.final_order_after_coverage
    );
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
});

function captureLiveBoundary(): FineAssessmentSelectionBoundaryCase {
  return captureFineAssessmentSelectionBoundary(
    "surface-selection-composition"
  );
}
