import { clamp01 } from "../../shared/clamp.js";
import type { DeliverySelectionCandidate } from "../delivery/delivery-selection.js";
import type {
  RecallSupplementaryData
} from "../runtime/recall-service-types.js";
import { isWorkspaceMemoryCandidate } from "../runtime/recall-service-helpers.js";
import { readObservedUnitScore } from "../scoring/signals/observed-unit-score.js";
import { hasQueryEvidenceContribution } from "../scoring/query-evidence-support.js";

type DeepHeadSupplementary = Readonly<Pick<
  RecallSupplementaryData,
  | "queryProbes"
  | "embeddingSimilarityScores"
  | "evidenceSemanticScoresByCandidateKey"
  | "ftsRanks"
  | "trigramFtsRanks"
  | "evidenceFtsRanks"
  | "structuralScores"
  | "sourceProximityScores"
>>;

export type RecallDeepHeadScoreSource =
  | "cross_encoder"
  | "cross_encoder_unscored"
  | "embedding_evidence"
  | "fusion_evidence"
  | "evidence_only"
  | "inactive";

export type RecallDeepHeadTrace = Readonly<{
  readonly lexical_agreement: number;
  readonly evidence_agreement: number;
  readonly resolved_evidence: number;
  readonly embedding_signal: number | null;
  readonly fusion_baseline_used: boolean;
  readonly resolved_score: number | null;
  readonly score_source: RecallDeepHeadScoreSource;
}>;

export type RecallDeepHeadAssessment = Readonly<{
  readonly scores: ReadonlyMap<string, number>;
  readonly traceByCandidateKey: ReadonlyMap<string, RecallDeepHeadTrace>;
}>;

type LightweightComponents = Readonly<{
  readonly lexicalAgreement: number;
  readonly evidenceAgreement: number;
  readonly resolvedEvidence: number;
  readonly embedding: number | null;
  readonly fusionBaselineEligible: boolean;
}>;

export function hasObservedDeepHeadEmbedding(
  candidates: readonly DeliverySelectionCandidate[],
  supplementaryData: DeepHeadSupplementary
): boolean {
  return candidates.some(
    (candidate) => embeddingSignal(candidate, supplementaryData) !== null
  );
}

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

export function resolveDeepHeadAssessment(params: Readonly<{
  readonly candidates: readonly DeliverySelectionCandidate[];
  readonly answerRelevanceScores: ReadonlyMap<string, number>;
  readonly supplementaryData: DeepHeadSupplementary;
}>): RecallDeepHeadAssessment {
  if (params.answerRelevanceScores.size > 0) {
    return buildCrossEncoderAssessment(params);
  }
  return computeLightweightDeepHeadAssessment(
    params.candidates,
    params.supplementaryData
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

function buildCrossEncoderAssessment(params: Readonly<{
  readonly candidates: readonly DeliverySelectionCandidate[];
  readonly answerRelevanceScores: ReadonlyMap<string, number>;
  readonly supplementaryData: DeepHeadSupplementary;
}>): RecallDeepHeadAssessment {
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
    }))
  });
}

function computeLightweightDeepHeadAssessment(
  candidates: readonly DeliverySelectionCandidate[],
  supplementaryData: DeepHeadSupplementary
): RecallDeepHeadAssessment {
  const components = candidates.map((candidate) =>
    buildLightweightComponents(candidate, supplementaryData)
  );
  const active = components.some((item) => item.embedding !== null) ||
    components.some((item) => item.resolvedEvidence > 0);
  const traces = candidates.map((candidate, index) => [
    candidate.fusion.candidate_key,
    buildLightweightTrace(candidate, components[index]!, active)
  ] as const);
  return Object.freeze({
    scores: active
      ? new Map(traces.map(([key, trace]) => [key, trace.resolved_score!]))
      : new Map(),
    traceByCandidateKey: new Map(traces)
  });
}

function buildLightweightComponents(
  candidate: DeliverySelectionCandidate,
  supplementaryData: DeepHeadSupplementary
): LightweightComponents {
  const lexicalAgreement = lexicalAgreementSignal(candidate, supplementaryData);
  const evidenceAgreement = evidenceAgreementSignal(candidate, supplementaryData);
  return Object.freeze({
    lexicalAgreement,
    evidenceAgreement,
    resolvedEvidence: probabilisticOr(evidenceAgreement, lexicalAgreement),
    embedding: embeddingSignal(candidate, supplementaryData),
    fusionBaselineEligible: hasQueryEvidenceContribution(
      candidate.fusion.fused_rank_contribution_per_stream,
      supplementaryData.queryProbes
    )
  });
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

function lightweightDeepHeadScore(
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

function coldEmbeddingDeepHeadScore(
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

function answerEvidenceSignal(
  candidate: DeliverySelectionCandidate,
  supplementaryData: DeepHeadSupplementary
): number {
  return probabilisticOr(
    evidenceAgreementSignal(candidate, supplementaryData),
    lexicalAgreementSignal(candidate, supplementaryData)
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

function embeddingSignal(
  candidate: DeliverySelectionCandidate,
  supplementaryData: DeepHeadSupplementary
): number | null {
  const evidenceScore = readObservedUnitScore(
    supplementaryData.evidenceSemanticScoresByCandidateKey?.get(
      candidate.fusion.candidate_key
    )
  );
  if (evidenceScore !== null) return evidenceScore;
  const objectId = candidate.entry.object_id;
  const factor = readObservedUnitScore(candidate.effectiveFactors.embedding_similarity);
  if (factor !== null) return factor;
  if (!isWorkspaceMemoryCandidate(candidate)) return null;
  return readObservedUnitScore(supplementaryData.embeddingSimilarityScores[objectId]);
}

function evidenceAgreementSignal(
  candidate: DeliverySelectionCandidate,
  supplementaryData: DeepHeadSupplementary
): number {
  const canUseMemorySignals = isWorkspaceMemoryCandidate(candidate);
  const objectId = candidate.entry.object_id;
  const evidence = clamp01(
    canUseMemorySignals ? supplementaryData.evidenceFtsRanks[objectId] ?? 0 : 0
  );
  const structural = clamp01(
    candidate.structuralScore ?? (
      canUseMemorySignals ? supplementaryData.structuralScores[objectId] ?? 0 : 0
    )
  );
  const source = clamp01(
    canUseMemorySignals ? supplementaryData.sourceProximityScores[objectId] ?? 0 : 0
  );
  return Math.max(
    geometricAgreement(evidence, structural),
    geometricAgreement(evidence, source)
  );
}

function lexicalAgreementSignal(
  candidate: DeliverySelectionCandidate,
  supplementaryData: DeepHeadSupplementary
): number {
  if (!isWorkspaceMemoryCandidate(candidate)) return 0;
  const objectId = candidate.entry.object_id;
  return geometricAgreement(
    clamp01(supplementaryData.ftsRanks[objectId] ?? 0),
    clamp01(supplementaryData.trigramFtsRanks[objectId] ?? 0)
  );
}

function geometricAgreement(left: number, right: number): number {
  if (left <= 0 || right <= 0) {
    return 0;
  }
  return clamp01(Math.sqrt(left * right));
}

function probabilisticOr(left: number, right: number): number {
  return clamp01(left + right - left * right);
}
