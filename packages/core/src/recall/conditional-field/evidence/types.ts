import type {
  ClaimLifecycleState,
  Derivation,
  PathAnchorRef,
  PathGovernanceClass,
  PathLifecycleStatus,
  Proposition,
  RelationValidity,
  SupportRecord,
  Witness
} from "@do-soul/alaya-protocol";

export const CONDITIONAL_FIELD_EVIDENCE_OPERATOR_ID = "conditional-field.evidence.v1" as const;
export const COMMON_CAUSE_PROPOSITION_KIND = "common_cause" as const;

export const ATTRIBUTABLE_CLAIM_STATUSES: ReadonlySet<ClaimLifecycleState> = new Set([
  "active",
  "contested",
  "winner"
]);

export const REFUTING_RELATION_KINDS: ReadonlySet<string> = new Set([
  "contradicts",
  "incompatible_with"
]);

export type EvidencePolarity = "supports" | "refutes";
export type EvidenceAccess = "eligible" | "ineligible" | "protected";
export type EvidenceCorrelationState =
  | "same_evidence_unit"
  | "same_source_lineage"
  | "possibly_correlated";
export type SupportWorkStatus = "complete" | "open";

export type GovernanceReason =
  | "eligible"
  | "ineligible_source"
  | "protected_source"
  | "temporal_invalid"
  | "source_revision_mismatch"
  | "identity_mismatch"
  | "path_inactive"
  | "strictly_governed"
  | "incompatible_context";

export type EvidenceIdentityContext = Readonly<{
  readonly query_id: string;
  readonly snapshot_id: string;
  readonly source_revision?: string;
  readonly source_revisions?: ReadonlyMap<string, string>;
  readonly hypothesis_id: string;
  readonly binding_context: string;
  readonly time_state: string;
  readonly jurisdiction: string;
  readonly as_of: string;
  readonly permitted_timeless_policy_ids: ReadonlySet<string>;
}>;

export type EvidenceObservation = Readonly<{
  readonly observation_id: string;
  readonly evidence_id: string;
  readonly source_id: string;
  readonly source_revision: string;
  readonly query_id: string;
  readonly snapshot_id: string;
  readonly hypothesis_id: string;
  readonly binding_context: string;
  readonly time_state: string;
  readonly jurisdiction: string;
  readonly premise_id: string;
  readonly proposition_id: string;
  readonly polarity: EvidencePolarity;
  readonly access: EvidenceAccess;
  readonly validity: RelationValidity;
  readonly as_of: string;
  readonly lineage_id: string;
  readonly independence_key: string;
  readonly association_milligrades: number;
  readonly cost: number;
  readonly path_governance?: PathGovernanceClass;
  readonly path_lifecycle?: PathLifecycleStatus;
}>;

export type WitnessTemplate = Readonly<{
  readonly witness_id: string;
  readonly premises: readonly string[];
  readonly cost: number;
}>;

export type PropositionDemand = Readonly<{
  readonly proposition: Proposition;
  readonly templates: readonly WitnessTemplate[];
}>;

export type EvidenceAssessmentInput = EvidenceIdentityContext & Readonly<{
  readonly observations: readonly EvidenceObservation[];
  readonly propositions: readonly PropositionDemand[];
  readonly work_limit: number;
}>;

export type GovernanceOutcome = Readonly<{
  readonly observation_id: string;
  readonly evidence_id: string;
  readonly admitted: boolean;
  readonly reason: GovernanceReason;
}>;

export type EvidenceCorrelationRecord = Readonly<{
  readonly left_id: string;
  readonly right_id: string;
  readonly state: EvidenceCorrelationState;
}>;

export type PolarizedWitness = Witness & Readonly<{
  readonly polarity: EvidencePolarity;
}>;

export type EvidenceAssessment = Readonly<{
  readonly query_id: string;
  readonly snapshot_id: string;
  readonly source_revision?: string;
  readonly records: readonly SupportRecord[];
  readonly polarities: Readonly<Record<string, EvidencePolarity>>;
  readonly governance: readonly GovernanceOutcome[];
  readonly explanation_ids: readonly string[];
  readonly work_status: SupportWorkStatus;
  readonly correlations: readonly EvidenceCorrelationRecord[];
  readonly derivations: readonly Derivation[];
}>;

export type RelationAssertionRead = Readonly<{
  readonly assertion_id: string;
  readonly relation_kind: string;
  readonly evidence_receipts: readonly Readonly<{
    readonly evidence_id: string;
    readonly source_event_anchor: Readonly<{
      readonly event_id: string;
      readonly event_type: string;
      readonly occurred_at: string;
    }>;
  }>[];
  readonly anchors: Readonly<{
    readonly source_anchor: PathAnchorRef;
    readonly target_anchor: PathAnchorRef;
  }>;
  readonly validity: RelationValidity;
  readonly formation_receipt?: Readonly<{
    readonly source_observations: readonly Readonly<{
      readonly source_id: string;
      readonly source_sha256: string;
    }>[];
  }>;
}>;

export type ClaimRead = Readonly<{
  readonly object_id: string;
  readonly claim_kind: string;
  readonly claim_status: ClaimLifecycleState;
  readonly proposition_digest: string;
  readonly evidence_refs: readonly string[];
  readonly source_object_refs: readonly string[];
}>;

export type OwnerObservationInput = EvidenceIdentityContext & Readonly<{
  readonly assertions: readonly RelationAssertionRead[];
  readonly claims: readonly ClaimRead[];
  readonly access: ReadonlyMap<string, EvidenceAccess>;
  readonly path_governance?: ReadonlyMap<string, PathGovernanceClass>;
  readonly path_lifecycle?: ReadonlyMap<string, PathLifecycleStatus>;
}>;
