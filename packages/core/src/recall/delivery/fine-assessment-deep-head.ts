import {
  resolveDeepHeadAssessment,
  type RecallDeepHeadAssessment
} from "../rerank/deep-head.js";
import type { DeliverySelectionCandidate } from "./delivery-selection.js";

const EMPTY_DEEP_HEAD_SCORES: ReadonlyMap<string, number> = new Map();

export type FineAssessmentDeepHeadDelivery = Readonly<{
  readonly orderScores: ReadonlyMap<string, number>;
  readonly coverageRelevance: ReadonlyMap<string, number>;
  readonly coverageRelevanceUpperBound: RecallDeepHeadAssessment["relevanceUpperBoundReceipt"];
}>;

/** Embedding may rescore the pool; lexical/evidence deep-head must not replace fused order. */
export function composeFineAssessmentDeepHeadDelivery(
  deepHead: RecallDeepHeadAssessment
): FineAssessmentDeepHeadDelivery {
  if (!deepHead.embeddingObserved) {
    return Object.freeze({
      orderScores: EMPTY_DEEP_HEAD_SCORES,
      coverageRelevance: EMPTY_DEEP_HEAD_SCORES,
      coverageRelevanceUpperBound: null
    });
  }
  return Object.freeze({
    orderScores: deepHead.scores,
    coverageRelevance: deepHead.scores,
    coverageRelevanceUpperBound: deepHead.relevanceUpperBoundReceipt
  });
}

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
