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
    throwSelectionBoundaryFidelityMismatch(
      `expected packet_candidate_keys length ${candidatesByKey.size} unique, ` +
      `actual length ${keys.length} unique ${new Set(keys).size}`
    );
  }
  const candidates = keys.map((key) => candidatesByKey.get(key));
  const missing = candidates.filter((candidate) => candidate === undefined).length;
  if (missing !== 0) {
    throwSelectionBoundaryFidelityMismatch(
      `expected packet_candidate_keys subset of ordered_candidates, actual missing=${missing}`
    );
  }
  return Object.freeze(candidates as FineAssessmentCandidate[]);
}
