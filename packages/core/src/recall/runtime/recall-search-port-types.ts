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
  readonly object_key_rank?: number;
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
  readonly kind_projection_drafts?: readonly Readonly<{
    readonly factor_id: string;
    readonly kind_values: readonly string[];
  }>[];
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

export type KeywordLexicalLaneId =
  | "exact"
  | "porter"
  | "trigram"
  | "object_key_porter"
  | "object_key_trigram";

export interface KeywordLexicalMergeCapture {
  readonly query_run_id: string;
  readonly merge_limit: number;
  readonly lanes: readonly Readonly<{
    readonly lane_id: KeywordLexicalLaneId;
    readonly raw_key_kind: "matched_token_count" | "bm25_raw_rank";
    readonly list_n: number;
    readonly status: "empty" | "complete" | "truncated";
  }>[];
  readonly candidates: readonly Readonly<{
    readonly candidate_key: string;
    readonly chosen_lane_id: KeywordLexicalLaneId | null;
    readonly chosen_normalized_rank: number | null;
    readonly admitted: boolean;
  }>[];
}

export interface KeywordSearchFieldResult {
  readonly matches: readonly Readonly<KeywordSearchResult>[];
  readonly lanes: readonly Readonly<KeywordSearchLaneReceipt>[];
  readonly lexical_raw_rank?: Readonly<KeywordLexicalMergeCapture>;
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
