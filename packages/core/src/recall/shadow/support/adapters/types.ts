import type {
  SnapshotCoherenceReceiptV1,
  SnapshotValidTimeDomainV1,
  SnapshotVectorV1
} from "../../../runtime/snapshot-coherence/index.js";

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

export type SupportRelationalReceiptV1 = Readonly<{
  readonly schema_version: 1;
  readonly query_id: string;
  readonly snapshot_digest: string;
  readonly snapshot_receipt_digest: string;
  readonly effective_as_of: string;
  readonly transaction_frontier: string;
  readonly producer_operator_id: string;
  readonly authorized_scope: string;
  readonly valid_time: SnapshotValidTimeDomainV1 | Readonly<{ readonly kind: "unknown" }>;
  readonly subject: SupportRelationalSubjectV1;
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

export type SupportMaterializationInputV1 = Readonly<{
  readonly query_id: string;
  readonly snapshot_digest: string;
  readonly authority_context?: Readonly<{
    readonly snapshot_vector: SnapshotVectorV1;
    readonly snapshot_receipt: SnapshotCoherenceReceiptV1;
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
