import { buildEmptyRecallFusionBreakdown } from "./fusion-delivery-scoring.js";
import { applySessionCoverageRerank } from "./fusion-delivery-session-coverage.js";
import {
  isStructuralRescueCandidate,
  reserveStructuralDeliverySlots,
  reserveSynthesisDeliverySlots,
  selectUncoveredSynthesisCapsules,
  synthesisReserveCount
} from "./fusion-delivery-synthesis-reserve.js";

// @internal test seam for delivery-reserve boundary contracts.
// see also: packages/core/src/__tests__/recall/recall-durable-fanin-delivery.test.ts.
export const recallDeliveryReserveTestInternals = Object.freeze({
  selectUncoveredSynthesisCapsules,
  reserveSynthesisDeliverySlots,
  reserveStructuralDeliverySlots,
  synthesisReserveCount,
  buildEmptyRecallFusionBreakdown,
  isStructuralRescueCandidate,
  applySessionCoverageRerank
});
