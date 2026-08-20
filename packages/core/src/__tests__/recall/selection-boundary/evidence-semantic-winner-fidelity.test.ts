import { describe, expect, it } from "vitest";

import {
  replayFineAssessmentSelectionBoundary
} from
  "../../../recall/delivery/selection-boundary/selection-boundary-replay.js";
import { restoreSupplementaryData } from
  "../../../recall/delivery/selection-boundary/selection-boundary-restore.js";
import type {
  RecallEvidenceSemanticActivationReceipt,
  RecallEvidenceSemanticWinnerReceipt
} from
  "../../../recall/runtime/recall-service-types.js";
import { captureFineAssessmentSelectionBoundary } from
  "../selection-boundary-live-capture-fixture.js";

const CANDIDATE_KEY = "workspace_local:memory_entry:candidate-1";

describe("selection boundary evidence-semantic winner fidelity", () => {
  it("round-trips the attributed projection and forms", () => {
    const winner = factKeyWinner(5);
    const boundary = captureFineAssessmentSelectionBoundary("winner-roundtrip", {
      evidenceSemanticActivationsByCandidateKey: new Map([
        [CANDIDATE_KEY, activation(winner)]
      ])
    });

    const serialized = boundary.input.supplementary_data;
    const restored = restoreSupplementaryData(serialized);

    expect(serialized.evidenceSemanticActivationsByCandidateKey).toEqual([
      [CANDIDATE_KEY, activation(winner)]
    ]);
    expect(restored.evidenceSemanticActivationsByCandidateKey.get(CANDIDATE_KEY))
      .toEqual(activation(winner));
    expect(() => replayFineAssessmentSelectionBoundary(boundary)).not.toThrow();
  });

  it("rejects a zero fact-key projection identity", () => {
    const winner = factKeyWinner(0);
    const boundary = captureFineAssessmentSelectionBoundary("winner-invalid-id", {
      evidenceSemanticActivationsByCandidateKey: new Map([
        [CANDIDATE_KEY, activation(winner)]
      ])
    });

    expect(() => replayFineAssessmentSelectionBoundary(boundary))
      .toThrow(
        /selection boundary fidelity mismatch: expected owner or positive fact_key projection, actual kind=fact_key id=0/u
      );
  });

  it("rejects winner forms that diverge from the first observation", () => {
    const winner = factKeyWinner(5);
    const captured = captureFineAssessmentSelectionBoundary("winner-form-drift", {
      evidenceSemanticActivationsByCandidateKey: new Map([
        [CANDIDATE_KEY, activation(winner)]
      ])
    });
    const [candidateKey, receipt] = captured.input.supplementary_data
      .evidenceSemanticActivationsByCandidateKey![0]!;
    const boundary = {
      ...captured,
      input: {
        ...captured.input,
        supplementary_data: {
          ...captured.input.supplementary_data,
          evidenceSemanticActivationsByCandidateKey: [[candidateKey, {
            ...receipt,
            winner: {
              ...receipt.winner,
              projection: {
                ...receipt.winner.projection,
                matched_fact_key_forms: [{ kind: "complete" }]
              }
            }
          }]]
        }
      }
    } as unknown as FineAssessmentSelectionBoundaryCase;

    expect(() => replayFineAssessmentSelectionBoundary(boundary))
      .toThrow(
        /selection boundary fidelity mismatch: expected ranked observations with one winner match, actual matches=\d+ observations=\d+/u
      );
  });

  it("normalizes a legacy score and winner pair as an incomplete receipt", () => {
    const winner = factKeyWinner(5);
    const captured = captureFineAssessmentSelectionBoundary("winner-legacy", {
      evidenceSemanticActivationsByCandidateKey: new Map([
        [CANDIDATE_KEY, activation(winner)]
      ])
    });
    const {
      evidenceSemanticActivationsByCandidateKey: _activations,
      ...plainData
    } = captured.input.supplementary_data;
    const boundary = Object.freeze({
      ...captured,
      input: Object.freeze({
        ...captured.input,
        supplementary_data: Object.freeze({
          ...plainData,
          evidenceSemanticScoresByCandidateKey: Object.freeze([
            Object.freeze([CANDIDATE_KEY, winner.score] as const)
          ]),
          evidenceSemanticWinnersByCandidateKey: Object.freeze([
            Object.freeze([CANDIDATE_KEY, winner] as const)
          ])
        })
      })
    });

    expect(restoreSupplementaryData(boundary.input.supplementary_data)
      .evidenceSemanticActivationsByCandidateKey.get(CANDIDATE_KEY))
      .toEqual({
        ...activation(winner),
        observation_completeness: "winner_only_legacy"
      });
    expect(() => replayFineAssessmentSelectionBoundary(boundary)).not.toThrow();
  });
});

function activation(
  winner: Readonly<RecallEvidenceSemanticWinnerReceipt>
): Readonly<RecallEvidenceSemanticActivationReceipt> {
  return Object.freeze({
    schema_version: 1,
    operator_id: "evidence_document_max_v1",
    state: "observed",
    score: winner.score,
    winner,
    observations: Object.freeze([winner]),
    observation_completeness: "complete",
    missing_channel_policy: "no_op"
  });
}

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
