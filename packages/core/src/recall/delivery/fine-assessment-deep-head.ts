import {
  resolveDeepHeadAssessment,
  type RecallDeepHeadAssessment
} from "../rerank/deep-head.js";
import type { DeliverySelectionCandidate } from "./delivery-selection.js";

export type DeepHeadAssessmentResolver = (
  input: Readonly<{
    readonly candidates: readonly DeliverySelectionCandidate[];
    readonly answerRelevanceScores: ReadonlyMap<string, number>;
    readonly supplementaryData: Parameters<
      typeof resolveDeepHeadAssessment
    >[0]["supplementaryData"];
    readonly includeTraces?: boolean;
  }>
) => RecallDeepHeadAssessment;

/** Resolve deep-head via injected assessment; skip trace materialization off capture. */
export function resolveFineAssessmentDeepHead(
  input: Readonly<{
    readonly candidates: readonly DeliverySelectionCandidate[];
    readonly answerRelevanceScores: ReadonlyMap<string, number>;
    readonly supplementaryData: Parameters<
      typeof resolveDeepHeadAssessment
    >[0]["supplementaryData"];
    readonly captureAnswerFeatures?: boolean;
  }>,
  resolveAssessment: DeepHeadAssessmentResolver = resolveDeepHeadAssessment
): RecallDeepHeadAssessment {
  return resolveAssessment({
    candidates: input.candidates,
    answerRelevanceScores: input.answerRelevanceScores,
    supplementaryData: input.supplementaryData,
    includeTraces: input.captureAnswerFeatures === true
  });
}
