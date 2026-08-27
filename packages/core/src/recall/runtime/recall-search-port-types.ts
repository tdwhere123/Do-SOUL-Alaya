import type {
  AssociativeFactFrame,
  AssociativeFactKeyProjectionForm,
  EvidenceCapsule,
  EvidenceFactFrameFormationCapture,
  EvidenceSearchProjection,
  FtsLaneId,
  OpenSemanticFactorFormationCapture,
  StorageTier as StorageTierType
} from "@do-soul/alaya-protocol";

export const LEXICAL_RAW_RANK_RECEIPT_ID = "alaya.recall.x0.lexical-raw-rank.v1";
export const LEXICAL_BOUND_PRODUCER_ID =
  "alaya.storage.mergeKeywordSearchRows.v1";

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
  readonly fact_frame_formation?: Readonly<EvidenceFactFrameFormationCapture>;
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
  readonly lexical_raw_rank_receipt?: Readonly<LexicalBoundProducerReceipt>;
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

export type MemoryKeywordFieldCaptureVariant =
  | "lexical_relaxed"
  | "lexical_expanded";

export type MemoryKeywordFieldCapture = Readonly<{
  readonly variant: MemoryKeywordFieldCaptureVariant;
}>;

export type LexicalBoundLaneId = KeywordLexicalLaneId;
export type LexicalBoundRawKeyKind = "matched_token_count" | "bm25_raw_rank";
export type LexicalBoundListStatus = "empty" | "complete" | "truncated";
export type LexicalUnseenFrontier =
  | number
  | Readonly<{
    readonly status: "unavailable";
    readonly reason: "producer_order_not_monotone";
  }>;

export interface LexicalBoundLaneRow {
  readonly candidate_key: string;
  readonly raw_group_key: number;
  readonly lane_index: number;
  readonly grouped_ordinal: number;
  readonly observation_state: "observed";
}

export interface LexicalBoundLaneCapture {
  readonly lane_id: LexicalBoundLaneId;
  readonly raw_key_kind: LexicalBoundRawKeyKind;
  readonly source_priority: 0 | 1 | 2;
  readonly applicability_source: "memory_fts_lane";
  readonly list_n: number;
  readonly requested_limit: number;
  readonly status: LexicalBoundListStatus;
  readonly rows: readonly LexicalBoundLaneRow[];
  readonly unseen_upper_bound: LexicalUnseenFrontier;
}

export interface LexicalBoundLaneHit {
  readonly lane_id: LexicalBoundLaneId;
  readonly raw_group_key: number;
  readonly grouped_ordinal: number;
  readonly lane_index: number;
}

export interface LexicalBoundCandidateProvenance {
  readonly candidate_key: string;
  readonly lane_hits: readonly LexicalBoundLaneHit[];
  readonly admitted: boolean;
  readonly chosen_lane_id: LexicalBoundLaneId | null;
  readonly chosen_normalized_rank: number | null;
  readonly post_merge_index: number | null;
  readonly discarded_lane_ids: readonly LexicalBoundLaneId[];
}

export interface LexicalBoundPostMergeRow {
  readonly candidate_key: string;
  readonly normalized_rank: number;
  readonly trigram_rank?: number;
  readonly object_key_rank?: number;
}

export interface LexicalBoundProducerReceipt {
  readonly schema_version: 1;
  readonly receipt_id: typeof LEXICAL_RAW_RANK_RECEIPT_ID;
  readonly producer_id: typeof LEXICAL_BOUND_PRODUCER_ID;
  readonly query_run_id: string;
  readonly merge_limit: number;
  readonly lanes: readonly LexicalBoundLaneCapture[];
  readonly candidates: readonly LexicalBoundCandidateProvenance[];
  readonly post_merge: readonly LexicalBoundPostMergeRow[];
}
