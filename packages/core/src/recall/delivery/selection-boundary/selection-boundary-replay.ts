import {
  selectFineAssessmentCandidates,
  type FineAssessmentSelectionResult
} from "../fine-assessment-selection.js";
import {
  buildSelectionBoundaryExpected,
  type FineAssessmentSelectionBoundaryPendingCapture
} from
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
  let pending: FineAssessmentSelectionBoundaryPendingCapture | undefined;
  const replayed = selectFineAssessmentCandidates({
    ...params,
    capturePacketPlanTrace: true,
    ...(boundary.expected.pre_projection === undefined ? {} : {
      selectionBoundaryObserver: (capture) => {
        pending = capture;
        return undefined;
      }
    })
  });
  const packetConsensus = replayed.packetPlanObservation;
  if (packetConsensus === undefined) {
    throwSelectionBoundaryFidelityMismatch(
      "expected packetPlanObservation, actual absent"
    );
  }
  const actual = buildSelectionBoundaryExpected(
    replayed,
    packetConsensus,
    boundary.input.capture_packet_plan_trace === true,
    pending?.preProjection,
    boundary.expected.coverage_objective !== undefined
  );
  const expectedDigest = selectionBoundaryJsonSha256(boundary.expected);
  const actualDigest = selectionBoundaryJsonSha256(actual);
  if (expectedDigest !== actualDigest) {
    throwSelectionBoundaryFidelityMismatch(
      `expected replay digest ${expectedDigest}, actual ${actualDigest}`
    );
  }
  if (boundary.input.capture_packet_plan_trace === true) return replayed;
  return Object.freeze({
    candidates: replayed.candidates,
    diagnostics: replayed.diagnostics,
    coverageSelectionObjective: replayed.coverageSelectionObjective,
    orderSequence: replayed.orderSequence,
    ...(replayed.fieldRefinementStopCertificate === undefined ? {} : {
      fieldRefinementStopCertificate: replayed.fieldRefinementStopCertificate
    })
  });
}
