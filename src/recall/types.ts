import type { MemoryEntry, ScopeClass } from "../ontology/types.js";
import type { ActivationCandidate, PathRelation } from "../structure/types.js";

export type RecallRoute = "structured" | "lexical" | "path" | "embedding" | "context_pack";
export type RecallSourcePlane = "ontology" | "structure_registry" | "runtime_projection" | "degradation";
export type RecallGovernanceState = "visible" | "hidden" | "blocked";

export interface RecallQuery {
  readonly workspace_id: string;
  readonly query_text: string;
  readonly scope_classes?: readonly ScopeClass[];
  readonly domain_tags?: readonly string[];
  readonly limit: number;
  readonly run_id?: string | null;
}

export interface RecallMemoryRecord {
  readonly memory: MemoryEntry;
  readonly governance_state?: RecallGovernanceState;
}

export interface RecallRouteContribution {
  readonly route: Exclude<RecallRoute, "context_pack">;
  readonly source_plane: RecallSourcePlane;
  readonly score: number;
  readonly reason: string;
  readonly matched_terms?: readonly string[];
  readonly path_id?: string;
  readonly relation_kind?: string;
  readonly activation_candidate_ids?: readonly string[];
  readonly similarity_score?: number;
}

export interface RecallCandidate {
  readonly object_id: string;
  readonly memory: MemoryEntry;
  readonly recall_score: number;
  readonly source_plane: "ontology";
  readonly inclusion_reason: string;
  readonly contributions: readonly RecallRouteContribution[];
}

export interface RecallExclusion {
  readonly object_id: string;
  readonly route: RecallRoute;
  readonly reason: string;
  readonly scope_class: ScopeClass;
  readonly governance_state: RecallGovernanceState;
  readonly retryable: boolean;
  readonly source_plane: RecallSourcePlane;
}

export interface RecallDegradation {
  readonly route: "lexical" | "path" | "embedding" | "context_pack";
  readonly reason: string;
  readonly provider_state?: EmbeddingProviderState;
  readonly fallback_candidate_count: number;
  readonly retryable: boolean;
}

export interface RecallMergeResult {
  readonly candidates: readonly RecallCandidate[];
  readonly exclusions: readonly RecallExclusion[];
  readonly degradations: readonly RecallDegradation[];
}

export interface RankLexicalRecallCandidatesInput {
  readonly query: RecallQuery;
  readonly records: readonly RecallMemoryRecord[];
}

export interface MergePathRecallContributionsInput {
  readonly query: RecallQuery;
  readonly baseline: readonly RecallCandidate[];
  readonly records: readonly RecallMemoryRecord[];
  readonly path_relations?: readonly PathRelation[];
  readonly activation_candidates?: readonly ActivationCandidate[];
  readonly max_path_only?: number;
}

export type EmbeddingProviderState = "disabled" | "unconfigured" | "unavailable" | "pending" | "error" | "ready";

export interface EmbeddingSupplementConfig {
  readonly enabled: boolean;
  readonly provider_state: EmbeddingProviderState;
  readonly max_supplement: number;
}

export interface EmbeddingSupplementCandidate {
  readonly object_id: string;
  readonly similarity_score: number;
  readonly reason?: string;
}

export interface ApplyEmbeddingSupplementInput {
  readonly baseline: readonly RecallCandidate[];
  readonly records: readonly RecallMemoryRecord[];
  readonly embedding: EmbeddingSupplementConfig;
  readonly supplement?: readonly EmbeddingSupplementCandidate[];
  readonly query?: RecallQuery;
}

export interface ContextPackBudget {
  readonly max_items: number;
  readonly max_tokens: number;
}

export interface ContextPackIncluded {
  readonly candidate: RecallCandidate;
  readonly inclusion_reason: string;
  readonly token_estimate: number;
  readonly source_planes: readonly RecallSourcePlane[];
}

export interface ContextPackDeliveryMetadata {
  readonly counts_as_usage_proof: false;
  readonly delivered_candidate_count: number;
  readonly excluded_candidate_count: number;
}

export interface ContextPack {
  readonly pack_id: string;
  readonly workspace_id: string;
  readonly source_planes: readonly RecallSourcePlane[];
  readonly durable_truth: false;
  readonly included: readonly ContextPackIncluded[];
  readonly excluded: readonly RecallExclusion[];
  readonly degradations: readonly RecallDegradation[];
  readonly budget: ContextPackBudget;
  readonly total_token_estimate: number;
  readonly delivery_text: string;
  readonly delivery_metadata: ContextPackDeliveryMetadata;
}

export interface AssembleContextPackInput {
  readonly pack_id: string;
  readonly query: RecallQuery;
  readonly candidates: readonly RecallCandidate[];
  readonly exclusions?: readonly RecallExclusion[];
  readonly degradations?: readonly RecallDegradation[];
  readonly budget: ContextPackBudget;
}
