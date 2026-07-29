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
  }>
) => RecallDeepHeadAssessment;

/**
 * Capture-on keeps traces; capture-off keeps scores only.
 * One gate for live, composition, and counterfactual assessment paths.
 */
export function gateDeepHeadAssessment(
  assessment: RecallDeepHeadAssessment,
  captureAnswerFeatures?: boolean
): RecallDeepHeadAssessment {
  if (captureAnswerFeatures === true) return assessment;
  return Object.freeze({
    scores: assessment.scores,
    traceByCandidateKey: new Map()
  });
}

/** Resolve deep-head via injected assessment, then apply the capture gate. */
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
  return gateDeepHeadAssessment(
    resolveAssessment({
      candidates: input.candidates,
      answerRelevanceScores: input.answerRelevanceScores,
      supplementaryData: input.supplementaryData
    }),
    input.captureAnswerFeatures
  );
}
