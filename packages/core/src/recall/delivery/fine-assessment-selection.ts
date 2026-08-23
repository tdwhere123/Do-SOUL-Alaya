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
  const binding = buildFineAssessmentSelectGammaBinding(selectionParams, context);
  const bindingCover = bindFineAssessmentBindingCover(
    selectionParams, context, binding
  );
  const walk = selectGammaWalk(
    buildSelectGammaRequest(
      selectionParams,
      context,
      selectionParams.orderedCandidates
    ),
    binding,
    bindingCover.objective
  );
  const gammaOrder = orderByDecisionKeys(selectionParams.orderedCandidates, walk);
  const selected = orderByKeys(gammaOrder, walk.selected_candidate_keys);
  const proof = prepareSelectGammaProof(
    gammaOrder, context, binding, bindingCover.objective
  );
  const accumulator = materializeSelectGammaAccumulator(
    gammaOrder,
    walk,
    context,
    boundaryCapture !== undefined
  );
  const preProjection = boundaryCapture === undefined
    ? undefined : captureFineAssessmentPreProjection(
      accumulator,
      walk.selection_receipt
    );
  const delivered = materializeFineAssessmentDelivery(accumulator, context);
  const packetObservation = buildSelectGammaPacketObservation(
    selected,
    delivered.candidates
  );
  const order = buildGammaOrderState(selectionParams, gammaOrder, walk);
  const result = buildSelectionResult(
    selectionParams,
    packetObservation,
    delivered,
    proof.objective,
    stampFineAssessmentFinalRanks(order, delivered.candidates),
    bindingCover.selectedBindingSet(walk.selected_candidate_keys),
    buildRefinementStopCertificate(delivered.candidates, proof, context),
    boundaryCapture?.tokenEstimatesByContent,
    preProjection
  );
  assertSelectGammaDeliveryOrder(result.candidates, walk, selectionParams.orderedCandidates);
  return result;
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
