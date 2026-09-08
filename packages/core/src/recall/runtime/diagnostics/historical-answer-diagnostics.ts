// Historical answer-support observations are data, never a query interpreter.
export type RecallAnswerShape =
  | "place"
  | "duration"
  | "count"
  | "sum"
  | "distinct_entities";

export type RecallCandidateAnswerSupportStatus =
  | "compatible"
  | "value_only"
  | "unsupported"
  | "observation_only"
  | "ineligible";

export interface RecallCandidateAnswerAuthority {
  readonly schema_version: 1;
  readonly provenance_status: "verified_user_assertion" | "unverified";
  readonly subject_status: "bound" | "conflicted" | "unknown";
  readonly target_status: "bound" | "partial" | "missing";
  readonly relation_status: "bound" | "conflicted" | "missing";
  readonly event_status: "asserted" | "prospective" | "negated" | "reversed";
  readonly time_status: "not_requested" | "compatible" | "conflicted" | "unknown";
  readonly binding_status: "unique" | "missing_or_ambiguous";
  readonly behavior_eligible: boolean;
  readonly evidence_ref: string | null;
}

export interface RecallCandidateAnswerSupport {
  readonly schema_version: 1;
  readonly shape: RecallAnswerShape;
  readonly status: RecallCandidateAnswerSupportStatus;
  readonly eligible: boolean;
  readonly value_supported: boolean;
  readonly target_supported: boolean;
  readonly relation_supported: boolean;
  readonly matched_target_terms: readonly string[];
  readonly matched_relation_terms: readonly string[];
  readonly authority?: Readonly<RecallCandidateAnswerAuthority>;
}

export type RecallAnswerSupportProjectionKind =
  | "atomic_assertion"
  | "turn_projection";

export interface RecallVerifiedUserSupportSource {
  readonly schema_version: 1;
  readonly source_role: "user";
  readonly projection_kind: RecallAnswerSupportProjectionKind;
  readonly evidence_ref: string;
  readonly support_identity: string | null;
}

export interface RecallAnswerSupportObservation {
  readonly schema_version: 1;
  readonly source_identity: string;
  readonly support_identity: string | null;
  readonly evidence_ref: string;
  readonly source_role: "user";
  readonly projection_kind: RecallAnswerSupportProjectionKind;
  readonly provenance_status:
    | "verified_user_assertion"
    | "verified_user_turn";
  readonly query_status: RecallCandidateAnswerSupportStatus | "unresolved";
  readonly event_status:
    | "asserted"
    | "prospective"
    | "negated"
    | "reversed"
    | "unknown";
  readonly time_status:
    | "not_requested"
    | "compatible"
    | "conflicted"
    | "unknown";
  readonly behavior_eligible: boolean;
}

export type RecallQueryDemandKind =
  | "ordering"
  | "temporal"
  | "lexical_term"
  | "phrase"
  | "object_id"
  | "evidence_ref"
  | "dimension"
  | "scope_class"
  | "domain_tag";

export type RecallQueryDemandPriority = "core" | "supporting";

export interface RecallQueryDemandAtom {
  readonly id: string;
  readonly kind: RecallQueryDemandKind;
  readonly value: string;
  readonly priority: RecallQueryDemandPriority;
}
