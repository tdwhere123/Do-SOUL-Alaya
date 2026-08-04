import { describe, expect, it } from "vitest";

import {
  replayFineAssessmentSelectionBoundary
} from
  "../../../recall/delivery/selection-boundary/selection-boundary-replay.js";
import { restoreSupplementaryData } from
  "../../../recall/delivery/selection-boundary/selection-boundary-restore.js";
import type { RecallEvidenceSemanticWinnerReceipt } from
  "../../../recall/runtime/recall-service-types.js";
import { captureFineAssessmentSelectionBoundary } from
  "../selection-boundary-live-capture-fixture.js";

const CANDIDATE_KEY = "workspace_local:memory_entry:candidate-1";

describe("selection boundary evidence-semantic winner fidelity", () => {
  it("round-trips the attributed projection and forms", () => {
    const winner = factKeyWinner(5);
    const boundary = captureFineAssessmentSelectionBoundary("winner-roundtrip", {
      evidenceSemanticScoresByCandidateKey: new Map([[CANDIDATE_KEY, winner.score]]),
      evidenceSemanticWinnersByCandidateKey: new Map([[CANDIDATE_KEY, winner]])
    });

    const serialized = boundary.input.supplementary_data;
    const restored = restoreSupplementaryData(serialized);

    expect(serialized.evidenceSemanticWinnersByCandidateKey).toEqual([
      [CANDIDATE_KEY, winner]
    ]);
    expect(restored.evidenceSemanticWinnersByCandidateKey?.get(CANDIDATE_KEY))
      .toEqual(winner);
    expect(() => replayFineAssessmentSelectionBoundary(boundary)).not.toThrow();
  });

  it("rejects a zero fact-key projection identity", () => {
    const winner = factKeyWinner(0);
    const boundary = captureFineAssessmentSelectionBoundary("winner-invalid-id", {
      evidenceSemanticScoresByCandidateKey: new Map([[CANDIDATE_KEY, winner.score]]),
      evidenceSemanticWinnersByCandidateKey: new Map([[CANDIDATE_KEY, winner]])
    });

    expect(() => replayFineAssessmentSelectionBoundary(boundary))
      .toThrow(/selection boundary fidelity mismatch/u);
  });
});

function factKeyWinner(
  projectionId: number
): Readonly<RecallEvidenceSemanticWinnerReceipt> {
  return Object.freeze({
    score: 0.9,
    evidenceObjectId: "evidence-1",
    documentIdentity: `fact_key:${projectionId}`,
    projection: Object.freeze({
      projection_id: projectionId,
      projection_kind: "fact_key",
      matched_fact_key_forms: Object.freeze([{
        kind: "leave_one_slot_out" as const,
        omitted_slot: Object.freeze({ slot_index: 2, role: "value" as const })
      }])
    })
  });
}
