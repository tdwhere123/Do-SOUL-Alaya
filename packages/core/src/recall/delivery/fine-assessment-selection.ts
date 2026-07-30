import { buildRecallCandidate, buildRecallCandidateSelectionKey } from "../runtime/recall-candidate-builder.js";
import { buildRecallCandidateDedupeKey, buildRecallLogicalObjectKey, isWorkspaceMemoryCandidate } from "../runtime/recall-service-helpers.js";
import {
  selectBoundedDirectEvidenceHead,
  type DirectEvidenceHeadSelection
} from "./admission/direct-evidence-answer-head.js";
import { buildFinalScoreFactors, createFineAssessmentDiagnostic } from "./diagnostics/fine-assessment-diagnostics.js";
import { resolveFinalPacketConsensusPlan, selectFinalPacketConsensusCandidates } from "./final-order/final-packet-consensus.js";
import {
  collectAdmittedCandidates,
  createAdmissionState,
  estimateCandidateTokens,
  recordAcceptedAdmission,
  resolveAdmission
} from "./fine-assessment-selection/admission.js";
import {
  applyFinalPacketConsensus,
  buildSelectionResult,
  createSelectionBoundary,
  materializeFineAssessmentDelivery
} from "./fine-assessment-selection/consensus-result.js";
import {
  createSelectionContext,
  prepareCoverageSelection
} from "./fine-assessment-selection/coverage-order.js";
import { captureFineAssessmentPreProjection } from
  "./selection-boundary/pre-projection/observation.js";
import type {
  FineAssessmentAccumulator,
  FineAssessmentAdmissionReceipt,
  FineAssessmentCandidate,
  FineAssessmentSelectionContext,
  FineAssessmentSelectionParams,
  FineAssessmentSelectionResult
} from "./fine-assessment-selection/types.js";

export type {
  FineAssessmentAdmissionReceipt,
  FineAssessmentCandidate,
  FineAssessmentSelectionContext,
  FineAssessmentSelectionParams,
  FineAssessmentSelectionResult
} from "./fine-assessment-selection/types.js";

export function selectFineAssessmentCandidates(
  params: FineAssessmentSelectionParams
): FineAssessmentSelectionResult {
  const boundaryCapture = createSelectionBoundary(params);
  const selectionParams = boundaryCapture?.params ?? params;
  const context = createSelectionContext(selectionParams);
  const { coverageOrdered, evictions, evictionWitnessByCandidateKey } =
    prepareCoverageSelection(selectionParams, context);
  const evidenceHead = selectBoundedDirectEvidenceHead(
    coverageOrdered, context.supplementaryData.queryProbes,
    context.supplementaryData.evidenceSemanticScoresByCandidateKey,
    context.finalRelevanceByCandidateKey,
    context.config.budgets.max_entries, evictions,
    (candidates) => collectAdmittedCandidates(candidates, context, evictions),
    (candidate) => context.answerSupportByCandidateKey.get(
      candidate.fusion.candidate_key)?.authority?.behavior_eligible === true
  );
  const finalAccumulator = reduceFineAssessmentCandidates(
    evidenceHead.candidates,
    context,
    evictions,
    context.capturePreProjection ? evictionWitnessByCandidateKey : undefined
  );
  const preProjection = boundaryCapture === undefined
    ? undefined
    : captureFineAssessmentPreProjection(finalAccumulator);
  const finalOrder = selectionParams.finalOrderAfterCoverage ?? "coverage";
  const delivered = materializeFineAssessmentDelivery(
    finalAccumulator,
    evidenceHead,
    context,
    finalOrder,
    selectionParams.maxHeadDropAfterCoverage
  );
  const { consensus, result } = resolveSelectionConsensus(
    evidenceHead,
    delivered,
    context,
    evictions
  );
  return buildSelectionResult(
    selectionParams,
    consensus,
    result,
    boundaryCapture?.tokenEstimatesByContent,
    preProjection
  );
}

function resolveSelectionConsensus(
  evidenceHead: DirectEvidenceHeadSelection<FineAssessmentCandidate>,
  delivered: ReturnType<typeof materializeFineAssessmentDelivery>,
  context: FineAssessmentSelectionContext,
  evictions: ReadonlySet<string>
): Readonly<{
  consensus: ReturnType<typeof resolveFinalPacketConsensusPlan>;
  result: ReturnType<typeof applyFinalPacketConsensus>;
}> {
  const consensusCandidates = selectFinalPacketConsensusCandidates(
    evidenceHead.candidates, evidenceHead.rejectedCandidateKeys
  );
  const consensus = resolveFinalPacketConsensusPlan({
    baseline: delivered.candidates,
    sourceCandidates: consensusCandidates,
    protectedCandidates: evidenceHead.protections,
    behaviorGuardFullAbort: delivered.candidates.some((candidate) =>
      context.answerSupportByCandidateKey.get(
        buildRecallCandidateSelectionKey(candidate)
      )?.authority?.behavior_eligible === true
    )
  });
  const consensusResult = applyFinalPacketConsensus(
    consensus,
    delivered,
    consensusCandidates,
    context,
    evictions,
    reduceFineAssessmentCandidates
  );
  return Object.freeze({ consensus, result: consensusResult });
}

function reduceFineAssessmentCandidates(
  candidates: readonly FineAssessmentCandidate[],
  context: FineAssessmentSelectionContext,
  evictions: ReadonlySet<string>,
  evictionWitnessByCandidateKey?: ReadonlyMap<string, string>
): FineAssessmentAccumulator {
  return candidates.reduce(
    (accumulator, candidate, index) => appendFineAssessmentCandidate(
      accumulator,
      candidate,
      index + 1,
      context,
      evictions.has(candidate.fusion.candidate_key),
      evictionWitnessByCandidateKey
    ),
    createFineAssessmentAccumulator(
      evictionWitnessByCandidateKey !== undefined
    )
  );
}

