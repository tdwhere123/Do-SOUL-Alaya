import type { DeliverySelectionCandidate } from "../delivery/delivery-selection.js";
import {
  buildLightweightComponents,
  embeddingSignal,
  independentEmbeddingScore,
  probabilisticOr
} from "./deep-head-signals.js";
import type {
  DeepHeadAssessmentFormula,
  DeepHeadSupplementary,
  LightweightComponents,
  RecallDeepHeadAssessment,
  RecallDeepHeadScoreSource,
  RecallDeepHeadTrace
} from "./deep-head-types.js";
import { createRecallRelevanceUpperBoundReceipt } from
  "./relevance-upper-bound-receipt.js";

const LIGHTWEIGHT_OPERATOR_ID = "lightweight_deep_head_prob_or_v1";
const INDEPENDENT_EMBEDDING_OPERATOR_ID =
  "counterfactual_independent_embedding_evidence_v1";
const NONLEXICAL_OPERATOR_ID =
  "counterfactual_nonlexical_unit_interval_composition_v1";

export function hasObservedDeepHeadEmbedding(
  candidates: readonly DeliverySelectionCandidate[],
  supplementaryData: DeepHeadSupplementary
): boolean {
  return candidates.some(
    (candidate) => embeddingSignal(candidate, supplementaryData) !== null
  );
}

export function buildComponentsDeepHeadAssessment(
  candidates: readonly DeliverySelectionCandidate[],
  supplementaryData: DeepHeadSupplementary,
  formula: DeepHeadAssessmentFormula,
  includeTraces: boolean
): RecallDeepHeadAssessment {
  const components = candidates.map((candidate) =>
    buildLightweightComponents(candidate, supplementaryData)
  );
  const independentEmbeddingScores = collectIndependentEmbeddingScores(
    candidates,
    components
  );
  const embeddingObserved = components.some((item) => item.embedding !== null);
  const active = components.some((item) => formula.isActive(item));
  if (!includeTraces) {
    const scores = active
      ? new Map(candidates.map((candidate, index) => [
          candidate.fusion.candidate_key,
          formula.resolveScore(candidate, components[index]!, active)
        ]))
      : new Map<string, number>();
    return Object.freeze({
      scores,
      independentEmbeddingScores,
      traceByCandidateKey: new Map(),
      embeddingObserved,
      relevanceUpperBoundReceipt: active
        ? createRecallRelevanceUpperBoundReceipt(formula.operatorId, scores)
        : null
    });
  }
  const traces = candidates.map((candidate, index) => {
    const trace = formula.buildTrace(candidate, components[index]!, active);
    return [
      candidate.fusion.candidate_key,
      sealFormulaOperator(trace, formula.operatorId)
    ] as const;
  });
  const scores = active
    ? new Map(traces.map(([key, trace]) => [key, trace.resolved_score!]))
    : new Map<string, number>();
  return Object.freeze({
    scores,
    independentEmbeddingScores,
    traceByCandidateKey: new Map(traces),
    embeddingObserved,
    relevanceUpperBoundReceipt: active
      ? createRecallRelevanceUpperBoundReceipt(formula.operatorId, scores)
      : null
  });
}

function collectIndependentEmbeddingScores(
  candidates: readonly DeliverySelectionCandidate[],
  components: readonly LightweightComponents[]
): ReadonlyMap<string, number> {
  const scores = new Map<string, number>();
  for (let index = 0; index < candidates.length; index += 1) {
    const score = independentEmbeddingScore(components[index]!.activation);
    if (score === null) continue;
    scores.set(candidates[index]!.fusion.candidate_key, score);
  }
  return scores;
}

export const lightweightDeepHeadFormula: DeepHeadAssessmentFormula = Object.freeze({
  operatorId: LIGHTWEIGHT_OPERATOR_ID,
  isActive: (components) =>
    components.embedding !== null ||
    components.resolvedEvidence > 0 ||
    components.fusionBaselineScore !== null,
  resolveScore: (_candidate, components, active) =>
    active ? resolveLightweightScore(components)! : 0,
  buildTrace: (candidate, components, active) =>
    buildLightweightTrace(candidate, components, active, LIGHTWEIGHT_OPERATOR_ID)
});

export const independentEmbeddingEvidenceFormula: DeepHeadAssessmentFormula =
  Object.freeze({
    operatorId: INDEPENDENT_EMBEDDING_OPERATOR_ID,
    isActive: (components) =>
      components.embedding !== null || components.resolvedEvidence > 0,
    resolveScore: (_candidate, components, active) =>
      active
        ? combineIndependentEmbeddingEvidence(components.embedding, components.resolvedEvidence)
        : 0,
    buildTrace: (_candidate, components, active) =>
      buildIndependentEmbeddingEvidenceTrace(
        components,
        active,
        INDEPENDENT_EMBEDDING_OPERATOR_ID
      )
  });

