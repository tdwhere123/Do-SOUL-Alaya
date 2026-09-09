import type {
  AssociativeFactSlot,
  AssociativeFactKeyProjectionForm,
  FtsLaneId,
  MemoryEntry,
  PathAnchorRef,
  RecallCandidate,
  SoulActiveConstraint,
  SoulMemorySearchDegradationReason
} from "@do-soul/alaya-protocol";

export type SelectGammaSynthesisStatus =
  | Readonly<{ readonly status: "absent" }>
  | Readonly<{ readonly status: "ok"; readonly text: string }>
  | Readonly<{
      readonly status: "malformed" | "truncated" | "failed";
      readonly failure: string;
      readonly text?: string;
    }>;


import type { RecallDiagnostics } from "./recall-service-diagnostics.js";

/** Immutable scoring provenance prevents diagnostics from re-querying mutable path state. */
export interface PathInflowEdge {
  /** Optional only for legacy or synthetic callers; PathRelation producers populate these fields. */
  readonly pathId?: string;
  readonly relationKind?: string;
  readonly seedObjectId: string;
  readonly targetObjectId?: string;
  readonly seedAnchor?: Readonly<PathAnchorRef>;
  readonly targetAnchor?: Readonly<PathAnchorRef>;
  readonly pathSourceVersion?: string;
  readonly weight: number;
}

export type RecallPathInflowAvailability =
  | "not_observed"
  | "available"
  | "unavailable"
  | "storage_error";


export interface EvidenceSupportVector {
  readonly source_kind: "evidence_ref";
  readonly source_id: string;
  readonly support: number;
}

export interface RecallEvidenceProjectionMatchReceipt {
  readonly evidence_ref: string;
  readonly projection_kind: "owner" | "assistant_observation" | "fact_key";
  readonly projection_id: number | null;
  readonly normalized_rank: number;
  /** Absent only in legacy traces; live FTS producers bind their source lanes. */
  readonly matched_fts_lanes?: readonly FtsLaneId[];
  readonly fact_key_forms: readonly Readonly<AssociativeFactKeyProjectionForm>[];
  /** Present only for source-grounded Fact-Key projections; absent in legacy traces. */
  readonly fact_slots?: readonly Readonly<AssociativeFactSlot>[];
}

export interface RecallEvidenceSemanticProjectionReceipt {
  readonly projection_id: number | null;
  readonly projection_kind: "owner" | "fact_key";
  readonly matched_fact_key_forms: readonly Readonly<AssociativeFactKeyProjectionForm>[];
  /** Present only for source-grounded Fact-Key projections; absent in legacy traces. */
  readonly fact_slots?: readonly Readonly<AssociativeFactSlot>[];
}

export interface RecallEvidenceSemanticDocument {
  readonly evidenceRef: string;
  readonly documentIdentity: string;
  readonly content: string;
  readonly projection: Readonly<RecallEvidenceSemanticProjectionReceipt>;
}

export interface RecallEvidenceSemanticWinnerReceipt {
  readonly score: number;
  readonly evidenceObjectId: string;
  readonly documentIdentity: string;
  readonly contentHash?: string;
  readonly projection: Readonly<RecallEvidenceSemanticProjectionReceipt> | null;
}

export interface RecallEvidenceSemanticActivationReceipt {
  readonly schema_version: 1;
  readonly operator_id: "evidence_document_max_v1";
  readonly state: "observed";
  readonly score: number;
  readonly winner: Readonly<RecallEvidenceSemanticWinnerReceipt>;
  readonly observations: readonly Readonly<RecallEvidenceSemanticWinnerReceipt>[];
  readonly observation_completeness:
    | "complete"
    | "bounded_candidate_prefix"
    | "winner_only_legacy";
  readonly missing_channel_policy: "no_op";
}

export type RecallSourceMetadata = Readonly<
  Partial<Pick<MemoryEntry, "evidence_refs" | "dimension" | "scope_class">>
  & Pick<RecallCandidate, "staged_warnings">
>;

export interface RecallResult {
  readonly execution_receipt?: import("./conditional-field-execution-receipt.js").ConditionalFieldExecutionReceipt;
  readonly source_metadata?: Readonly<Record<string, RecallSourceMetadata>>;
  readonly candidates: readonly Readonly<RecallCandidate>[];
  readonly synthesis: SelectGammaSynthesisStatus;
  readonly active_constraints: readonly Readonly<SoulActiveConstraint>[];
  readonly active_constraints_count: number | null;
  readonly active_constraints_completeness?: "complete" | "incomplete";
  readonly total_scanned: number;
  readonly coarse_filter_count: number;
  readonly fine_assessment_count: number;
  readonly degradation_reason: SoulMemorySearchDegradationReason | null;
  readonly working_projection: null;
  readonly diagnostics?: Readonly<RecallDiagnostics>;
  readonly delivery_path?: "legacy" | "canonical";
  readonly capture_identity?: Readonly<{
    readonly algorithm_id: string;
    readonly version: string;
    readonly digest: string;
  }>;
  readonly ranking_authority?: "prefix_sk" | "select_gamma";
  readonly capture_execution?: Readonly<import("@do-soul/alaya-protocol").CaptureExecution>;
}
