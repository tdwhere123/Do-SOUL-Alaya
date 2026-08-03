import {
  createSelectionBoundaryCapture,
  notifySelectionBoundaryObserver
} from "../selection-boundary/selection-boundary-capture.js";
import {
  buildFinalPacketConsensusObservation,
  packetMatchesPlannedMembership,
  resolveFinalPacketConsensusPlan
} from "../final-order/final-packet-consensus.js";
import { materializeFinalPacket } from "../final-order/final-packet-order.js";
import type {
  FineAssessmentAccumulator,
  FineAssessmentSelectionContext,
  FineAssessmentSelectionParams,
  FineAssessmentSelectionResult
} from "./types.js";
import type { FineAssessmentPreProjectionCapture } from
  "../selection-boundary/selection-boundary-types.js";

export function buildSelectionResult(
  params: FineAssessmentSelectionParams,
  consensus: ReturnType<typeof resolveFinalPacketConsensusPlan>,
  packet: ReturnType<typeof materializeFinalPacket>,
  tokenEstimatesByContent?: ReadonlyMap<string, number>,
  preProjection?: FineAssessmentPreProjectionCapture
): FineAssessmentSelectionResult {
  const observesBoundary = params.selectionBoundaryObserver !== undefined;
  const packetConsensus = buildFinalPacketConsensusObservation(
    consensus,
    packet.candidates,
    packetMatchesPlannedMembership(consensus, packet.candidates)
  );
  const selectionResult = Object.freeze({
    candidates: packet.candidates,
    diagnostics: packet.diagnostics,
    ...(params.capturePacketPlanTrace === true
      ? { packetPlanObservation: packetConsensus }
      : {})
  });
  if (observesBoundary && tokenEstimatesByContent !== undefined) {
    notifySelectionBoundaryObserver(
      params,
      selectionResult,
      packetConsensus,
      tokenEstimatesByContent,
      preProjection
    );
  }
  return selectionResult;
}

export function createSelectionBoundary(params: FineAssessmentSelectionParams) {
  return params.selectionBoundaryObserver === undefined
    ? undefined
    : createSelectionBoundaryCapture(params);
}

export function materializeFineAssessmentDelivery(
  finalAccumulator: FineAssessmentAccumulator,
  context: FineAssessmentSelectionContext
): ReturnType<typeof materializeFinalPacket> {
  return materializeFinalPacket(
    finalAccumulator.selected,
    finalAccumulator.diagnostics,
    context.config.budgets
  );
}
