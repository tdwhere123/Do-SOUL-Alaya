import { describe, expect, it } from "vitest";

import { verifyLongMemEvalSelectionBoundaryLedgerSample } from
  "../../../longmemeval/selection-replay/selection-boundary-ledger-verify.js";
import {
  CLOSED_CAPTURE_SELECTION_BOUNDARY_A,
  CLOSED_CAPTURE_SELECTION_BOUNDARY_B,
  selectionBoundaryArtifactPresent
} from "./selection-boundary-closed-capture-paths.js";

describe("selection component ledger (observational, closed-capture artifacts)", () => {
  it("derives ledger then keeps composition identity on A/B samples", async () => {
    if (
      !(await selectionBoundaryArtifactPresent(CLOSED_CAPTURE_SELECTION_BOUNDARY_A)) ||
      !(await selectionBoundaryArtifactPresent(CLOSED_CAPTURE_SELECTION_BOUNDARY_B))
    ) {
      return;
    }

    const cellA = await verifyLongMemEvalSelectionBoundaryLedgerSample(
      CLOSED_CAPTURE_SELECTION_BOUNDARY_A,
      { sampleLimit: 5 }
    );
    const cellB = await verifyLongMemEvalSelectionBoundaryLedgerSample(
      CLOSED_CAPTURE_SELECTION_BOUNDARY_B,
      { sampleLimit: 5 }
    );

    expect(cellA.sampleCount).toBe(5);
    expect(cellB.sampleCount).toBe(5);
    expect(cellA.ledgerCandidateCount).toBeGreaterThan(0);
    expect(cellB.ledgerCandidateCount).toBeGreaterThan(0);
  }, 120_000);
});
