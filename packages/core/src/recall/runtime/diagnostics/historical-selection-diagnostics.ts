import type { RecallEvidenceSemanticActivationReceipt } from "../recall-service-results.js";

// Historical diagnostic artifacts retain their captured shapes without a live selector.
export type CandidateActivationState =
  | "observed"
  | "absent"
  | "ineligible"
  | "invalid";

export type CandidateActivationOperatorId = "candidate_semantic_max_v1";

export type CandidateActivationObservation = Readonly<{
  readonly channel: string;
  readonly state: CandidateActivationState;
  readonly score: number | null;
}>;

export type CandidateActivationWinner = Readonly<{
  readonly channel: string;
  readonly score: number;
}>;

export type CandidateActivationReceipt = Readonly<{
  readonly schema_version: 1;
  readonly operator_id: CandidateActivationOperatorId;
  readonly state: CandidateActivationState;
  readonly score: number | null;
  readonly winner: CandidateActivationWinner | null;
  readonly observations: readonly CandidateActivationObservation[];
  readonly missing_channel_policy: "no_op";
}>;

export type FamilyGroupedScores = Readonly<{
  readonly lexical_evidence: number;
  readonly semantic: number | null;
  readonly fusion: number | null;
}>;

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
  /** Live noisy-OR omits this; published family-grouped artifacts may still carry it. */
  readonly family_scores?: FamilyGroupedScores;
  /** Optional for replaying pre-receipt boundary artifacts. */
  readonly activation?: CandidateActivationReceipt;
  /** Optional for replaying boundaries captured before projection observations. */
  readonly evidence_semantic_activation?:
    | Readonly<RecallEvidenceSemanticActivationReceipt>
    | null;
}>;