function createFineAssessmentAccumulator(
  captureAdmissionReceipts: boolean
): FineAssessmentAccumulator {
  return {
    selected: [],
    diagnostics: [],
    admission: createAdmissionState(captureAdmissionReceipts),
    ...(captureAdmissionReceipts ? { admissionReceipts: [] } : {})
  };
}

function appendFineAssessmentCandidate(
  accumulator: FineAssessmentAccumulator,
  candidate: FineAssessmentCandidate,
  selectionOrder: number,
  context: FineAssessmentSelectionContext,
  dominanceEvicted: boolean,
  evictionWitnessByCandidateKey?: ReadonlyMap<string, string>
): FineAssessmentAccumulator {
  const candidateKey = buildRecallCandidateDedupeKey(candidate);
  if (dominanceEvicted) {
    return appendDominanceExclusion(
      accumulator, candidate, candidateKey, selectionOrder, context,
      evictionWitnessByCandidateKey
    );
  }
  const objectKey = buildRecallLogicalObjectKey(candidate);
  const admission = resolveAdmission(accumulator.admission, candidate, objectKey, context);
  recordAdmissionReceipt(accumulator, admission.receipt);
  if (admission.droppedReason !== null) {
    return appendAdmissionExclusion(
      accumulator, candidate, candidateKey, selectionOrder,
      admission.droppedReason, context
    );
  }
  const tokenEstimate = admission.tokenEstimate ?? estimateCandidateTokens(candidate, context);
  return appendAcceptedCandidate(
    accumulator, candidate, candidateKey, selectionOrder, objectKey,
    tokenEstimate, context
  );
}

function appendAcceptedCandidate(
  accumulator: FineAssessmentAccumulator,
  candidate: FineAssessmentCandidate,
  candidateKey: string,
  selectionOrder: number,
  objectKey: string,
  tokenEstimate: number,
  context: FineAssessmentSelectionContext
): FineAssessmentAccumulator {
  const finalRelevance = context.finalRelevanceByCandidateKey.get(candidateKey)
    ?? candidate.fusion.fused_score;
  const finalRelevanceSource = context.answerRelevanceRankByCandidateKey.has(candidateKey)
    ? "answer_rerank" as const
    : "fusion" as const;
  const finalScoreFactors = buildFinalScoreFactors(candidate, finalRelevance);
  const nextCandidate = buildRecallCandidate({
    candidate,
    relevanceScore: finalRelevance,
    scoreFactors: finalScoreFactors,
    finalRelevanceSource,
    tokenEstimator: context.tokenEstimator,
    tokenEstimate,
    budgets: context.config.budgets,
    index: accumulator.selected.length,
    usedTokensBeforeCandidate: accumulator.admission.totalTokens,
    governanceCeiling: isWorkspaceMemoryCandidate(candidate)
      ? context.supplementaryData.governanceCeilingByMemoryId[candidate.entry.object_id]
      : undefined
  });
  accumulator.selected.push(nextCandidate);
  accumulator.diagnostics.push(createFineAssessmentDiagnostic(
    candidate, candidateKey, selectionOrder, accumulator.selected.length, null, context
  ));
  recordAcceptedAdmission(accumulator.admission, candidate, objectKey, tokenEstimate);
  return accumulator;
}

function appendDominanceExclusion(
  accumulator: FineAssessmentAccumulator,
  candidate: FineAssessmentCandidate,
  candidateKey: string,
  selectionOrder: number,
  context: FineAssessmentSelectionContext,
  evictionWitnessByCandidateKey?: ReadonlyMap<string, string>
): FineAssessmentAccumulator {
  recordDominanceReceipt(
    accumulator,
    candidateKey,
    evictionWitnessByCandidateKey
  );
  return appendAdmissionExclusion(
    accumulator, candidate, candidateKey, selectionOrder,
    "embedding_head_dominance", context
  );
}

function appendAdmissionExclusion(
  accumulator: FineAssessmentAccumulator,
  candidate: FineAssessmentCandidate,
  candidateKey: string,
  selectionOrder: number,
  droppedReason: Exclude<FineAssessmentAdmissionReceipt["kind"], "retained">,
  context: FineAssessmentSelectionContext
): FineAssessmentAccumulator {
  accumulator.diagnostics.push(createFineAssessmentDiagnostic(
    candidate, candidateKey, selectionOrder, null, droppedReason, context
  ));
  return accumulator;
}

function recordAdmissionReceipt(
  accumulator: FineAssessmentAccumulator,
  receipt?: FineAssessmentAdmissionReceipt
): void {
  if (accumulator.admissionReceipts === undefined) return;
  if (receipt === undefined) {
    throw new Error("fine-assessment admission receipt is missing");
  }
  accumulator.admissionReceipts.push(receipt);
}

function recordDominanceReceipt(
  accumulator: FineAssessmentAccumulator,
  candidateKey: string,
  evictionWitnessByCandidateKey?: ReadonlyMap<string, string>
): void {
  if (accumulator.admissionReceipts === undefined) return;
  const dominatingCandidateKey =
    evictionWitnessByCandidateKey?.get(candidateKey);
  if (dominatingCandidateKey === undefined) {
    throw new Error("embedding eviction receipt is missing");
  }
  accumulator.admissionReceipts.push(Object.freeze({
    kind: "embedding_head_dominance",
    dominating_candidate_key: dominatingCandidateKey
  }));
}
