import type { DeliverySelectionCandidate } from "../delivery/delivery-selection.js";
import {
  buildComponentsDeepHeadAssessment,
  buildCrossEncoderAssessment,
  coldEmbeddingDeepHeadScore,
  independentEmbeddingEvidenceFormula,
  lightweightDeepHeadFormula,
  lightweightDeepHeadScore,
  nonlexicalUnitIntervalCompositionFormula
} from "./deep-head-assessment-builder.js";
import {
  answerEvidenceSignal,
  embeddingSignal
} from "./deep-head-signals.js";
import type {
  DeepHeadAssessmentParams,
  DeepHeadSupplementary,
  RecallDeepHeadAssessment
} from "./deep-head-types.js";

export type {
  RecallDeepHeadScoreSource,
  RecallDeepHeadTrace,
  RecallDeepHeadAssessment
} from "./deep-head-types.js";

export {
  combineIndependentEmbeddingEvidence,
  combineNonlexicalUnitIntervalComposition,
  hasObservedDeepHeadEmbedding
} from "./deep-head-assessment-builder.js";

/** Prefer cross-encoder scores when present; otherwise score the pruned waist. */
export function resolveDeepHeadScores(params: Readonly<{
  readonly candidates: readonly DeliverySelectionCandidate[];
  readonly answerRelevanceScores: ReadonlyMap<string, number>;
  readonly supplementaryData: DeepHeadSupplementary;
}>): ReadonlyMap<string, number> {
  if (params.answerRelevanceScores.size > 0) {
    return params.answerRelevanceScores;
  }
  return computeLightweightDeepHeadScores(
    params.candidates,
    params.supplementaryData
  );
}

export function resolveDeepHeadAssessment(
  params: DeepHeadAssessmentParams
): RecallDeepHeadAssessment {
  // Product path sets includeTraces via fine-assessment-deep-head; default off.
  const includeTraces = params.includeTraces ?? false;
  if (params.answerRelevanceScores.size > 0) {
    return buildCrossEncoderAssessment(params, includeTraces);
  }
  return buildComponentsDeepHeadAssessment(
    params.candidates,
    params.supplementaryData,
    lightweightDeepHeadFormula,
    includeTraces
  );
}

export function computeLightweightDeepHeadScores(
  candidates: readonly DeliverySelectionCandidate[],
  supplementaryData: DeepHeadSupplementary
): ReadonlyMap<string, number> {
  const embeddingObserved = candidates.some(
    (candidate) => embeddingSignal(candidate, supplementaryData) !== null
  );
  if (embeddingObserved) {
    return new Map(candidates.map((candidate) => [
      candidate.fusion.candidate_key,
      lightweightDeepHeadScore(candidate, supplementaryData)
    ]));
  }
  const agreementActive = candidates.some(
    (candidate) => answerEvidenceSignal(candidate, supplementaryData) > 0
  );
  if (!agreementActive) return new Map();
  return new Map(candidates.map((candidate) => [
    candidate.fusion.candidate_key,
    coldEmbeddingDeepHeadScore(candidate, supplementaryData)
  ]));
}

export function resolveIndependentEmbeddingEvidenceAssessment(
  params: DeepHeadAssessmentParams
): RecallDeepHeadAssessment {
  const includeTraces = params.includeTraces ?? false;
  if (params.answerRelevanceScores.size > 0) {
    return buildCrossEncoderAssessment(params, includeTraces);
  }
  return buildComponentsDeepHeadAssessment(
    params.candidates,
    params.supplementaryData,
    independentEmbeddingEvidenceFormula,
    includeTraces
  );
}

export function resolveNonlexicalUnitIntervalCompositionAssessment(
  params: DeepHeadAssessmentParams
): RecallDeepHeadAssessment {
  const includeTraces = params.includeTraces ?? false;
  if (params.answerRelevanceScores.size > 0) {
    return buildCrossEncoderAssessment(params, includeTraces);
  }
  return buildComponentsDeepHeadAssessment(
    params.candidates,
    params.supplementaryData,
    nonlexicalUnitIntervalCompositionFormula,
    includeTraces
  );
}
