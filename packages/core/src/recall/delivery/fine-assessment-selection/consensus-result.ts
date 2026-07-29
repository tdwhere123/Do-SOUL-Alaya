import {
  createSelectionBoundaryCapture,
  notifySelectionBoundaryObserver
} from "../selection-boundary/selection-boundary-capture.js";
import { buildRecallCandidateSelectionKey } from "../../runtime/recall-candidate-builder.js";
import { retainBoundedAnswerHeads, selectBoundedDirectEvidenceHead } from "../admission/direct-evidence-answer-head.js";
import { buildFinalPacketConsensusObservation, buildConsensusReplayOrder, packetMatchesConsensusPlan, resolveFinalPacketConsensusPlan } from "../final-order/final-packet-consensus.js";
import { mergeFinalPacketAdmissionDiagnostics } from "../final-order/final-packet-diagnostics.js";
import { materializeFinalPacket, orderDeliveredPacket } from "../final-order/final-packet-order.js";
import { orderWithVerifiedAnswerSlot } from "../final-order/verified-answer-slot.js";
import type {
  FineAssessmentAccumulator,
  FineAssessmentCandidate,
  FineAssessmentSelectionContext,
  FineAssessmentSelectionParams,
  FineAssessmentSelectionResult
} from "./types.js";

export function buildSelectionResult(
  params: FineAssessmentSelectionParams,
  consensus: ReturnType<typeof resolveFinalPacketConsensusPlan>,
  result: ReturnType<typeof applyFinalPacketConsensus>,
  tokenEstimatesByContent?: ReadonlyMap<string, number>
): FineAssessmentSelectionResult {
  const observesBoundary = params.selectionBoundaryObserver !== undefined;
  const packetConsensus = params.capturePacketPlanTrace === true || observesBoundary
    ? buildFinalPacketConsensusObservation(
        consensus,
        result.packet.candidates,
        result.replayAccepted
      )
    : undefined;
  const selectionResult = Object.freeze({
    candidates: result.packet.candidates,
    diagnostics: result.packet.diagnostics,
    ...(params.capturePacketPlanTrace === true && packetConsensus !== undefined
      ? { packetPlanObservation: packetConsensus }
      : {})
  });
  if (packetConsensus !== undefined && tokenEstimatesByContent !== undefined) {
    notifySelectionBoundaryObserver(
      params, selectionResult, packetConsensus, tokenEstimatesByContent
    );
  }
  return selectionResult;
}

export function applyFinalPacketConsensus(
  plan: ReturnType<typeof resolveFinalPacketConsensusPlan>,
  baseline: ReturnType<typeof materializeFinalPacket>,
  sourceCandidates: readonly FineAssessmentCandidate[],
  context: FineAssessmentSelectionContext,
  evictions: ReadonlySet<string>,
  reduceCandidates: (
    candidates: readonly FineAssessmentCandidate[],
    context: FineAssessmentSelectionContext,
    evictions: ReadonlySet<string>
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
    context,
    evictions
  );
  if (!packetMatchesConsensusPlan(plan, replay.selected)) {
    return Object.freeze({ packet: baseline, replayAccepted: false });
  }
  return Object.freeze({
    packet: materializeFinalPacket(
      replay.selected,
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
  evidenceHead: ReturnType<typeof selectBoundedDirectEvidenceHead>,
  context: FineAssessmentSelectionContext,
  finalOrder: NonNullable<FineAssessmentSelectionParams["finalOrderAfterCoverage"]>,
  maxHeadDrop?: number
): ReturnType<typeof materializeFinalPacket> {
  if (finalOrder === "coverage") {
    return materializeFinalPacket(
      retainBoundedAnswerHeads(
        orderWithVerifiedAnswerSlot({
          publicOrder: finalAccumulator.selected,
          supportByCandidateKey: context.answerSupportByCandidateKey
        }),
        evidenceHead.protections,
        buildRecallCandidateSelectionKey,
        context.supplementaryData.queryProbes,
        evidenceHead.candidates,
        (candidateKey) => context.answerSupportByCandidateKey.get(
          candidateKey
        )?.authority?.behavior_eligible === true
      ),
      finalAccumulator.diagnostics,
      context.config.budgets
    );
  }
  return orderDeliveredPacket({
    selected: finalAccumulator.selected,
    diagnostics: finalAccumulator.diagnostics,
    context,
    finalOrder,
    maxHeadDrop,
    answerHeadProtections: evidenceHead.protections,
    sourceCandidates: evidenceHead.candidates
  });
}
