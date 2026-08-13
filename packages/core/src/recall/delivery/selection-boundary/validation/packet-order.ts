import type { FineAssessmentCandidate } from
  "../../fine-assessment-selection.js";
import type { FineAssessmentSelectionBoundaryInput } from
  "../selection-boundary-types.js";
import { throwSelectionBoundaryFidelityMismatch } from "./fidelity-error.js";

export function restoreCapturedPacketCandidates(
  input: FineAssessmentSelectionBoundaryInput
): readonly FineAssessmentCandidate[] | null {
  const keys = input.packet_candidate_keys;
  if (keys === undefined) return null;
  const candidatesByKey = new Map(input.ordered_candidates.map(
    (candidate) => [candidate.fusion.candidate_key, candidate]
  ));
  if (keys.length !== candidatesByKey.size || new Set(keys).size !== keys.length) {
    throwSelectionBoundaryFidelityMismatch();
  }
  const candidates = keys.map((key) => candidatesByKey.get(key));
  if (candidates.some((candidate) => candidate === undefined)) {
    throwSelectionBoundaryFidelityMismatch();
  }
  return Object.freeze(candidates as FineAssessmentCandidate[]);
}
