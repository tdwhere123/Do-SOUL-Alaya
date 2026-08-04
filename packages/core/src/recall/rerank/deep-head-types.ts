import type { DeliverySelectionCandidate } from "../delivery/delivery-selection.js";
import type { RecallSupplementaryData } from "../runtime/recall-service-types.js";

export type DeepHeadSupplementary = Readonly<Pick<
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
  | "fusion_embedding_evidence"
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
  readonly embeddingObserved: boolean;
}>;

export type DeepHeadAssessmentParams = Readonly<{
  readonly candidates: readonly DeliverySelectionCandidate[];
  readonly answerRelevanceScores: ReadonlyMap<string, number>;
  readonly supplementaryData: DeepHeadSupplementary;
  readonly includeTraces?: boolean;
}>;

export type LightweightComponents = Readonly<{
  readonly lexicalAgreement: number;
  readonly evidenceAgreement: number;
  readonly resolvedEvidence: number;
  readonly embedding: number | null;
  readonly fusionBaselineEligible: boolean;
  readonly fusionBaselineScore: number | null;
}>;

export type DeepHeadAssessmentFormula = Readonly<{
  readonly isActive: (components: LightweightComponents) => boolean;
  readonly resolveScore: (
    candidate: DeliverySelectionCandidate,
    components: LightweightComponents,
    active: boolean
  ) => number;
  readonly buildTrace: (
    candidate: DeliverySelectionCandidate,
    components: LightweightComponents,
    active: boolean
  ) => RecallDeepHeadTrace;
}>;
