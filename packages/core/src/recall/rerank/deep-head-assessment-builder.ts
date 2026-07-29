import { clamp01 } from "../../shared/clamp.js";
import type { DeliverySelectionCandidate } from "../delivery/delivery-selection.js";
import { hasQueryEvidenceContribution } from "../scoring/query-evidence-support.js";
import {
  answerEvidenceSignal,
  buildLightweightComponents,
  embeddingSignal,
  probabilisticOr
} from "./deep-head-signals.js";
import type {
  DeepHeadAssessmentFormula,
  DeepHeadAssessmentParams,
  DeepHeadSupplementary,
  LightweightComponents,
  RecallDeepHeadAssessment,
  RecallDeepHeadScoreSource,
  RecallDeepHeadTrace
} from "./deep-head-types.js";

export function hasObservedDeepHeadEmbedding(
  candidates: readonly DeliverySelectionCandidate[],
  supplementaryData: DeepHeadSupplementary
): boolean {
  return candidates.some(
    (candidate) => embeddingSignal(candidate, supplementaryData) !== null
  );
}

export function buildCrossEncoderAssessment(
  params: DeepHeadAssessmentParams,
  includeTraces: boolean
): RecallDeepHeadAssessment {
  const embeddingObserved = hasObservedDeepHeadEmbedding(
    params.candidates,
    params.supplementaryData
  );
  if (!includeTraces) {
    return Object.freeze({
      scores: params.answerRelevanceScores,
      traceByCandidateKey: new Map(),
      embeddingObserved
    });
  }
  return Object.freeze({
    scores: params.answerRelevanceScores,
    traceByCandidateKey: new Map(params.candidates.map((candidate) => {
      const candidateKey = candidate.fusion.candidate_key;
      const scored = params.answerRelevanceScores.has(candidateKey);
      const components = buildLightweightComponents(candidate, params.supplementaryData);
      return [
        candidateKey,
        buildDeepHeadTrace(
          components,
          scored ? params.answerRelevanceScores.get(candidateKey)! : 0,
          scored ? "cross_encoder" : "cross_encoder_unscored",
          false
        )
      ];
    })),
    embeddingObserved
  });
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
  const embeddingObserved = components.some((item) => item.embedding !== null);
  const active = components.some((item) => formula.isActive(item));
  if (!includeTraces) {
    return Object.freeze({
      scores: active
        ? new Map(candidates.map((candidate, index) => [
            candidate.fusion.candidate_key,
            formula.resolveScore(candidate, components[index]!, active)
          ]))
        : new Map(),
      traceByCandidateKey: new Map(),
      embeddingObserved
    });
  }
  const traces = candidates.map((candidate, index) => [
    candidate.fusion.candidate_key,
    formula.buildTrace(candidate, components[index]!, active)
  ] as const);
  return Object.freeze({
    scores: active
      ? new Map(traces.map(([key, trace]) => [key, trace.resolved_score!]))
      : new Map(),
    traceByCandidateKey: new Map(traces),
    embeddingObserved
  });
}

export const lightweightDeepHeadFormula: DeepHeadAssessmentFormula = Object.freeze({
  isActive: (components) =>
    components.embedding !== null || components.resolvedEvidence > 0,
  resolveScore: (candidate, components, active) =>
    active ? resolveLightweightScore(candidate, components)! : 0,
  buildTrace: (candidate, components, active) =>
    buildLightweightTrace(candidate, components, active)
});

export const independentEmbeddingEvidenceFormula: DeepHeadAssessmentFormula =
  Object.freeze({
    isActive: (components) =>
      components.embedding !== null || components.resolvedEvidence > 0,
    resolveScore: (_candidate, components, active) =>
      active
        ? combineIndependentEmbeddingEvidence(components.embedding, components.resolvedEvidence)
        : 0,
    buildTrace: (_candidate, components, active) =>
      buildIndependentEmbeddingEvidenceTrace(components, active)
  });

