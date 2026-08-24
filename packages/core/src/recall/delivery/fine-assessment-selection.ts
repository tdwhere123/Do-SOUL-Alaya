import { buildRecallCandidateDedupeKey } from
  "../runtime/recall-service-helpers.js";
import { createRecallFieldRefinementStopCertificate } from
  "../field/refinement/field-refinement-stop-certificate.js";
import {
  buildFineAssessmentSelectGammaBinding,
  buildSelectGammaRequest
} from "./select-gamma/bind-fine-assessment.js";
import { bindFineAssessmentBindingCover } from
  "./select-gamma/binding-cover/production.js";
import { buildSelectGammaPacketObservation } from
  "./select-gamma/packet-observation.js";
import { prepareSelectGammaProof } from
  "./select-gamma/proof-objective.js";
import { selectGammaWalk } from "./select-gamma/select-gamma.js";
import type { SelectGammaWalkResult } from "./select-gamma/types.js";
import {
  buildSelectionResult,
  createSelectionBoundary,
  materializeFineAssessmentDelivery
} from "./fine-assessment-selection/consensus-result.js";
import { createSelectionContext } from
  "./fine-assessment-selection/coverage-order.js";
import { materializeSelectGammaAccumulator } from
  "./fine-assessment-selection/gamma-delivery.js";
import {
  birthFineAssessmentOrderState,
  recordSelectGammaOrder,
  stampFineAssessmentFinalRanks
} from "./fine-assessment-selection/order-sequence.js";
import { captureFineAssessmentPreProjection } from
  "./selection-boundary/pre-projection/observation.js";
import type {
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
  const session = runSelectGammaSession(selectionParams, context);
  const accumulator = materializeSelectGammaAccumulator(
    session.gammaOrder,
    session.walk,
    context,
    boundaryCapture !== undefined
  );
  const delivered = materializeFineAssessmentDelivery(accumulator, context);
  const result = buildSelectionResult(
    selectionParams,
    buildSelectGammaPacketObservation(
      orderByKeys(session.gammaOrder, session.walk.selected_candidate_keys),
      delivered.candidates
    ),
    delivered,
    session.proof.objective,
    stampFineAssessmentFinalRanks(
      buildGammaOrderState(selectionParams, session.gammaOrder, session.walk),
      delivered.candidates
    ),
    session.bindingCover.selectedBindingSet(session.walk.selected_candidate_keys),
    buildRefinementStopCertificate(delivered.candidates, session.proof, context),
    boundaryCapture?.tokenEstimatesByContent,
    boundaryCapture === undefined
      ? undefined
      : captureFineAssessmentPreProjection(accumulator, session.walk.selection_receipt)
  );
  assertSelectGammaDeliveryOrder(
    result.candidates, session.walk, selectionParams.orderedCandidates
  );
  return result;
}

function runSelectGammaSession(
  params: FineAssessmentSelectionParams,
  context: FineAssessmentSelectionContext
) {
  const binding = buildFineAssessmentSelectGammaBinding(params, context);
  const bindingCover = bindFineAssessmentBindingCover(params, context, binding);
  const walk = selectGammaWalk(
    buildSelectGammaRequest(params, context, params.orderedCandidates),
    binding,
    bindingCover.objective
  );
  const gammaOrder = orderByDecisionKeys(params.orderedCandidates, walk);
  return Object.freeze({
    bindingCover,
    walk,
    gammaOrder,
    proof: prepareSelectGammaProof(gammaOrder, context, binding, bindingCover.objective)
  });
}

function buildGammaOrderState(
  params: FineAssessmentSelectionParams,
  gammaOrder: readonly FineAssessmentCandidate[],
  walk: SelectGammaWalkResult
) {
  const birth = birthFineAssessmentOrderState(
    params.orderedCandidates,
    params.rankByCandidateKey,
    params.packetCandidates
  );
  return recordSelectGammaOrder(
    birth,
    gammaOrder,
    walk.selected_candidate_keys
  );
}

function buildRefinementStopCertificate(
  delivered: ReturnType<typeof materializeFineAssessmentDelivery>["candidates"],
  proof: ReturnType<typeof prepareSelectGammaProof>,
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
    preparedSelection: proof.preparedSelection,
    selectionCapacity: context.config.budgets.max_entries,
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

function orderByDecisionKeys(
  candidates: readonly FineAssessmentCandidate[],
  walk: SelectGammaWalkResult
): readonly FineAssessmentCandidate[] {
  return orderByKeys(candidates, walk.decisions.map(({ candidate_key }) => candidate_key));
}

function orderByKeys(
  candidates: readonly FineAssessmentCandidate[],
  keys: readonly string[]
): readonly FineAssessmentCandidate[] {
  const byKey = new Map(candidates.map((candidate) => [
    candidate.fusion.candidate_key,
    candidate
  ]));
  return Object.freeze(keys.map((key) => {
    const candidate = byKey.get(key);
    if (candidate === undefined) {
      throw new Error("Select_Gamma selected an unknown candidate key");
    }
    return candidate;
  }));
}

function assertSelectGammaDeliveryOrder(
  delivered: FineAssessmentSelectionResult["candidates"],
  walk: SelectGammaWalkResult,
  source: readonly FineAssessmentCandidate[]
): void {
  const byKey = new Map(source.map((candidate) => [
    candidate.fusion.candidate_key,
    candidate.entry.object_id
  ]));
  const selectedIds = walk.selected_candidate_keys.map((key) => byKey.get(key));
  const deliveredIds = delivered.map((candidate) => candidate.object_id);
  if (selectedIds.some((id) => id === undefined) ||
      deliveredIds.length !== selectedIds.length ||
      deliveredIds.some((id, index) => id !== selectedIds[index])) {
    throw new Error("Select_Gamma admission order must be the delivery order");
  }
}