export const nonlexicalUnitIntervalCompositionFormula: DeepHeadAssessmentFormula =
  Object.freeze({
    operatorId: NONLEXICAL_OPERATOR_ID,
    isActive: (components) =>
      components.embedding !== null || components.evidenceAgreement > 0,
    resolveScore: (_candidate, components, active) =>
      active
        ? combineNonlexicalUnitIntervalComposition(
          components.embedding,
          components.evidenceAgreement
        )
        : 0,
    buildTrace: (_candidate, components, active) =>
      buildNonlexicalUnitIntervalCompositionTrace(
        components,
        active,
        NONLEXICAL_OPERATOR_ID
      )
  });

export function combineIndependentEmbeddingEvidence(
  embedding: number | null,
  resolvedEvidence: number
): number {
  return embedding !== null
    ? probabilisticOr(embedding, resolvedEvidence)
    : resolvedEvidence;
}

export function combineNonlexicalUnitIntervalComposition(
  embedding: number | null,
  evidenceAgreement: number
): number {
  return embedding !== null
    ? probabilisticOr(embedding, evidenceAgreement)
    : evidenceAgreement;
}

function resolveLightweightScore(components: LightweightComponents): number | null {
  let score = components.resolvedEvidence;
  if (components.embedding !== null) {
    score = probabilisticOr(score, components.embedding);
  }
  if (components.fusionBaselineScore !== null) {
    score = probabilisticOr(score, components.fusionBaselineScore);
  }
  return score;
}

function buildLightweightTrace(
  candidate: DeliverySelectionCandidate,
  components: LightweightComponents,
  active: boolean,
  operatorId: string
): RecallDeepHeadTrace {
  if (!active) {
    return buildDeepHeadTrace(components, null, "inactive", false, operatorId);
  }
  const fusionBaselineUsed = components.fusionBaselineScore !== null;
  const resolvedScore = resolveLightweightScore(components)!;
  const scoreSource: RecallDeepHeadScoreSource = components.embedding !== null
    ? fusionBaselineUsed ? "fusion_embedding_evidence" : "embedding_evidence"
    : fusionBaselineUsed
      ? components.resolvedEvidence > 0 ? "fusion_evidence" : "field_baseline"
      : "evidence_only";
  return buildDeepHeadTrace(
    components,
    resolvedScore,
    scoreSource,
    fusionBaselineUsed,
    operatorId
  );
}

function buildIndependentEmbeddingEvidenceTrace(
  components: LightweightComponents,
  active: boolean,
  operatorId: string
): RecallDeepHeadTrace {
  if (!active) {
    return buildDeepHeadTrace(components, null, "inactive", false, operatorId);
  }
  if (components.embedding !== null) {
    return buildDeepHeadTrace(
      components,
        combineIndependentEmbeddingEvidence(
        components.embedding,
        components.resolvedEvidence
      ),
      "embedding_evidence",
      false,
      operatorId
    );
  }
  return buildDeepHeadTrace(
    components,
    combineIndependentEmbeddingEvidence(null, components.resolvedEvidence),
    "evidence_only",
    false,
    operatorId
  );
}

function buildNonlexicalUnitIntervalCompositionTrace(
  components: LightweightComponents,
  active: boolean,
  operatorId: string
): RecallDeepHeadTrace {
  const nonlexical = Object.freeze({
    ...components,
    resolvedEvidence: components.evidenceAgreement
  });
  if (!active) {
    return buildDeepHeadTrace(nonlexical, null, "inactive", false, operatorId);
  }
  if (nonlexical.embedding !== null) {
    return buildDeepHeadTrace(
      nonlexical,
      combineNonlexicalUnitIntervalComposition(
        nonlexical.embedding,
        nonlexical.evidenceAgreement
      ),
      "embedding_evidence",
      false,
      operatorId
    );
  }
  return buildDeepHeadTrace(
    nonlexical,
    combineNonlexicalUnitIntervalComposition(null, nonlexical.evidenceAgreement),
    "evidence_only",
    false,
    operatorId
  );
}

function buildDeepHeadTrace(
  components: LightweightComponents,
  resolvedScore: number | null,
  scoreSource: RecallDeepHeadScoreSource,
  fusionBaselineUsed: boolean,
  formulaOperatorId: string
): RecallDeepHeadTrace {
  return Object.freeze({
    lexical_agreement: components.lexicalAgreement,
    evidence_agreement: components.evidenceAgreement,
    resolved_evidence: components.resolvedEvidence,
    embedding_signal: components.embedding,
    fusion_baseline_used: fusionBaselineUsed,
    resolved_score: resolvedScore,
    score_source: scoreSource,
    formula_operator_id: formulaOperatorId,
    activation: components.activation,
    evidence_semantic_activation: components.evidenceSemanticActivation
  });
}

function sealFormulaOperator(
  trace: RecallDeepHeadTrace,
  operatorId: string
): RecallDeepHeadTrace {
  return Object.freeze({
    ...trace,
    formula_operator_id: operatorId
  });
}
