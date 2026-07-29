import { describe, expect, it } from "vitest";

import {
  evaluateIndependentEmbeddingEvidenceCounterfactual,
  evaluateIndependentEmbeddingEvidenceCounterfactualWithCompanion
} from
  "../../../longmemeval/selection-replay/selection-boundary-counterfactual-verify.js";
import {
  buildCfTokenCompanionArtifact
} from
  "../../../longmemeval/selection-replay/selection-boundary-cf-token-companion.js";
import {
  CLOSED_CAPTURE_COUNTERFACTUAL_GOLD_A,
  CLOSED_CAPTURE_COUNTERFACTUAL_GOLD_B,
  CLOSED_CAPTURE_CF_TOKEN_COMPANION_A_GZIP,
  CLOSED_CAPTURE_CF_TOKEN_COMPANION_A_MANIFEST,
  CLOSED_CAPTURE_CF_TOKEN_COMPANION_B_GZIP,
  CLOSED_CAPTURE_CF_TOKEN_COMPANION_B_MANIFEST,
  CLOSED_CAPTURE_CF_TOKEN_ROOT,
  CLOSED_CAPTURE_SELECTION_BOUNDARY_A,
  CLOSED_CAPTURE_SELECTION_BOUNDARY_B,
  selectionBoundaryArtifactPresent
} from "./selection-boundary-closed-capture-paths.js";

describe("cf token companion closed-capture", () => {
  it("baseline CF without companion still sees A unseen-token fail-louds", async () => {
    if (
      !(await selectionBoundaryArtifactPresent(CLOSED_CAPTURE_SELECTION_BOUNDARY_A)) ||
      !(await selectionBoundaryArtifactPresent(CLOSED_CAPTURE_COUNTERFACTUAL_GOLD_A))
    ) {
      return;
    }
    const cellA = await evaluateIndependentEmbeddingEvidenceCounterfactual(
      CLOSED_CAPTURE_SELECTION_BOUNDARY_A,
      CLOSED_CAPTURE_COUNTERFACTUAL_GOLD_A
    );
    expect(cellA.baselineCompositionCount).toBe(500);
    expect(cellA.unseenTokenFailureCount).toBe(7);
    expect(cellA.counterfactualEvaluableCount).toBe(493);
  }, 180_000);

  it("builds companions and closes A/B CF token coverage", async () => {
    if (
      !(await selectionBoundaryArtifactPresent(CLOSED_CAPTURE_SELECTION_BOUNDARY_A)) ||
      !(await selectionBoundaryArtifactPresent(CLOSED_CAPTURE_SELECTION_BOUNDARY_B)) ||
      !(await selectionBoundaryArtifactPresent(CLOSED_CAPTURE_COUNTERFACTUAL_GOLD_A)) ||
      !(await selectionBoundaryArtifactPresent(CLOSED_CAPTURE_COUNTERFACTUAL_GOLD_B))
    ) {
      return;
    }

    const manifestA = await buildCfTokenCompanionArtifact({
      cell: "A",
      boundaryArtifactPath: CLOSED_CAPTURE_SELECTION_BOUNDARY_A,
      outputDirectory: CLOSED_CAPTURE_CF_TOKEN_ROOT
    });
    const manifestB = await buildCfTokenCompanionArtifact({
      cell: "B",
      boundaryArtifactPath: CLOSED_CAPTURE_SELECTION_BOUNDARY_B,
      outputDirectory: CLOSED_CAPTURE_CF_TOKEN_ROOT
    });

    expect(manifestA.live_reconstruction.status).toBe("exact");
    expect(manifestA.live_reconstruction.mismatches).toBe(0);
    expect(manifestA.authoritative_record_count).toBe(500);
    expect(manifestB.live_reconstruction.status).toBe("exact");
    expect(manifestB.authoritative_record_count).toBe(500);

    const cellA = await evaluateIndependentEmbeddingEvidenceCounterfactualWithCompanion(
      CLOSED_CAPTURE_SELECTION_BOUNDARY_A,
      CLOSED_CAPTURE_COUNTERFACTUAL_GOLD_A,
      CLOSED_CAPTURE_CF_TOKEN_COMPANION_A_GZIP,
      CLOSED_CAPTURE_CF_TOKEN_COMPANION_A_MANIFEST
    );
    const cellB = await evaluateIndependentEmbeddingEvidenceCounterfactualWithCompanion(
      CLOSED_CAPTURE_SELECTION_BOUNDARY_B,
      CLOSED_CAPTURE_COUNTERFACTUAL_GOLD_B,
      CLOSED_CAPTURE_CF_TOKEN_COMPANION_B_GZIP,
      CLOSED_CAPTURE_CF_TOKEN_COMPANION_B_MANIFEST
    );

    expect(cellA.baselineCompositionCount).toBe(500);
    expect(cellA.counterfactualEvaluableCount).toBe(500);
    expect(cellA.unseenTokenFailureCount).toBe(0);
    expect(cellB.baselineCompositionCount).toBe(500);
    expect(cellB.counterfactualEvaluableCount).toBe(500);
    expect(cellB.unseenTokenFailureCount).toBe(0);
  }, 300_000);
});
