import { describe, expect, it } from "vitest";

import {
  evaluateNonlexicalUnitIntervalCompositionCounterfactualWithCompanion,
  resolveSelectionCounterfactualPromoteReady,
  summarizeCohortHitTransitions,
  toQuestionTransition,
  type CounterfactualQuestionTransition
} from
  "../../../longmemeval/selection-replay/selection-boundary-counterfactual-verify.js";
import {
  CLOSED_CAPTURE_COUNTERFACTUAL_GOLD_A,
  CLOSED_CAPTURE_COUNTERFACTUAL_GOLD_B,
  CLOSED_CAPTURE_CF_TOKEN_COMPANION_A_GZIP,
  CLOSED_CAPTURE_CF_TOKEN_COMPANION_A_MANIFEST,
  CLOSED_CAPTURE_CF_TOKEN_COMPANION_B_GZIP,
  CLOSED_CAPTURE_CF_TOKEN_COMPANION_B_MANIFEST,
  CLOSED_CAPTURE_SELECTION_BOUNDARY_A,
  CLOSED_CAPTURE_SELECTION_BOUNDARY_B,
  selectionBoundaryArtifactPresent
} from "./selection-boundary-closed-capture-paths.js";

describe("nonlexical unit-interval composition counterfactual (closed-capture)", () => {
  it("evaluates A/B with Gate 2 companion without changing promote gates shape", async () => {
    if (
      !(await selectionBoundaryArtifactPresent(CLOSED_CAPTURE_SELECTION_BOUNDARY_A)) ||
      !(await selectionBoundaryArtifactPresent(CLOSED_CAPTURE_SELECTION_BOUNDARY_B)) ||
      !(await selectionBoundaryArtifactPresent(CLOSED_CAPTURE_COUNTERFACTUAL_GOLD_A)) ||
      !(await selectionBoundaryArtifactPresent(CLOSED_CAPTURE_COUNTERFACTUAL_GOLD_B)) ||
      !(await selectionBoundaryArtifactPresent(CLOSED_CAPTURE_CF_TOKEN_COMPANION_A_GZIP)) ||
      !(await selectionBoundaryArtifactPresent(CLOSED_CAPTURE_CF_TOKEN_COMPANION_B_GZIP))
    ) {
      return;
    }

    const transitionsA: CounterfactualQuestionTransition[] = [];
    const transitionsB: CounterfactualQuestionTransition[] = [];
    const cellA =
      await evaluateNonlexicalUnitIntervalCompositionCounterfactualWithCompanion(
        CLOSED_CAPTURE_SELECTION_BOUNDARY_A,
        CLOSED_CAPTURE_COUNTERFACTUAL_GOLD_A,
        CLOSED_CAPTURE_CF_TOKEN_COMPANION_A_GZIP,
        CLOSED_CAPTURE_CF_TOKEN_COMPANION_A_MANIFEST,
        {
          onRecord: (evaluation) => {
            transitionsA.push(toQuestionTransition(evaluation));
          }
        }
      );
    const cellB =
      await evaluateNonlexicalUnitIntervalCompositionCounterfactualWithCompanion(
        CLOSED_CAPTURE_SELECTION_BOUNDARY_B,
        CLOSED_CAPTURE_COUNTERFACTUAL_GOLD_B,
        CLOSED_CAPTURE_CF_TOKEN_COMPANION_B_GZIP,
        CLOSED_CAPTURE_CF_TOKEN_COMPANION_B_MANIFEST,
        {
          onRecord: (evaluation) => {
            transitionsB.push(toQuestionTransition(evaluation));
          }
        }
      );
    const promote = resolveSelectionCounterfactualPromoteReady(cellA, cellB);

    expect(cellA.operator).toBe("nonlexical_unit_interval_composition");
    expect(cellA.baselineCompositionCount).toBe(500);
    expect(cellA.counterfactualEvaluableCount).toBe(500);
    expect(cellA.unseenTokenFailureCount).toBe(0);
    expect(cellA.baselineAnyAt5).toBe(373);

    expect(cellB.operator).toBe("nonlexical_unit_interval_composition");
    expect(cellB.baselineCompositionCount).toBe(500);
    expect(cellB.counterfactualEvaluableCount).toBe(500);
    expect(cellB.unseenTokenFailureCount).toBe(0);
    expect(cellB.baselineAnyAt5).toBe(421);

    expect(typeof promote.promoteReady).toBe("boolean");
    expect(Array.isArray(promote.blockers)).toBe(true);

    const emptyCohort = summarizeCohortHitTransitions(transitionsA, new Set());
    expect(emptyCohort.cohortSize).toBe(0);
    expect(transitionsA.length).toBe(500);
    expect(transitionsB.length).toBe(500);
  }, 300_000);
});
