export const DIRECT_QUERY_EVIDENCE_STREAMS = Object.freeze([
  "lexical_fts",
  "trigram_fts",
  "synthesis_fts",
  "evidence_fts",
  "entity_seed",
  "temporal_recency"
] as const);

export type DirectQueryEvidenceStream =
  (typeof DIRECT_QUERY_EVIDENCE_STREAMS)[number];

export type RecallPacketPlanDecision =
  | Readonly<{
      readonly status: "accepted";
      readonly reason:
        | "strict_tail_consensus"
        | "nested_membership_consensus";
    }>
  | Readonly<{
      readonly status: "no_op";
      readonly reason: "select_gamma_identity" | "no_finite_embedding_head" | "unchanged_consensus";
    }>
  | Readonly<{
      readonly status: "rejected";
      readonly reason:
        | "admission_infeasible"
        | "coverage_order_retained"
        | "cardinality_mismatch"
        | "protected_candidate_constraint";
    }>;

export type RecallPacketMembershipSlot = Readonly<{
  readonly slot: number;
  readonly candidate_key: string;
}>;

export type RecallPacketMembershipAuthorizationBase = Readonly<{
  readonly authorized_candidate_key: string;
  readonly satisfied_by_candidate_key: string;
  readonly satisfied_head_slot: number;
  readonly displaced_head_baseline: RecallPacketMembershipSlot | null;
  readonly evicted_packet_baseline: RecallPacketMembershipSlot | null;
}>;

export type RecallPacketMembershipAuthorization =
  | RecallPacketMembershipAuthorizationBase & Readonly<{
      readonly kind: "direct_query_evidence";
      readonly witness: Readonly<{
        readonly origin:
          | "pre_projection_requirement"
          | "proposed_head"
          | "planned_tail_opportunity";
        readonly stream: DirectQueryEvidenceStream;
        readonly rank: number;
        readonly source_proximity_rank: number | null;
        readonly source_evidence_agreement_rank: number | null;
      }>;
    }>
  | RecallPacketMembershipAuthorizationBase & Readonly<{
      readonly kind: "graph_path_opportunity";
      readonly witness: Readonly<{
        readonly graph_expansion_rank: number;
        readonly source_proximity_rank: number;
        readonly source_candidate_key: string;
        readonly target_candidate_key: string;
        readonly path_id: string;
        readonly path_source_version: string;
        readonly relation_kind: "answers_with";
      }>;
    }>
  | RecallPacketMembershipAuthorizationBase & Readonly<{
      readonly kind: "behavior_identity";
      readonly witness: Readonly<{ readonly evidence_ref: string }>;
    }>
  | RecallPacketMembershipAuthorizationBase & Readonly<{
      readonly kind: "selector_consensus";
      readonly witness: Readonly<{ readonly embedding_rank: number }>;
    }>
  | RecallPacketMembershipAuthorizationBase & Readonly<{
      readonly kind: "same_session_substitution";
      readonly witness: Readonly<{
        readonly protected_candidate_key: string;
        readonly substitute_candidate_key: string;
        readonly source_candidate_key: string;
        readonly target_candidate_key: string;
        readonly path_id: string;
        readonly path_source_version: string;
        readonly relation_kind: "answers_with";
        readonly session_key: string;
      }>;
    }>;

export type RecallPacketPlanObservation = Readonly<{
  readonly baseline_candidate_keys: readonly string[];
  readonly planned_candidate_keys: readonly string[];
  readonly actual_candidate_keys: readonly string[];
  readonly head_width: number;
  readonly baseline_head_candidate_keys: readonly string[];
  readonly embedding_head: readonly Readonly<{
    readonly candidate_key: string;
    readonly embedding_rank: number;
  }>[];
  readonly consensus_head_candidate_keys: readonly string[];
  readonly immutable_tail_candidate_keys: readonly string[];
  readonly embedding_rank_basis?:
    | "source_semantic_rrf"
    | "source_semantic_rrf_then_packet_relative";
  readonly source_semantic_intermediate_candidate_keys?: readonly string[];
  readonly packet_relative_embedding_head?: readonly Readonly<{
    readonly candidate_key: string;
    readonly embedding_rank: number;
  }>[];
  readonly tail_policy?: "head_tail_exchange" | "nested_membership_exchange";
  readonly membership_authorizations: readonly RecallPacketMembershipAuthorization[];
  readonly protected_candidates: readonly Readonly<{
    readonly candidate_key: string;
    readonly rank_limit: number;
  }>[];
  readonly decision: RecallPacketPlanDecision;
}>;
