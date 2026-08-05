import type { DeliverySelectionCandidate } from "../delivery/delivery-selection.js";
import type { RecallSupplementaryData } from "../runtime/recall-service-types.js";
import type { CandidateActivationReceipt } from
  "../scoring/candidate-semantic-activation.js";
import type { RecallEvidenceSemanticActivationReceipt } from
  "../runtime/recall-service-types.js";
import type { RecallRelevanceUpperBoundReceipt } from
  "./relevance-upper-bound-receipt.js";

export type DeepHeadSupplementary = Readonly<Pick<
  RecallSupplementaryData,
  | "queryProbes"
  | "embeddingSimilarityScores"
  | "evidenceSemanticActivationsByCandidateKey"
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
  | "field_baseline"
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
  /** Optional for replaying pre-operator-identity boundary artifacts. */
  readonly formula_operator_id?: string;
  /** Optional for replaying pre-receipt boundary artifacts. */
  readonly activation?: CandidateActivationReceipt;
  /** Optional for replaying boundaries captured before projection observations. */
  readonly evidence_semantic_activation?:
    | Readonly<RecallEvidenceSemanticActivationReceipt>
    | null;
}>;

export type RecallDeepHeadAssessment = Readonly<{
  readonly scores: ReadonlyMap<string, number>;
  readonly traceByCandidateKey: ReadonlyMap<string, RecallDeepHeadTrace>;
  readonly embeddingObserved: boolean;
  readonly relevanceUpperBoundReceipt:
    Readonly<RecallRelevanceUpperBoundReceipt> | null;
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
  readonly activation: CandidateActivationReceipt;
  readonly evidenceSemanticActivation:
    | Readonly<RecallEvidenceSemanticActivationReceipt>
    | null;
  readonly fusionBaselineEligible: boolean;
  readonly fusionBaselineScore: number | null;
}>;

export type DeepHeadAssessmentFormula = Readonly<{
  readonly operatorId: string;
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
