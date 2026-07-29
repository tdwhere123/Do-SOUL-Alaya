import {
  selectFineAssessmentCandidates,
  type FineAssessmentSelectionResult
} from "../fine-assessment-selection.js";
import { buildSelectionBoundaryExpected } from
  "./selection-boundary-capture.js";
import {
  restoreSelectionParams,
  throwSelectionBoundaryFidelityMismatch,
  validateSelectionBoundary
} from "./selection-boundary-restore.js";
import type { FineAssessmentSelectionBoundaryCase } from
  "./selection-boundary-types.js";
import { selectionBoundaryJsonSha256 } from "./selection-boundary-json.js";

export type { FineAssessmentSelectionBoundaryCase } from
  "./selection-boundary-types.js";

export function replayFineAssessmentSelectionBoundary(
  boundary: FineAssessmentSelectionBoundaryCase
): FineAssessmentSelectionResult {
  validateSelectionBoundary(boundary);
  const params = restoreSelectionParams(boundary.input);
  const replayed = selectFineAssessmentCandidates({
    ...params,
    capturePacketPlanTrace: true
  });
  const packetConsensus = replayed.packetPlanObservation;
  if (packetConsensus === undefined) {
    throwSelectionBoundaryFidelityMismatch();
  }
  const actual = buildSelectionBoundaryExpected(
    replayed,
    packetConsensus,
    boundary.input.capture_packet_plan_trace === true
  );
  if (
    selectionBoundaryJsonSha256(actual) !==
    selectionBoundaryJsonSha256(boundary.expected)
  ) {
    throwSelectionBoundaryFidelityMismatch();
  }
  if (boundary.input.capture_packet_plan_trace === true) return replayed;
  return Object.freeze({
    candidates: replayed.candidates,
    diagnostics: replayed.diagnostics
  });
}
