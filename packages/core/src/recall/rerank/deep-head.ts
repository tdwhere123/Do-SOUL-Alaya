import type { DeliverySelectionCandidate } from "../delivery/delivery-selection.js";
import {
  buildComponentsDeepHeadAssessment,
  independentEmbeddingEvidenceFormula,
  lightweightDeepHeadFormula,
  nonlexicalUnitIntervalCompositionFormula
} from "./deep-head-assessment-builder.js";
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
export {
  FAMILY_GROUPED_COMPOSITION_OPERATOR_ID,
  composeFamilyGroupedScore
} from "./family-grouped-composition.js";
export type {
  FamilyGroupedComposition,
  FamilyGroupedScores
} from "./family-grouped-composition.js";

export function resolveDeepHeadScores(params: Readonly<{
  readonly candidates: readonly DeliverySelectionCandidate[];
  readonly answerRelevanceScores: ReadonlyMap<string, number>;
  readonly supplementaryData: DeepHeadSupplementary;
}>): ReadonlyMap<string, number> {
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
  return buildComponentsDeepHeadAssessment(
    candidates,
    supplementaryData,
    lightweightDeepHeadFormula,
    false
  ).scores;
}

export function resolveIndependentEmbeddingEvidenceAssessment(
  params: DeepHeadAssessmentParams
): RecallDeepHeadAssessment {
  const includeTraces = params.includeTraces ?? false;
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
  return buildComponentsDeepHeadAssessment(
    params.candidates,
    params.supplementaryData,
    nonlexicalUnitIntervalCompositionFormula,
    includeTraces
  );
}
