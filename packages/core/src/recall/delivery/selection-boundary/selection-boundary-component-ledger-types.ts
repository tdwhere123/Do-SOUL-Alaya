import type {
  RecallDeepHeadScoreSource,
  RecallDeepHeadTrace
} from "../../rerank/deep-head.js";
import type { CandidateActivationReceipt } from
  "../../scoring/candidate-semantic-activation.js";
import type { CandidateCoverageReceipt } from
  "../fine-assessment-selection/coverage-atoms.js";
import type { RecallFusionFamilyId } from "../fusion-delivery-families.js";
import type { RecallEvidenceSemanticProjectionReceipt } from
  "../../runtime/recall-service-types.js";
import type { RecallEvidenceSemanticActivationReceipt } from
  "../../runtime/recall-service-types.js";
import type {
  FloodAxisInactiveReason,
  RecallFusionStreamContributions,
  RecallFusionStreamRanks
} from "../../runtime/recall-service-types.js";

/** Observation state before `?? 0` / clamp collapses missing and zero. */
export type ComponentSourceState =
  | "ineligible"
  | "absent"
  | "observed_zero"
  | "observed_positive"
  | "invalid";

export type ComponentSourceObservation = Readonly<{
  readonly state: ComponentSourceState;
  /** Finite raw when present; null when absent / ineligible / invalid. */
  readonly raw: number | null;
  /** clamp01(raw) when finite and eligible; null otherwise. */
  readonly unit_interval: number | null;
}>;

export type SelectedEmbeddingSource =
  | "evidence_semantic"
  | "effective_factor"
  | "object_embedding"
  | "none";

export type ComponentLedgerUnits = Readonly<{
  readonly fused_score: "flood_integrated_final";
  readonly rrf_family_contribution: "rrf_rank_ballot";
  readonly agreements: "unit_interval";
  readonly embedding_signal: "unit_interval_or_null";
  readonly flood_terms: "flood_diagnostics_scalars";
}>;

export type ComponentLedgerFloodTerms = Readonly<{
  readonly present: boolean;
  readonly R_obj: number | null;
  readonly Slice: number | null;
  readonly A_path: number | null;
  readonly B_evidence: number | null;
  readonly E_direct: number | null;
  readonly omega: number | null;
  readonly Flood: number | null;
  readonly lambda: number | null;
  readonly beta: number | null;
  readonly final_score: number | null;
  readonly slice_status: FloodAxisInactiveReason | null;
  readonly path_status: FloodAxisInactiveReason | null;
  readonly evidence_status: FloodAxisInactiveReason | null;
  readonly e_direct_status: FloodAxisInactiveReason | null;
  readonly fuel_verified: boolean | null;
}>;

export type ComponentLedgerDuplicateEvidence = Readonly<{
  readonly embedding_in_fusion_rrf: boolean;
  readonly embedding_in_deep_head: boolean;
  readonly evidence_fts_in_fusion_rrf: boolean;
  readonly evidence_fts_in_evidence_agreement: boolean;
  readonly lexical_trigram_family_max_then_geometric: true;
  /** Independence is not assumed; flood B_evidence and receipt FTS can correlate. */
  readonly flood_vs_receipt_evidence_agreement_independence_assumed: false;
}>;

export type ComponentLedgerSelectionInputs = Readonly<{
  readonly delivery_rank: number | null;
  readonly final_relevance: number | null;
  readonly coverage_relevance: number | null;
  readonly answer_relevance_rank: number | null;
  readonly final_order_after_coverage:
    | "coverage"
    | "public_relevance"
    | "delivery_rank"
    | null;
  readonly max_head_drop_after_coverage: number | null;
}>;

export type ComponentLedgerFusionSlice = Readonly<{
  readonly fused_score: number;
  readonly fused_rank: number;
  readonly stream_ranks: RecallFusionStreamRanks;
  readonly stream_contributions: RecallFusionStreamContributions;
  readonly family_contributions: Readonly<Record<RecallFusionFamilyId, number>>;
  readonly rrf_family_total: number;
  /** Family-max RRF total with embedding_similarity forced to 0. */
  readonly non_embedding_object_base: number;
  readonly embedding_rrf_contribution: number;
}>;

export type ComponentLedgerCandidate = Readonly<{
  readonly candidate_key: string;
  readonly object_id: string;
  readonly activation: CandidateActivationReceipt;
  readonly evidence_semantic_activation:
    | Readonly<RecallEvidenceSemanticActivationReceipt>
    | null;
  readonly coverage: CandidateCoverageReceipt;
  readonly sources: Readonly<{
    readonly embedding_evidence_semantic: ComponentSourceObservation;
    readonly embedding_effective_factor: ComponentSourceObservation;
    readonly embedding_object_similarity: ComponentSourceObservation;
    readonly evidence_fts: ComponentSourceObservation;
    readonly structural_candidate: ComponentSourceObservation;
    readonly structural_supplementary: ComponentSourceObservation;
    readonly source_proximity: ComponentSourceObservation;
    readonly lexical_fts: ComponentSourceObservation;
    readonly trigram_fts: ComponentSourceObservation;
  }>;
  /** Current-channel compatibility view; future operators are represented by `activation`. */
  readonly selected_embedding: Readonly<{
    readonly source: SelectedEmbeddingSource;
    readonly observation: ComponentSourceObservation;
    readonly winner: Readonly<{
      readonly score: number;
      readonly evidence_object_id: string;
      readonly document_identity: string;
      readonly projection: Readonly<RecallEvidenceSemanticProjectionReceipt> | null;
    }> | null;
  }>;
  readonly fusion: ComponentLedgerFusionSlice;
  readonly flood: ComponentLedgerFloodTerms;
  readonly evidence_agreement: number;
  readonly lexical_agreement: number;
  readonly resolved_evidence: number;
  readonly deep_head: Readonly<{
    readonly embedding_signal: number | null;
    readonly fusion_baseline_used: boolean;
    readonly resolved_score: number | null;
    readonly score_source: RecallDeepHeadScoreSource;
    readonly trace: RecallDeepHeadTrace | null;
  }>;
  readonly selection_inputs: ComponentLedgerSelectionInputs;
  readonly duplicate_evidence: ComponentLedgerDuplicateEvidence;
}>;

export type FineAssessmentComponentLedger = Readonly<{
  readonly schema_version: 1;
  readonly units: ComponentLedgerUnits;
  readonly candidates: readonly ComponentLedgerCandidate[];
}>;
