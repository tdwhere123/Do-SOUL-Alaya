import type {
  SnapshotCoherenceReceiptV1,
  SnapshotLagBoundV1,
  SnapshotReadLeaseV1,
  SnapshotValidTimeDomainV1,
  SnapshotVectorV1
} from "../../../../runtime/snapshot-coherence/index.js";
import type { FourValuedWitness } from "../../witness/index.js";

export type SupportOsfStatusV1 =
  | "composed"
  | "no_match"
  | "ineligible"
  | "unavailable"
  | "rejected"
  | "absent";

export type SupportAvailability<T> =
  | Readonly<{ readonly status: "available"; readonly value: T }>
  | Readonly<{ readonly status: "unavailable"; readonly reason: string }>;

export type SupportOsfBindingV1 = Readonly<{
  readonly variable_id: string;
  readonly binding_identity: string;
  readonly semantic_identity: string;
  readonly evidence_id: string;
  readonly query_proposition_id?: string;
  readonly source_lineage_id?: string;
}>;

export type SupportFactFrameV1 = Readonly<{
  readonly semantic_identity: string;
  readonly role: string;
  readonly evidence_id?: string;
}>;

export type SupportRelationalSubjectV1 =
  | Readonly<{
      readonly kind: "path_projection";
      readonly proposition_id: string;
      readonly relation_kind: string;
    }>
  | Readonly<{
      readonly kind: "polarity" | "contradiction";
      readonly proposition_id: string;
      readonly lineage_id: string;
    }>
  | Readonly<{
      readonly kind: "supersession";
      readonly proposition_id: string;
      readonly lineage_id: string;
      readonly counterpart_proposition_id?: string;
    }>;

export type SupportRelationalSourceObservationReceiptV1 = Readonly<{
  readonly schema_version: 1;
  readonly source_owner: string;
  readonly source_observation_id: string;
  readonly source_frontier: string;
  readonly generation: string;
  readonly producer_operator_id: string;
  readonly producer_operator_version: string;
  readonly subject: SupportRelationalSubjectV1;
  readonly observation_digest: string;
}>;

export type SupportRelationalSourceVerifierV1 = Readonly<{
  readonly source_owner: string;
  readonly allowed_subject_kinds: readonly SupportRelationalSubjectV1["kind"][];
  verifySourceObservation(receipt: SupportRelationalSourceObservationReceiptV1): boolean;
}>;

export type SupportRelationalReceiptV1 = Readonly<{
  readonly schema_version: 1;
  readonly operator_id: "support_relational_receipt_v1";
  readonly query_id: string;
  readonly snapshot_digest: string;
  readonly snapshot_receipt_digest: string;
  readonly snapshot_lease_id: string;
  readonly effective_as_of: string;
  readonly transaction_frontier: string;
  readonly source_owner: string;
  readonly principal: string;
  readonly source_frontier: string;
  readonly generation: string;
  readonly producer_operator_id: string;
  readonly producer_operator_version: string;
  readonly operator_or_model_version: string;
  readonly authorized_scope: string;
  readonly lag_bound: SnapshotLagBoundV1;
  readonly view_kind: "pinned" | "captured" | "unavailable";
  readonly valid_time_domain: SnapshotValidTimeDomainV1;
  readonly source_receipt_digest: string;
  readonly source_observation: SupportRelationalSourceObservationReceiptV1;
  readonly subject: SupportRelationalSubjectV1;
  readonly receipt_digest: string;
}>;

export type SupportMaterializationOutcomeV1 =
  | Readonly<{
      readonly status: "observed";
      readonly owner: string;
      readonly source_owner: string;
      readonly receipt_digest: string;
    }>
  | Readonly<{
      readonly status: "not_observed";
      readonly owner: string;
      readonly source_owner: string;
      readonly reason: "receipt_absent" | "inactive_at_effective_as_of";
    }>
  | Readonly<{
      readonly status: "producer_unavailable";
      readonly owner: string;
      readonly source_owner: string;
      readonly reason:
        | "authority_context_absent"
        | "source_view_unavailable"
        | "source_verifier_unavailable";
    }>
  | Readonly<{
      readonly status: "malformed";
      readonly owner: string;
      readonly source_owner: string;
      readonly contract_code:
        | "receipt_digest_mismatch"
        | "snapshot_authority_mismatch"
        | "source_capability_mismatch"
        | "subject_identity_mismatch"
        | "source_observation_mismatch"
        | "valid_time_domain_mismatch";
    }>;

