import type { RecallDeepHeadAssessment } from "../../../rerank/deep-head.js";
import type { FineAssessmentSelectionBoundaryInput } from
  "../selection-boundary-types.js";

type CapturedOrder = NonNullable<
  FineAssessmentSelectionBoundaryInput["final_order_after_coverage"]
>;

export function assertCapturedOrderPolicy(
  input: FineAssessmentSelectionBoundaryInput,
  deepHead: RecallDeepHeadAssessment,
  _answerRelevanceScores: ReadonlyMap<string, number>,
  onMismatch: () => never
): void {
  const capturedOrder = input.final_order_after_coverage;
  const capturedDrop = input.max_head_drop_after_coverage;
  if (capturedOrder === undefined && capturedDrop === undefined) return;
  const expectedOrder = resolveCapturedOrder();
  const dropPermitted = deepHead.embeddingObserved && deepHead.scores.size > 0;
  if (capturedOrder !== expectedOrder ||
      (capturedDrop !== undefined && (!dropPermitted ||
        !Number.isSafeInteger(capturedDrop) || capturedDrop < 0))) {
    onMismatch();
  }
}

function resolveCapturedOrder(): CapturedOrder {
  return "public_relevance";
}
