import { describe, expect, it } from "vitest";
import {
  replayFineAssessmentSelectionBoundary,
  type FineAssessmentSelectionBoundaryCase
} from "../../recall/delivery/selection-boundary/selection-boundary-replay.js";
import {
  materializeFineAssessmentSelectionBoundary
} from "../../recall/delivery/selection-boundary/selection-boundary-capture.js";
import {
  consensusCandidates,
  select
} from "./final-strict-tail-consensus-fixtures.js";

describe("selection boundary replay fidelity", () => {
  it("fails when serialized input or expected output is tampered", () => {
    let boundary: FineAssessmentSelectionBoundaryCase | undefined;
    select(consensusCandidates(), {
      capturePacketPlanTrace: true,
      finalOrderAfterCoverage: "public_relevance",
      selectionBoundaryObserver: (captured) => {
        boundary = materializeFineAssessmentSelectionBoundary(captured);
      }
    });
    if (boundary === undefined) throw new Error("selection boundary was not observed");
    const inputTamper: FineAssessmentSelectionBoundaryCase = {
      ...boundary,
      input: {
        ...boundary.input,
        config: {
          ...boundary.input.config,
          budgets: {
            ...boundary.input.config.budgets,
            max_entries: 1
          }
        }
      }
    };
    const outputTamper: FineAssessmentSelectionBoundaryCase = {
      ...boundary,
      expected: {
        ...boundary.expected,
        candidate_keys: [...boundary.expected.candidate_keys].reverse()
      }
    };

    expect(() => replayFineAssessmentSelectionBoundary(inputTamper))
      .toThrow(/selection boundary fidelity mismatch/u);
    expect(() => replayFineAssessmentSelectionBoundary(outputTamper))
      .toThrow(/selection boundary fidelity mismatch/u);
  });
});
