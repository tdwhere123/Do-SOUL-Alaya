import type {
  AssociativeFactFrame,
  AssociativeFactKeyProjectionForm,
  EvidenceCapsule,
  EvidenceSearchProjection,
  FtsLaneId,
  OpenSemanticFactorFormationCapture,
  StorageTier as StorageTierType
} from "@do-soul/alaya-protocol";

export interface KeywordSearchResult {
  readonly object_id: string;
  readonly normalized_rank: number;
  readonly trigram_rank?: number;
  /** Absent only on legacy or external search ports. */
  readonly matched_fts_lanes?: readonly FtsLaneId[];
  readonly matched_projection?: RecallEvidenceSearchProjectionIdentity;
}

export interface KeywordSearchBatchQuery {
  readonly queryText: string;
  readonly limit: number;
  readonly refinement_depths?: readonly number[];
}

export type RecallEvidenceSearchProjectionIdentity = Readonly<
  Pick<EvidenceSearchProjection, "projection_id" | "projection_kind">
>;

export type RecallEvidenceSearchMatch = Readonly<{
  readonly object_id: string;
  readonly matched_projection?: RecallEvidenceSearchProjectionIdentity;
}>;

export type RecallQualifiedEvidence = Readonly<{
  readonly capsule: Readonly<EvidenceCapsule>;
  readonly verified_user_projection: boolean;
  readonly matched_projection?: Readonly<EvidenceSearchProjection>;
  readonly matched_fact_key_forms?: readonly Readonly<AssociativeFactKeyProjectionForm>[];
  readonly matched_fact_frame?: Readonly<AssociativeFactFrame>;
  readonly semantic_factor_formation?: Readonly<OpenSemanticFactorFormationCapture>;
}>;

export type KeywordSearchLaneId = FtsLaneId;
export type KeywordSearchLaneStatus =
  | "complete"
  | "truncated"
  | "unavailable"
  | "ineligible";

export interface KeywordSearchLaneObservation extends KeywordSearchResult {
  readonly object_id: string;
  readonly rank: number;
  readonly source_id?: string;
}

export interface KeywordSearchLaneReceipt {
  readonly lane: KeywordSearchLaneId;
  readonly status: KeywordSearchLaneStatus;
  readonly depth: number;
  readonly observations: readonly Readonly<KeywordSearchLaneObservation>[];
  readonly unseen_upper_bound: number | null;
}

export interface KeywordSearchFieldResult {
  readonly matches: readonly Readonly<KeywordSearchResult>[];
  readonly lanes: readonly Readonly<KeywordSearchLaneReceipt>[];
  /** Deeper views derived by the producer from the same bounded observation. */
  readonly refinement_levels?: readonly Readonly<KeywordSearchFieldRefinementLevel>[];
}

export interface KeywordSearchFieldRefinementLevel {
  readonly requested_depth: number;
  readonly matches: readonly Readonly<KeywordSearchResult>[];
  readonly lanes: readonly Readonly<KeywordSearchLaneReceipt>[];
}

export interface KeywordSearchLaneScope {
  readonly objectIds?: readonly string[];
  readonly tier?: StorageTierType;
}
