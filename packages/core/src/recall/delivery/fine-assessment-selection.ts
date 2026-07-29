import { buildRecallCandidate, buildRecallCandidateSelectionKey } from "../runtime/recall-candidate-builder.js";
import { buildRecallCandidateDedupeKey, buildRecallLogicalObjectKey, isWorkspaceMemoryCandidate } from "../runtime/recall-service-helpers.js";
import { selectBoundedDirectEvidenceHead } from "./admission/direct-evidence-answer-head.js";
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
import type {
  FineAssessmentAccumulator,
  FineAssessmentCandidate,
  FineAssessmentSelectionContext,
  FineAssessmentSelectionParams,
  FineAssessmentSelectionResult
} from "./fine-assessment-selection/types.js";

export type {
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
  const { coverageOrdered, evictions } =
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
    evidenceHead.candidates, context, evictions
  );
  const finalOrder = selectionParams.finalOrderAfterCoverage ?? "coverage";
  const delivered = materializeFineAssessmentDelivery(
    finalAccumulator,
    evidenceHead,
    context,
    finalOrder,
    selectionParams.maxHeadDropAfterCoverage
  );
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
  return buildSelectionResult(
    selectionParams,
    consensus,
    consensusResult,
    boundaryCapture?.tokenEstimatesByContent
  );
}

function reduceFineAssessmentCandidates(
  candidates: readonly FineAssessmentCandidate[],
  context: FineAssessmentSelectionContext,
  evictions: ReadonlySet<string>
): FineAssessmentAccumulator {
  return candidates.reduce(
    (accumulator, candidate, index) => appendFineAssessmentCandidate(
      accumulator,
      candidate,
      index + 1,
      context,
      evictions.has(candidate.fusion.candidate_key)
    ),
    createFineAssessmentAccumulator()
  );
}

function createFineAssessmentAccumulator(): FineAssessmentAccumulator {
  return {
    selected: [],
    diagnostics: [],
    admission: createAdmissionState()
  };
}

function appendFineAssessmentCandidate(
  accumulator: FineAssessmentAccumulator,
  candidate: FineAssessmentCandidate,
  selectionOrder: number,
  context: FineAssessmentSelectionContext,
  dominanceEvicted: boolean
): FineAssessmentAccumulator {
  const candidateKey = buildRecallCandidateDedupeKey(candidate);
  if (dominanceEvicted) {
    accumulator.diagnostics.push(createFineAssessmentDiagnostic(
      candidate, candidateKey, selectionOrder, null, "embedding_head_dominance", context
    ));
    return accumulator;
  }
  const objectKey = buildRecallLogicalObjectKey(candidate);
  const admission = resolveAdmission(accumulator.admission, candidate, objectKey, context);
  if (admission.droppedReason !== null) {
    accumulator.diagnostics.push(createFineAssessmentDiagnostic(
      candidate, candidateKey, selectionOrder, null, admission.droppedReason, context
    ));
    return accumulator;
  }
  const tokenEstimate = admission.tokenEstimate ?? estimateCandidateTokens(candidate, context);
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
