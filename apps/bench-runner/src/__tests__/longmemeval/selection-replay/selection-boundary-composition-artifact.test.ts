import { describe, expect, it } from "vitest";

import { verifyLongMemEvalSelectionBoundaryCompositionArtifact } from
  "../../../longmemeval/selection-replay/selection-boundary-composition-verify.js";
import {
  CLOSED_CAPTURE_SELECTION_BOUNDARY_A,
  CLOSED_CAPTURE_SELECTION_BOUNDARY_B,
  selectionBoundaryArtifactPresent
} from "./selection-boundary-closed-capture-paths.js";

describe("selection composition reconstruction (closed-capture artifacts)", () => {
  it("proves baseline-exact composition identity on full A and B sidecars", async () => {
    if (
      !(await selectionBoundaryArtifactPresent(CLOSED_CAPTURE_SELECTION_BOUNDARY_A)) ||
      !(await selectionBoundaryArtifactPresent(CLOSED_CAPTURE_SELECTION_BOUNDARY_B))
    ) {
      return;
    }

    const cellA = await verifyLongMemEvalSelectionBoundaryCompositionArtifact(
      CLOSED_CAPTURE_SELECTION_BOUNDARY_A
    );
    const cellB = await verifyLongMemEvalSelectionBoundaryCompositionArtifact(
      CLOSED_CAPTURE_SELECTION_BOUNDARY_B
    );

    expect(cellA).toEqual({ recordCount: 500, compositionCount: 500 });
    expect(cellB).toEqual({ recordCount: 500, compositionCount: 500 });
  }, 120_000);
});
