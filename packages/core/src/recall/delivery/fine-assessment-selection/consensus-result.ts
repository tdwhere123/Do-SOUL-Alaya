import {
  createSelectionBoundaryCapture,
  notifySelectionBoundaryObserver
} from "../selection-boundary/selection-boundary-capture.js";
import { materializeFinalPacket } from "../final-order/final-packet-order.js";
import type { RecallPacketPlanObservation } from
  "../packet-plan/packet-plan-observation.js";
import type {
  FineAssessmentAccumulator,
  FineAssessmentSelectionContext,
  FineAssessmentSelectionParams,
  FineAssessmentSelectionResult
} from "./types.js";
import type { FineAssessmentOrderSequence } from "./order-sequence.js";
import type { FineAssessmentPreProjectionCapture } from
  "../selection-boundary/selection-boundary-types.js";
import type { CoverageSelectionObjectiveReceipt } from "../coverage-selection.js";
import type { SelectedBindingSetReceipt } from
  "../select-gamma/binding-cover/types.js";
import type { RecallFieldRefinementStopCertificate } from
  "../../field/refinement/field-refinement-stop-certificate.js";

export function buildSelectionResult(
  params: FineAssessmentSelectionParams,
  packetObservation: RecallPacketPlanObservation,
  packet: ReturnType<typeof materializeFinalPacket>,
  coverageSelectionObjective: CoverageSelectionObjectiveReceipt,
  orderSequence: FineAssessmentOrderSequence,
  bindingSetReceipt: SelectedBindingSetReceipt,
  fieldRefinementStopCertificate?: Readonly<RecallFieldRefinementStopCertificate>,
  tokenEstimatesByContent?: ReadonlyMap<string, number>,
  preProjection?: FineAssessmentPreProjectionCapture
): FineAssessmentSelectionResult {
  const observesBoundary = params.selectionBoundaryObserver !== undefined;
  const selectionResult = Object.freeze({
    candidates: packet.candidates,
    diagnostics: packet.diagnostics,
    coverageSelectionObjective,
    binding_set_receipt: bindingSetReceipt,
    orderSequence,
    ...(fieldRefinementStopCertificate === undefined ? {} : {
      fieldRefinementStopCertificate
    }),
    ...(params.capturePacketPlanTrace === true
      ? { packetPlanObservation: packetObservation }
      : {})
  });
  if (observesBoundary && tokenEstimatesByContent !== undefined) {
    if (preProjection === undefined) {
      throw new Error("selection boundary requires a pre-projection witness");
    }
    notifySelectionBoundaryObserver(
      params,
      selectionResult,
      packetObservation,
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