export const nonlexicalUnitIntervalCompositionFormula: DeepHeadAssessmentFormula =
  Object.freeze({
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
      buildNonlexicalUnitIntervalCompositionTrace(components, active)
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

export function lightweightDeepHeadScore(
  candidate: DeliverySelectionCandidate,
  supplementaryData: DeepHeadSupplementary
): number {
  const embedding = embeddingSignal(candidate, supplementaryData);
  if (embedding === null) {
    return coldEmbeddingDeepHeadScore(candidate, supplementaryData);
  }
  return probabilisticOr(
    embedding,
    answerEvidenceSignal(candidate, supplementaryData)
  );
}

export function coldEmbeddingDeepHeadScore(
  candidate: DeliverySelectionCandidate,
  supplementaryData: DeepHeadSupplementary
): number {
  const answerEvidence = answerEvidenceSignal(candidate, supplementaryData);
  if (hasQueryEvidenceContribution(
    candidate.fusion.fused_rank_contribution_per_stream,
    supplementaryData.queryProbes
  )) {
    return probabilisticOr(clamp01(candidate.fusion.fused_score), answerEvidence);
  }
  return answerEvidence;
}

function resolveLightweightScore(
  candidate: DeliverySelectionCandidate,
  components: LightweightComponents
): number | null {
  if (components.embedding !== null) {
    return probabilisticOr(components.embedding, components.resolvedEvidence);
  }
  const fusionBaselineUsed = components.fusionBaselineEligible;
  return fusionBaselineUsed
    ? probabilisticOr(clamp01(candidate.fusion.fused_score), components.resolvedEvidence)
    : components.resolvedEvidence;
}

function buildLightweightTrace(
  candidate: DeliverySelectionCandidate,
  components: LightweightComponents,
  active: boolean
): RecallDeepHeadTrace {
  if (!active) {
    return buildDeepHeadTrace(components, null, "inactive", false);
  }
  if (components.embedding !== null) {
    return buildDeepHeadTrace(
      components,
      probabilisticOr(components.embedding, components.resolvedEvidence),
      "embedding_evidence",
      false
    );
  }
  const fusionBaselineUsed = components.fusionBaselineEligible;
  return buildDeepHeadTrace(
    components,
    fusionBaselineUsed
      ? probabilisticOr(clamp01(candidate.fusion.fused_score), components.resolvedEvidence)
      : components.resolvedEvidence,
    fusionBaselineUsed ? "fusion_evidence" : "evidence_only",
    fusionBaselineUsed
  );
}

function buildIndependentEmbeddingEvidenceTrace(
  components: LightweightComponents,
  active: boolean
): RecallDeepHeadTrace {
  if (!active) {
    return buildDeepHeadTrace(components, null, "inactive", false);
  }
  if (components.embedding !== null) {
    return buildDeepHeadTrace(
      components,
      combineIndependentEmbeddingEvidence(
        components.embedding,
        components.resolvedEvidence
      ),
      "embedding_evidence",
      false
    );
  }
  return buildDeepHeadTrace(
    components,
    combineIndependentEmbeddingEvidence(null, components.resolvedEvidence),
    "evidence_only",
    false
  );
}

function buildNonlexicalUnitIntervalCompositionTrace(
  components: LightweightComponents,
  active: boolean
): RecallDeepHeadTrace {
  const nonlexical = Object.freeze({
    ...components,
    resolvedEvidence: components.evidenceAgreement
  });
  if (!active) {
    return buildDeepHeadTrace(nonlexical, null, "inactive", false);
  }
  if (nonlexical.embedding !== null) {
    return buildDeepHeadTrace(
      nonlexical,
      combineNonlexicalUnitIntervalComposition(
        nonlexical.embedding,
        nonlexical.evidenceAgreement
      ),
      "embedding_evidence",
      false
    );
  }
  return buildDeepHeadTrace(
    nonlexical,
    combineNonlexicalUnitIntervalComposition(null, nonlexical.evidenceAgreement),
    "evidence_only",
    false
  );
}

function buildDeepHeadTrace(
  components: LightweightComponents,
  resolvedScore: number | null,
  scoreSource: RecallDeepHeadScoreSource,
  fusionBaselineUsed: boolean
): RecallDeepHeadTrace {
  return Object.freeze({
    lexical_agreement: components.lexicalAgreement,
    evidence_agreement: components.evidenceAgreement,
    resolved_evidence: components.resolvedEvidence,
    embedding_signal: components.embedding,
    fusion_baseline_used: fusionBaselineUsed,
    resolved_score: resolvedScore,
    score_source: scoreSource
  });
}
