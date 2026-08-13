import { buildRecallCandidate } from "../runtime/recall-candidate-builder.js";
import { buildRecallCandidateDedupeKey, buildRecallLogicalObjectKey, isWorkspaceMemoryCandidate } from "../runtime/recall-service-helpers.js";
import {
  selectBoundedDirectEvidenceHead
} from "./admission/direct-evidence-answer-head.js";
import { buildFinalScoreFactors, createFineAssessmentDiagnostic } from "./diagnostics/fine-assessment-diagnostics.js";
import {
  buildFinalSelectorOrder,
  fineAssessmentPacketMatchesPlannedMembership,
  resolveFinalPacketConsensusPlan
} from "./final-order/final-packet-consensus.js";
import {
  collectAdmittedCandidates,
  createAdmissionState,
  estimateCandidateTokens,
  recordAcceptedAdmission,
  resolveAdmission
} from "./fine-assessment-selection/admission.js";
import {
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
import {
  advanceFineAssessmentOrderState,
  birthFineAssessmentOrderState,
  carryFineAssessmentOrderState,
  stampFineAssessmentFinalRanks
} from "./fine-assessment-selection/order-sequence.js";
import type { FineAssessmentOrderState } from
  "./fine-assessment-selection/order-sequence.js";
import type {
  FineAssessmentAccumulator,
  FineAssessmentAdmissionReceipt,
  FineAssessmentCandidate,
  FineAssessmentSelectionContext,
  FineAssessmentSelectionParams,
  FineAssessmentSelectionResult
} from "./fine-assessment-selection/types.js";
import type { RecallAdmissionDiagnosticPass } from
  "../runtime/recall-service-diagnostics.js";
import { createRecallFieldRefinementStopCertificate } from
  "../field/refinement/field-refinement-stop-certificate.js";
import { retainVerifiedTemporalAnswerHead } from
  "./admission/answer-head/verified-temporal-answer-head.js";

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
  const coverage = prepareCanonicalCoverage(selectionParams, context);
  const promoted = applyCanonicalAdmissionPromoters(coverage.order, context);
  const selection = resolveAdmissionAwareFinalSelection(
    promoted.order,
    context,
    promoted.protections
  );
  return finalizeCanonicalSelection(
    selectionParams,
    context,
    coverage.selection,
    selection,
    boundaryCapture
  );
}

function prepareCanonicalCoverage(
  selectionParams: FineAssessmentSelectionParams,
  context: FineAssessmentSelectionContext
) {
  const deliveryOrder = birthFineAssessmentOrderState(
    selectionParams.orderedCandidates,
    selectionParams.rankByCandidateKey,
    (candidates) => collectMembershipKeys(candidates, context),
    selectionParams.packetCandidates
  );
  const coverageSelection = prepareCoverageSelection({
    ...selectionParams,
    orderedCandidates: deliveryOrder.candidates
  }, context);
  const coverageOrder = advanceFineAssessmentOrderState(
    deliveryOrder,
    coverageSelection.candidates,
    "coverage",
    collectMembershipKeys(coverageSelection.candidates, context)
  );
  return Object.freeze({ selection: coverageSelection, order: coverageOrder });
}

function applyCanonicalAdmissionPromoters(
  coverageOrder: FineAssessmentOrderState,
  context: FineAssessmentSelectionContext
) {
  const excludedCandidateKeys = new Set<string>();
  const evidenceHead = selectBoundedDirectEvidenceHead(
    coverageOrder.candidates, context.supplementaryData.queryProbes,
    context.supplementaryData.evidenceSemanticActivationsByCandidateKey,
    context.finalRelevanceByCandidateKey,
    context.config.budgets.max_entries, excludedCandidateKeys,
    (candidates) => collectAdmittedCandidates(candidates, context),
    (candidate) => context.answerSupportByCandidateKey.get(
      candidate.fusion.candidate_key)?.authority?.behavior_eligible === true,
    context.supportsSingleSemanticLeader
  );
  const evidenceOrder = evidenceHead.orderTransitions.reduce(
    (order, transition) => carryFineAssessmentOrderState(
      order,
      transition.candidates,
      transition.owner,
      collectMembershipKeys(transition.candidates, context)
    ),
    coverageOrder
  );
  const temporalHead = retainVerifiedTemporalAnswerHead({
    selection: {
      ...evidenceHead,
      candidates: evidenceOrder.candidates
    },
    queryProbes: context.supplementaryData.queryProbes,
    contextsByMemoryId:
      context.supplementaryData.verifiedUserAssertionContextsByMemoryId ?? {},
    maxEntries: context.config.budgets.max_entries,
    selectDelivered: (candidates) => collectAdmittedCandidates(candidates, context),
    keyOf: buildRecallCandidateDedupeKey
  });
  const promotedOrder = carryFineAssessmentOrderState(
    evidenceOrder,
    temporalHead.candidates,
    "verified_temporal_head",
    collectMembershipKeys(temporalHead.candidates, context)
  );
  return Object.freeze({
    order: promotedOrder,
    protections: temporalHead.protections
  });
}

