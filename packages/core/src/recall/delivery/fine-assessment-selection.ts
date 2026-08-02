import { buildRecallCandidate } from "../runtime/recall-candidate-builder.js";
import { buildRecallCandidateDedupeKey, buildRecallLogicalObjectKey, isWorkspaceMemoryCandidate } from "../runtime/recall-service-helpers.js";
import {
  selectBoundedDirectEvidenceHead,
  type DirectEvidenceHeadSelection
} from "./admission/direct-evidence-answer-head.js";
import { buildFinalScoreFactors, createFineAssessmentDiagnostic } from "./diagnostics/fine-assessment-diagnostics.js";
import { resolveFinalPacketConsensusPlan } from "./final-order/final-packet-consensus.js";
import { applyLexicographicNestedMembership } from
  "./nested-selector/nested-consensus-projection.js";
import { refineNestedFineAssessmentCandidates } from
  "./nested-selector/fine-assessment-nested-selector.js";
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
  const coverageOrdered = prepareCoverageSelection(selectionParams, context);
  const excludedCandidateKeys = new Set<string>();
  const evidenceHead = selectBoundedDirectEvidenceHead(
    coverageOrdered, context.supplementaryData.queryProbes,
    context.supplementaryData.evidenceSemanticScoresByCandidateKey,
    context.finalRelevanceByCandidateKey,
    context.config.budgets.max_entries, excludedCandidateKeys,
    (candidates) => collectAdmittedCandidates(candidates, context),
    (candidate) => context.answerSupportByCandidateKey.get(
      candidate.fusion.candidate_key)?.authority?.behavior_eligible === true
  );
  const finalAccumulator = reduceFineAssessmentCandidates(
    coverageOrdered,
    context,
    boundaryCapture !== undefined
  );
  const preProjection = boundaryCapture === undefined
    ? undefined
    : captureFineAssessmentPreProjection(finalAccumulator);
  const delivered = materializeFineAssessmentDelivery(
    finalAccumulator,
    context
  );
  const { consensus, result } = resolveSelectionConsensus(
    evidenceHead,
    finalAccumulator.selected,
    delivered,
    context,
    selectionParams.orderedCandidates
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
  preProjection: readonly Readonly<ReturnType<typeof buildRecallCandidate>>[],
  delivered: ReturnType<typeof materializeFineAssessmentDelivery>,
  context: FineAssessmentSelectionContext,
  orderedCandidates: readonly FineAssessmentCandidate[]
): Readonly<{
  consensus: ReturnType<typeof resolveFinalPacketConsensusPlan>;
  result: ReturnType<typeof applyFinalPacketConsensus>;
}> {
  // Consensus scans full H; evidence-head rejects must not hide embedding ranks.
  const membershipGovernance = context.answerRelevanceRankByCandidateKey.size > 0
    ? undefined
    : {
        preProjection,
        queryProbes: context.supplementaryData.queryProbes,
        pathInflowByTarget: pathInflowForMembership(context),
        behaviorAuthorityEvidenceRefByCandidateKey: behaviorAuthorityEvidenceRefs(
          orderedCandidates, context
        )
      };
  const incumbentConsensus = resolveFinalPacketConsensusPlan({
    baseline: delivered.candidates,
    sourceCandidates: orderedCandidates,
    protectedCandidates: evidenceHead.protections,
    membershipGovernance
  });
  const headSize = Math.min(5, incumbentConsensus.candidates.length);
  const nested = refineNestedFineAssessmentCandidates(
    orderedCandidates,
    context,
    {
      headKeys: incumbentConsensus.candidates
        .slice(0, headSize).map(({ candidateKey }) => candidateKey),
      packKeys: incumbentConsensus.candidates.map(({ candidateKey }) => candidateKey)
    }
  );
  const consensus = applyLexicographicNestedMembership({
    plan: incumbentConsensus,
    sourceCandidates: orderedCandidates,
    headKeys: nested.plan.headKeys,
    packKeys: nested.plan.packKeys,
    membershipGovernance
  });
  const consensusResult = applyFinalPacketConsensus(
    consensus,
    delivered,
    orderedCandidates,
    context,
    reduceFineAssessmentCandidates
  );
  return Object.freeze({ consensus, result: consensusResult });
}

function pathInflowForMembership(
  context: FineAssessmentSelectionContext
): FineAssessmentSelectionContext["supplementaryData"]["pathInflowByTarget"] {
  const availability = context.supplementaryData.pathInflowAvailability;
  return availability === "unavailable" || availability === "not_observed"
    ? undefined
    : context.supplementaryData.pathInflowByTarget;
}

function behaviorAuthorityEvidenceRefs(
  candidates: readonly FineAssessmentCandidate[],
  context: FineAssessmentSelectionContext
): ReadonlyMap<string, string> {
  return new Map(candidates.flatMap((candidate) => {
    const candidateKey = buildRecallCandidateDedupeKey(candidate);
    const authority = context.answerSupportByCandidateKey.get(
      candidateKey
    )?.authority;
    const evidenceRef = authority?.behavior_eligible === true
      ? authority.evidence_ref
      : null;
    return evidenceRef === null ? [] : [[candidateKey, evidenceRef] as const];
  }));
}

function reduceFineAssessmentCandidates(
  candidates: readonly FineAssessmentCandidate[],
  context: FineAssessmentSelectionContext,
  captureAdmissionReceipts = false
): FineAssessmentAccumulator {
  return candidates.reduce(
    (accumulator, candidate, index) => appendFineAssessmentCandidate(
      accumulator,
      candidate,
      index + 1,
      context
    ),
    createFineAssessmentAccumulator(
      captureAdmissionReceipts
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
  context: FineAssessmentSelectionContext
): FineAssessmentAccumulator {
  const candidateKey = buildRecallCandidateDedupeKey(candidate);
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
