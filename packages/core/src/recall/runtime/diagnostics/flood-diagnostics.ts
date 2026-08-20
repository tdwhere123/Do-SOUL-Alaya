export type FloodAxisInactiveReason =
  | "active"
  | "inactive:no_fuel"
  | "inactive:no_slice"
  | "inactive:no_slice_match"
  | "inactive:no_path"
  | "inactive:no_evidence"
  | "inactive:pass_through"
  | "inactive:not_applicable"
  | "inactive:index_unavailable"
  | "inactive:storage_error";

export const RECALL_FLOOD_EDGE_REASONS = [
  "transferred",
  "capped",
  "self_loop",
  "missing_edge_provenance",
  "missing_or_zero_input",
  "non_positive_conductance",
  "no_slice_match"
] as const;

export interface RecallFloodEdgeTraceV1 {
  readonly schema_version: 1;
  readonly path_id: string;
  readonly relation_kind: string;
  readonly seed_object_id: string;
  readonly target_object_id: string;
  readonly input_potential: number;
  readonly edge_conductance: number;
  readonly slice_compatibility:
    | "not_evaluated"
    | "no_query_key"
    | "missing_source_key"
    | "missing_target_key"
    | "missing_source_and_target_key"
    | "no_slice_match"
    | "slice_match";
  readonly raw_transfer: number;
  readonly capped_transfer: number;
  readonly decision: "transferred" | "rejected";
  readonly reason: typeof RECALL_FLOOD_EDGE_REASONS[number];
}

export interface RecallFloodH1TransitionCounts {
  readonly evaluated_edge_count: number;
  readonly seed_overlap_edge_count: number;
  readonly transferred_edge_count: number;
  readonly rejected_edge_count: number;
  readonly reason_counts: Readonly<
    Record<RecallFloodEdgeTraceV1["reason"], number>
  >;
}

export interface IntegratedFloodCandidateDiagnostics {
  readonly R_obj: number;
  readonly Slice: number;
  readonly A_path: number;
  readonly B_evidence: number;
  readonly E_direct: number;
  readonly omega: number;
  readonly Flood: number;
  readonly lambda: number;
  readonly beta: number;
  readonly final_score: number;
  readonly slice_status: FloodAxisInactiveReason;
  readonly path_status: FloodAxisInactiveReason;
  readonly evidence_status: FloodAxisInactiveReason;
  readonly e_direct_status: FloodAxisInactiveReason;
  readonly fuel_verified: boolean;
  readonly edge_traces?: readonly Readonly<RecallFloodEdgeTraceV1>[];
  readonly edge_trace_truncated_count?: number;
  readonly score_mode?: "rrf_seeded_h1_max_product";
  readonly h1_max_product?: Readonly<{
    readonly schema_version: 1;
    readonly seed_basis: "rrf_family_base";
    readonly direct_potential: number;
    readonly strongest_transfer: number;
    readonly winner: "direct" | "edge";
    readonly winning_edge_trace: Readonly<RecallFloodEdgeTraceV1> | null;
    readonly frontier_admitted: boolean;
    readonly transition_counts: Readonly<RecallFloodH1TransitionCounts>;
  }>;
  readonly h1_overlay?: Readonly<{
    readonly schema_version: 1;
    readonly baseline_score: number;
    readonly edge_score: number;
    readonly final_score: number;
    readonly delta: number;
    readonly applied: boolean;
    readonly winner: "baseline" | "edge";
    readonly winning_edge_trace: Readonly<RecallFloodEdgeTraceV1> | null;
  }>;
}

export interface FloodFuelCoverageSummary {
  readonly candidates_total: number;
  readonly cold_start_count: number;
  readonly fuel_verified_count: number;
  readonly slice_active_count: number;
  readonly path_active_count: number;
  readonly evidence_active_count: number;
  readonly h1_candidate_count?: number;
  readonly h1_transferable_count?: number;
  readonly h1_edge_winner_count?: number;
  readonly h1_direct_winner_count?: number;
  readonly h1_overlay_applied_count?: number;
  readonly h1_evaluated_edge_count?: number;
  readonly h1_seed_overlap_edge_count?: number;
  readonly h1_transferred_edge_count?: number;
  readonly h1_rejected_edge_count?: number;
  readonly h1_newly_admitted_frontier_target_count?: number;
  readonly h1_reason_counts?: Readonly<
    Record<RecallFloodEdgeTraceV1["reason"], number>
  >;
}
