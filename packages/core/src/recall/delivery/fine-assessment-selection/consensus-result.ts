import {
  createSelectionBoundaryCapture,
  notifySelectionBoundaryObserver
} from "../selection-boundary/selection-boundary-capture.js";
import { buildFinalPacketConsensusObservation, buildConsensusReplayOrder, packetMatchesConsensusMembership, resolveFinalPacketConsensusPlan } from "../final-order/final-packet-consensus.js";
import { mergeFinalPacketAdmissionDiagnostics } from "../final-order/final-packet-diagnostics.js";
import { materializeFinalPacket } from "../final-order/final-packet-order.js";
import { buildRecallCandidateSelectionKey } from "../../runtime/recall-candidate-builder.js";
import type {
  FineAssessmentAccumulator,
  FineAssessmentCandidate,
  FineAssessmentSelectionContext,
  FineAssessmentSelectionParams,
  FineAssessmentSelectionResult
} from "./types.js";
import type { FineAssessmentPreProjectionCapture } from
  "../selection-boundary/selection-boundary-types.js";

export function buildSelectionResult(
  params: FineAssessmentSelectionParams,
  consensus: ReturnType<typeof resolveFinalPacketConsensusPlan>,
  result: ReturnType<typeof applyFinalPacketConsensus>,
  tokenEstimatesByContent?: ReadonlyMap<string, number>,
  preProjection?: FineAssessmentPreProjectionCapture
): FineAssessmentSelectionResult {
  const observesBoundary = params.selectionBoundaryObserver !== undefined;
  const packetConsensus = buildFinalPacketConsensusObservation(
    consensus,
    result.packet.candidates,
    result.replayAccepted
  );
  const selectionResult = Object.freeze({
    candidates: result.packet.candidates,
    diagnostics: result.packet.diagnostics,
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

export function applyFinalPacketConsensus(
  plan: ReturnType<typeof resolveFinalPacketConsensusPlan>,
  baseline: ReturnType<typeof materializeFinalPacket>,
  sourceCandidates: readonly FineAssessmentCandidate[],
  context: FineAssessmentSelectionContext,
  reduceCandidates: (
    candidates: readonly FineAssessmentCandidate[],
    context: FineAssessmentSelectionContext
  ) => FineAssessmentAccumulator
): Readonly<{
  readonly packet: ReturnType<typeof materializeFinalPacket>;
  readonly replayAccepted: boolean;
}> {
  if (plan.decision.status !== "accepted") {
    return Object.freeze({ packet: baseline, replayAccepted: false });
  }
  const replay = reduceCandidates(
    buildConsensusReplayOrder(plan, sourceCandidates),
    context
  );
  if (!packetMatchesConsensusMembership(plan, replay.selected)) {
    return Object.freeze({ packet: baseline, replayAccepted: false });
  }
  const replayByKey = new Map(
    replay.selected.map((candidate) => [
      buildRecallCandidateSelectionKey(candidate),
      candidate
    ])
  );
  const orderedReplay = [] as Array<
    ReturnType<typeof materializeFinalPacket>["candidates"][number]
  >;
  for (const candidate of plan.candidates) {
    const replayCandidate = replayByKey.get(candidate.candidateKey);
    if (replayCandidate === undefined) {
      return Object.freeze({ packet: baseline, replayAccepted: false });
    }
    orderedReplay.push(replayCandidate);
  }
  return Object.freeze({
    packet: materializeFinalPacket(
      orderedReplay,
      mergeFinalPacketAdmissionDiagnostics(
        baseline.diagnostics,
        replay.diagnostics
      ),
      context.config.budgets
    ),
    replayAccepted: true
  });
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