function finalizeCanonicalSelection(
  selectionParams: FineAssessmentSelectionParams,
  context: FineAssessmentSelectionContext,
  coverageSelection: ReturnType<typeof prepareCoverageSelection>,
  selection: ReturnType<typeof resolveAdmissionAwareFinalSelection>,
  boundaryCapture: ReturnType<typeof createSelectionBoundary>
): FineAssessmentSelectionResult {
  const finalAccumulator = reduceFineAssessmentCandidates(
    selection.order.candidates,
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
  const refinementStopCertificate = buildRefinementStopCertificate(
    delivered.candidates,
    coverageSelection.preparedSelection,
    context
  );
  return buildSelectionResult(
    selectionParams,
    selection.consensus,
    delivered,
    coverageSelection.objective,
    stampFineAssessmentFinalRanks(
      selection.order,
      delivered.candidates
    ),
    refinementStopCertificate,
    boundaryCapture?.tokenEstimatesByContent,
    preProjection
  );
}

function buildRefinementStopCertificate(
  delivered: ReturnType<typeof materializeFineAssessmentDelivery>["candidates"],
  preparedSelection: ReturnType<typeof prepareCoverageSelection>["preparedSelection"],
  context: FineAssessmentSelectionContext
) {
  const fieldSeal = context.supplementaryData.retrievalFieldSeal;
  const refinementReceipts =
    context.supplementaryData.retrievalFieldRefinementReceipts;
  if (fieldSeal === undefined || refinementReceipts === undefined ||
      refinementReceipts.length === 0) return undefined;
  return createRecallFieldRefinementStopCertificate({
    fieldSeal,
    refinementReceipts,
    preparedSelection,
    selectedCandidateKeys: delivered.map((candidate) =>
      buildRecallCandidateDedupeKey({
        entry: { object_id: candidate.object_id },
        originPlane: candidate.origin_plane,
        objectKind: candidate.object_kind
      })),
    supplementaryData: context.supplementaryData,
    relevanceUpperBound: context.coverageRelevanceUpperBound
  });
}

function resolveAdmissionAwareFinalSelection(
  order: FineAssessmentOrderState,
  context: FineAssessmentSelectionContext,
  protectedCandidates: Parameters<typeof resolveFinalPacketConsensusPlan>[0]["protectedCandidates"]
) {
  const consensus = resolveFinalPacketConsensusPlan({
    baseline: collectAdmittedCandidates(order.candidates, context),
    sourceCandidates: order.birthCandidates,
    protectedCandidates,
    supportsSingleSemanticLeader: context.supportsSingleSemanticLeader,
    evidenceSemanticActivationsByCandidateKey:
      context.supplementaryData.evidenceSemanticActivationsByCandidateKey
  });
  const proposedOrder = buildFinalSelectorOrder(consensus, order.candidates);
  if (consensus.decision.status !== "accepted") {
    return Object.freeze({
      consensus,
      order: advanceFineAssessmentOrderState(
        order,
        proposedOrder,
        "consensus",
        collectMembershipKeys(proposedOrder, context)
      )
    });
  }
  const feasiblePacket = collectAdmittedCandidates(proposedOrder, context);
  const finalCandidates = fineAssessmentPacketMatchesPlannedMembership(
    consensus,
    feasiblePacket
  )
    ? proposedOrder
    : order.candidates;
  return Object.freeze({
    consensus,
    order: advanceFineAssessmentOrderState(
      order,
      finalCandidates,
      "consensus",
      collectMembershipKeys(finalCandidates, context)
    )
  });
}

function collectMembershipKeys(
  candidates: readonly FineAssessmentCandidate[],
  context: FineAssessmentSelectionContext
): readonly string[] {
  return Object.freeze(collectAdmittedCandidates(candidates, context).map(
    (candidate) => candidate.fusion.candidate_key
  ));
}

function reduceFineAssessmentCandidates(
  candidates: readonly FineAssessmentCandidate[],
  context: FineAssessmentSelectionContext,
  captureAdmissionReceipts = false,
  admissionPass: RecallAdmissionDiagnosticPass = "final_selector"
): FineAssessmentAccumulator {
  return candidates.reduce(
    (accumulator, candidate, index) => appendFineAssessmentCandidate(
      accumulator,
      candidate,
      index + 1,
      context,
      admissionPass
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
  context: FineAssessmentSelectionContext,
  admissionPass: RecallAdmissionDiagnosticPass
): FineAssessmentAccumulator {
  const candidateKey = buildRecallCandidateDedupeKey(candidate);
  const objectKey = buildRecallLogicalObjectKey(candidate);
  const admission = resolveAdmission(accumulator.admission, candidate, objectKey, context);
  recordAdmissionReceipt(accumulator, admission.receipt);
  if (admission.droppedReason !== null) {
    return appendAdmissionExclusion(
      accumulator, candidate, candidateKey, selectionOrder,
      admission.droppedReason, context, admissionPass
    );
  }
  const tokenEstimate = admission.tokenEstimate ?? estimateCandidateTokens(candidate, context);
  return appendAcceptedCandidate(
    accumulator, candidate, candidateKey, selectionOrder, objectKey,
    tokenEstimate, context, admissionPass
  );
}

function appendAcceptedCandidate(
  accumulator: FineAssessmentAccumulator,
  candidate: FineAssessmentCandidate,
  candidateKey: string,
  selectionOrder: number,
  objectKey: string,
  tokenEstimate: number,
  context: FineAssessmentSelectionContext,
  admissionPass: RecallAdmissionDiagnosticPass
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
    candidate, candidateKey, selectionOrder, accumulator.selected.length, null,
    context, admissionPass
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
  context: FineAssessmentSelectionContext,
  admissionPass: RecallAdmissionDiagnosticPass
): FineAssessmentAccumulator {
  accumulator.diagnostics.push(createFineAssessmentDiagnostic(
    candidate, candidateKey, selectionOrder, null, droppedReason,
    context, admissionPass
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
