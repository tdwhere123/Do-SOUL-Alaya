import { describe, expect, it } from "vitest";

import {
  evaluateIndependentEmbeddingEvidenceCounterfactual,
  resolveIndependentEmbeddingPromoteReady
} from
  "../../../longmemeval/selection-replay/selection-boundary-counterfactual-verify.js";
import {
  CLOSED_CAPTURE_COUNTERFACTUAL_GOLD_A,
  CLOSED_CAPTURE_COUNTERFACTUAL_GOLD_B,
  CLOSED_CAPTURE_SELECTION_BOUNDARY_A,
  CLOSED_CAPTURE_SELECTION_BOUNDARY_B,
  selectionBoundaryArtifactPresent
} from "./selection-boundary-closed-capture-paths.js";

describe("independent embedding evidence counterfactual (closed-capture)", () => {
  it("reports A/B Any@5, full-gold, and churn against CURRENT baseline identity", async () => {
    if (
      !(await selectionBoundaryArtifactPresent(CLOSED_CAPTURE_SELECTION_BOUNDARY_A)) ||
      !(await selectionBoundaryArtifactPresent(CLOSED_CAPTURE_SELECTION_BOUNDARY_B)) ||
      !(await selectionBoundaryArtifactPresent(CLOSED_CAPTURE_COUNTERFACTUAL_GOLD_A)) ||
      !(await selectionBoundaryArtifactPresent(CLOSED_CAPTURE_COUNTERFACTUAL_GOLD_B))
    ) {
      return;
    }

    const cellA = await evaluateIndependentEmbeddingEvidenceCounterfactual(
      CLOSED_CAPTURE_SELECTION_BOUNDARY_A,
      CLOSED_CAPTURE_COUNTERFACTUAL_GOLD_A
    );
    const cellB = await evaluateIndependentEmbeddingEvidenceCounterfactual(
      CLOSED_CAPTURE_SELECTION_BOUNDARY_B,
      CLOSED_CAPTURE_COUNTERFACTUAL_GOLD_B
    );
    const promote = resolveIndependentEmbeddingPromoteReady(cellA, cellB);

    expect(cellA.baselineCompositionCount).toBe(500);
    expect(cellA.answerableCount).toBe(470);
    expect(cellA.baselineAnyAt5).toBe(373);

    expect(cellB.baselineCompositionCount).toBe(500);
    expect(cellB.answerableCount).toBe(470);
    expect(cellB.baselineAnyAt5).toBe(421);

    // Incomplete CF coverage (unseen tokens) keeps promoteReady false.
    expect(typeof promote.promoteReady).toBe("boolean");
    expect(Array.isArray(promote.blockers)).toBe(true);
    expect(promote.promoteReady).toBe(false);
  }, 180_000);
});