export type SupportSupersessionValueV1 = Readonly<{
  readonly standing: "current" | "superseded";
  readonly lineage_id: string;
  readonly proposition_id?: string;
  readonly counterpart_proposition_id?: string;
  readonly receipt?: SupportRelationalReceiptV1;
}>;

export type SupportPathReceiptV1 = Readonly<{
  readonly evidence_basis: readonly string[];
  readonly relation_kind: string;
  readonly proposition_id?: string;
  readonly strength?: number;
  readonly hop?: number;
  readonly path_count?: number;
  readonly receipt?: SupportRelationalReceiptV1;
}>;

export type SupportCandidateReceiptV1 = Readonly<{
  readonly candidate_key: string;
  readonly hypothesis_digest?: string;
  readonly osf?: Readonly<{
    readonly composition_status: SupportOsfStatusV1;
    readonly truncated: boolean;
    readonly bindings?: readonly SupportOsfBindingV1[];
  }>;
  readonly fact_frames?: readonly SupportFactFrameV1[];
  readonly answer_support?: Readonly<{
    readonly status: string;
    readonly eligible: boolean;
    readonly evidence_ref: string | null;
  }>;
  readonly evidence_ids?: readonly string[];
  readonly polarity?: SupportAvailability<Readonly<{
    readonly polarity: "positive" | "negative";
    readonly lineage_id: string;
    readonly proposition_id?: string;
    readonly receipt?: SupportRelationalReceiptV1;
  }>>;
  readonly validity?: SupportAvailability<Readonly<{
    readonly validity: "active" | "expired" | "unknown";
  }>>;
  readonly supersession?: SupportAvailability<SupportSupersessionValueV1>;
  readonly contradiction?: SupportAvailability<Readonly<{
    readonly standing: "contradicted" | "contradicting";
    readonly lineage_id: string;
    readonly proposition_id?: string;
    readonly receipt?: SupportRelationalReceiptV1;
  }>>;
  readonly temporal?: Readonly<{
    readonly event_time: string | null;
    readonly time_status: "not_requested" | "compatible" | "conflicted" | "unknown";
  }>;
  readonly path?: SupportPathReceiptV1;
  readonly f3_present?: boolean;
}>;

export type SupportPropositionObservationV1 = Readonly<{
  readonly candidate_id: string;
  readonly local_proposition_id: string;
  readonly hypothesis_digest: string | null;
  readonly witness: FourValuedWitness;
}>;

export type SupportMaterializationInputV1 = Readonly<{
  readonly query_id: string;
  readonly snapshot_digest: string;
  readonly authority_context?: Readonly<{
    readonly snapshot_vector: SnapshotVectorV1;
    readonly snapshot_receipt: SnapshotCoherenceReceiptV1;
    readonly read_lease: SnapshotReadLeaseV1;
    readonly relational_source_verifiers?: readonly SupportRelationalSourceVerifierV1[];
  }>;
  readonly candidates?: readonly SupportCandidateReceiptV1[];
}>;

export type SupportObservabilityGapV1 = Readonly<{
  readonly kind:
    | "osf_truncated"
    | "osf_unavailable"
    | "osf_no_match"
    | "osf_ineligible"
    | "osf_rejected"
    | "binding_absent"
    | "time_unknown"
    | "time_not_active"
    | "f3_absent"
    | "path_projection_not_proposition"
    | "polarity_unavailable"
    | "supersedes_open"
    | "relational_identity_mismatch"
    | "transaction_unfrozen"
    | "authority_untrusted"
    | "write_side_formation_absent";
  readonly owner: string;
  readonly detail: string;
}>;
