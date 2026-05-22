import type {
  BudgetSnapshot,
  EventLogEntry,
  EvidenceCapsule,
  MemoryDimension as MemoryDimensionType,
  MemoryEntry,
  MemoryGraphEdge,
  MemoryGraphEdgeTypeValue,
  PathAnchorRef,
  PathRelation,
  ProjectMappingAnchor,
  RecallCandidate,
  RecallScoreFactors,
  RecallOriginPlane,
  SoulActiveConstraint,
  SoulRecallHostContext,
  SoulRecallTokenizerHint,
  SoulMemorySearchDegradationReason,
  Slot,
  StorageTier as StorageTierType,
  SynthesisCapsule
} from "@do-soul/alaya-protocol";
import type { ScopeClass } from "@do-soul/alaya-protocol";
import type {
  EmbeddingRecallSupplementResult,
  PreparedEmbeddingSupplement,
  PreparedEmbeddingQueryHandle
} from "./embedding-recall-service.js";
import type {
  ManifestationBiasSidecarEntry
} from "./manifestation-resolver.js";
import type {
  GlobalMemoryRecallCachePort,
  GlobalMemoryRecallPort
} from "./global-memory-recall-port.js";

export interface KeywordSearchResult {
  readonly object_id: string;
  readonly normalized_rank: number;
}

export interface RecallServiceMemoryRepoPort {
  findByWorkspaceId(workspaceId: string, tier?: StorageTierType): Promise<readonly Readonly<MemoryEntry>[]>;
  findByDimension(workspaceId: string, dimension: MemoryDimensionType): Promise<readonly Readonly<MemoryEntry>[]>;
  findByScopeClass(workspaceId: string, scopeClass: ScopeClass): Promise<readonly Readonly<MemoryEntry>[]>;
  searchByKeyword?(workspaceId: string, queryText: string, limit: number): Promise<readonly KeywordSearchResult[]>;
  searchByKeywordWithinObjectIds?(
    workspaceId: string,
    queryText: string,
    limit: number,
    objectIds: readonly string[]
  ): Promise<readonly KeywordSearchResult[]>;
  // see also: 068-evidence-capsule-fts.sql. Used by lexical plane to admit
  // memories whose distilled content lost keywords but whose underlying
  // EvidenceCapsule.gist still matches the query.
  findByEvidenceRefs?(
    workspaceId: string,
    evidenceObjectIds: readonly string[]
  ): Promise<readonly Readonly<MemoryEntry>[]>;
}

// Evidence FTS port consumed by the recall service. The implementing repo
// is SqliteEvidenceCapsuleRepo (migration 068). Recall uses this only to
// widen lexical candidate generation when distillation drops keywords.
export interface RecallServiceEvidenceSearchPort {
  searchByKeyword(
    workspaceId: string,
    queryText: string,
    limit: number
  ): Promise<readonly KeywordSearchResult[]>;
  findByIds?(
    workspaceId: string,
    evidenceObjectIds: readonly string[]
  ): Promise<readonly Readonly<EvidenceCapsule>[]>;
}

// Synthesis FTS port consumed by the recall service. The implementing repo
// is SqliteSynthesisCapsuleRepo (migration 079). Recall queries it on the
// FTS-backed keyword path and joins each hit as a synthesis_capsule candidate
// before fusion, rerank, and delivery-budget selection.
// see also: packages/storage/src/repos/synthesis-capsule-repo.ts
export interface RecallServiceSynthesisSearchPort {
  searchByKeyword(
    workspaceId: string,
    queryText: string,
    limit: number
  ): Promise<readonly KeywordSearchResult[]>;
  findByIds(
    objectIds: readonly string[]
  ): Promise<readonly Readonly<SynthesisCapsule>[]>;
}

export interface RecallServiceSlotRepoPort {
  findByWorkspace(workspaceId: string): Promise<readonly Readonly<Slot>[]>;
}

export interface RecallServiceEventLogRepoPort {
  append(entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">): EventLogEntry | Promise<EventLogEntry>;
  queryByEntity(entityType: string, entityId: string): Promise<readonly EventLogEntry[]>;
}

export interface RecallServiceGraphSupportPort {
  /** @deprecated recall reads `countInboundEdgesWeighted` instead.
   * Kept on the port for non-recall callers (raw supports-only count). */
  countInboundSupports(memoryId: string, workspaceId: string): Promise<number>;
  // Aggregates inbound graph edges by edge_type weight into one signed
  // support score. The recall service consumes this so that derives_from /
  // recalls signals also lift graph_support, and supersedes pulls it down
  // (floor-clamped to zero baseline; see MEMORY_GRAPH_EDGE_RECALL_WEIGHTS invariant).
  countInboundEdgesWeighted(memoryId: string, workspaceId: string): Promise<number>;
  // Counts inbound RECALLS edges only. Cold-mode transfer uses this as explicit
  // evidence that recall graph activity exists, independent of other
  // graph-support edge types.
  countInboundRecalls?(memoryId: string, workspaceId: string): Promise<number>;
}

export interface RecallServiceBudgetPenaltyPort {
  getSnapshot(runId: string): Promise<Readonly<BudgetSnapshot>>;
}

export interface RecallServiceProjectMappingPort {
  findByWorkspace(workspaceId: string): Promise<readonly Readonly<ProjectMappingAnchor>[]>;
  ensureSuggestedAnchors?(
    globalObjectIds: readonly string[],
    workspaceId: string,
    createdBy: string
  ): Promise<readonly Readonly<ProjectMappingAnchor>[]>;
}

export interface RecallServiceClaimResolverPort {
  findByIds(objectIds: readonly string[]): Promise<readonly Readonly<{
    readonly object_id: string;
    readonly source_object_refs: readonly string[];
  }>[]>;
}

/**
 * Optional port that returns the strongest direction-eligible
 * PathPlasticityState.strength across all path relations anchored on each
 * memory entry. Implementations are expected to read precomputed
 * PathRelation rows and apply direction_bias filtering; the recall service
 * does not compute paths itself.
 *
 * The map's value range is [0, 1]. Memories without an entry are treated as
 * having no plasticity boost.
 */
export interface RecallServicePathPlasticityPort {
  getStrengthByMemoryId(
    workspaceId: string,
    memoryIds: readonly string[]
  ): Promise<ReadonlyMap<string, number>>;
}

export interface RecallServiceGraphExpansionPort {
  findByMemoryId(
    memoryId: string,
    workspaceId: string,
    edgeTypes?: readonly MemoryGraphEdgeTypeValue[]
  ): Promise<readonly Readonly<MemoryGraphEdge>[]>;
}

export interface RecallServicePathExpansionPort {
  findByAnchors(
    workspaceId: string,
    anchorRefs: readonly PathAnchorRef[]
  ): Promise<readonly Readonly<PathRelation>[]>;
  findByTimeConcernWindowDigests?(
    workspaceId: string,
    windowDigests: readonly string[]
  ): Promise<readonly Readonly<PathRelation>[]>;
}

export interface RecallServiceActiveConstraintsPort {
  findActiveConstraints(params: Readonly<{
    readonly workspaceId: string;
    readonly cap?: number | null;
  }>): Promise<Readonly<{
    readonly constraints: readonly Readonly<SoulActiveConstraint>[];
    readonly total_count: number;
  }>>;
}

// invariant: ManifestationSidecarApplierPort produces the bias sidecar
// the recall service forwards into RecallCandidate.pending_incomplete
// and RecallCandidate.unfinishedness_bias. Implementations are expected
// to call PathActivationCandidateProducer and ManifestationResolver in
// sequence. The port is optional. When absent the recall service skips
// the sidecar step and emits candidates unchanged.
export interface RecallServiceManifestationSidecarPort {
  buildBiasSidecar(params: Readonly<{
    readonly workspaceId: string;
    readonly runId: string;
    readonly anchorMemoryObjectIds: readonly string[];
    readonly taskSurfaceRef: Readonly<import("@do-soul/alaya-protocol").TaskObjectSurface> | null;
  }>): Promise<readonly Readonly<ManifestationBiasSidecarEntry>[]>;
}

export interface TokenEstimator {
  estimate(text: string): number;
}

export function makeTokenEstimator(opts: {
  readonly hint?: SoulRecallTokenizerHint | null;
} = {}): TokenEstimator {
  const charsPerToken = resolveCharsPerToken(opts.hint ?? null);

  return Object.freeze({
    estimate(text: string): number {
      return Math.ceil(text.length / charsPerToken);
    }
  });
}

function resolveCharsPerToken(hint: SoulRecallTokenizerHint | null): number {
  switch (hint) {
    case "cl100k":
      // OpenAI tokenizer docs cite ~4 chars/token for common English text;
      // the hint is a conservative heuristic, not a native tokenizer.
      return 3.6;
    case "o200k":
      return 3.2;
    case "approx_chars_per_token":
    case null:
      return 4;
  }
}

export interface RecallServiceEmbeddingRecallPort {
  prepareQuerySupplement?(params: {
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly queryText: string;
    readonly eligibleMemories: readonly Readonly<MemoryEntry>[];
    readonly baseCandidateCount: number;
  }): Promise<PreparedEmbeddingSupplement>;
  hasStoredVectors?(params: {
    readonly workspaceId: string;
    readonly eligibleMemories: readonly Readonly<MemoryEntry>[];
  }): Promise<boolean>;
  recordPrecheckDegraded?(params: {
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly reason: string;
    readonly baseCandidateCount: number;
    readonly fallbackCandidateCount: number;
  }): Promise<void>;
  prepareQueryEmbedding?(params: {
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly queryText: string;
  }): PreparedEmbeddingQueryHandle;
  querySupplementIfReady?(params: {
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly eligibleMemories: readonly Readonly<MemoryEntry>[];
    readonly baseCandidateIds: readonly string[];
    readonly maxSupplement: number;
    readonly preparedQuery: PreparedEmbeddingQueryHandle;
    readonly storedVectors?: PreparedEmbeddingSupplement["storedVectors"];
  }): Promise<EmbeddingRecallSupplementResult>;
  querySupplement(params: {
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly queryText: string;
    readonly eligibleMemories: readonly Readonly<MemoryEntry>[];
    readonly baseCandidateIds: readonly string[];
    readonly maxSupplement: number;
  }): Promise<EmbeddingRecallSupplementResult>;
}

export interface RecallServiceDependencies {
  readonly memoryRepo: RecallServiceMemoryRepoPort;
  readonly slotRepo: RecallServiceSlotRepoPort;
  readonly eventLogRepo: RecallServiceEventLogRepoPort;
  readonly graphSupportPort?: RecallServiceGraphSupportPort;
  readonly budgetPenaltyPort?: RecallServiceBudgetPenaltyPort;
  readonly projectMappingPort?: RecallServiceProjectMappingPort;
  readonly globalRecallPort?: GlobalMemoryRecallPort;
  readonly globalRecallCachePort?: GlobalMemoryRecallCachePort;
  readonly claimResolverPort?: RecallServiceClaimResolverPort;
  readonly embeddingRecallService?: RecallServiceEmbeddingRecallPort;
  readonly pathPlasticityPort?: RecallServicePathPlasticityPort;
  readonly graphExpansionPort?: RecallServiceGraphExpansionPort;
  readonly pathExpansionPort?: RecallServicePathExpansionPort;
  readonly activeConstraintsPort?: RecallServiceActiveConstraintsPort;
  readonly evidenceSearchPort?: RecallServiceEvidenceSearchPort;
  readonly synthesisSearchPort?: RecallServiceSynthesisSearchPort;
  readonly manifestationSidecarPort?: RecallServiceManifestationSidecarPort;
  readonly generateRuntimeId?: () => string;
  readonly now?: () => string;
  readonly warn?: RecallServiceWarnPort;
}

export type RecallAdmissionPlane =
  | "activation"
  | "protected_winner"
  | "object_probe"
  | "evidence_anchor"
  | "domain_tag_cluster"
  | "session_surface_cohort"
  | "source_proximity"
  | "graph_expansion"
  | "path_expansion"
  | "lexical";

export type RecallCandidateDropReason =
  | "duplicate"
  | "dimension_limit"
  | "max_entries"
  | "max_total_tokens";

export type RecallEmbeddingProviderStatus =
  | "provider_returned"
  | "provider_pending"
  | "provider_failed"
  | "provider_not_requested";

export type RecallFusionStream =
  | "lexical_fts"
  | "synthesis_fts"
  | "evidence_fts"
  | "evidence_structural_agreement"
  | "source_proximity"
  | "source_evidence_agreement"
  | "subject_alignment"
  | "structural"
  | "existing_score"
  | "embedding_similarity"
  | "graph_expansion"
  | "path_expansion"
  | "temporal_recency"
  | "workspace_activation";

export type RecallFusionStreamRanks = Readonly<Record<RecallFusionStream, number | null>>;
export type RecallFusionStreamContributions = Readonly<Record<RecallFusionStream, number>>;

export interface RecallFusionBreakdown {
  readonly candidate_key: string;
  readonly object_id: string;
  readonly object_kind: RecallCandidate["object_kind"];
  readonly origin_plane: RecallOriginPlane;
  readonly per_stream_rank: RecallFusionStreamRanks;
  readonly fused_rank: number;
  readonly fused_score: number;
  readonly fused_rank_contribution_per_stream: RecallFusionStreamContributions;
}

export interface RecallCandidateDiagnostic {
  readonly candidate_key: string;
  readonly object_id: string;
  readonly object_kind: RecallCandidate["object_kind"];
  readonly origin_plane: RecallOriginPlane;
  readonly admission_planes: readonly RecallAdmissionPlane[];
  readonly plane_first_admitted: RecallAdmissionPlane;
  readonly plane_winning_admission: RecallAdmissionPlane;
  readonly pre_budget_rank: number;
  readonly selection_order: number;
  readonly fused_rank: number;
  readonly fused_score: number;
  readonly per_stream_rank: RecallFusionStreamRanks;
  readonly fused_rank_contribution_per_stream: RecallFusionStreamContributions;
  readonly final_rank: number | null;
  readonly dropped_reason: RecallCandidateDropReason | null;
  readonly within_budget: boolean;
  readonly relevance_score: number;
  readonly lexical_rank: number | null;
  readonly structural_score: number;
  readonly score_factors: Readonly<RecallScoreFactors>;
  readonly source_channels: readonly string[];
  readonly path_expansion_sources: readonly RecallPathExpansionSourceDiagnostic[];
}

export interface RecallPathExpansionSourceDiagnostic {
  readonly path_id: string;
  readonly seed_id: string;
  readonly seed_kind: "memory" | "time_concern";
  readonly target_object_id: string;
  readonly source_channel: "path_expansion" | "time_concern";
}

export interface RecallDiagnostics {
  readonly query_probes: {
    readonly subject_hints: readonly string[];
    readonly object_ids: readonly string[];
    readonly evidence_refs: readonly string[];
    readonly run_ids: readonly string[];
    readonly surface_ids: readonly string[];
    readonly file_paths: readonly string[];
    readonly command_names: readonly string[];
    readonly package_names: readonly string[];
    readonly task_refs: readonly string[];
    readonly dimensions: readonly string[];
    readonly scope_classes: readonly string[];
    readonly domain_tags: readonly string[];
    readonly lexical_terms: readonly string[];
    readonly phrases: readonly string[];
    readonly char_ngrams: readonly string[];
    readonly date_terms: readonly string[];
  };
  readonly total_scanned: number;
  readonly candidate_pool_count: number;
  readonly pre_budget_count: number;
  readonly delivered_count: number;
  readonly embedding_provider_status: RecallEmbeddingProviderStatus;
  readonly provider_degradation_reason: string | null;
  readonly fusion_breakdown: readonly Readonly<RecallFusionBreakdown>[];
  readonly candidates: readonly Readonly<RecallCandidateDiagnostic>[];
}

export interface RecallResult {
  readonly candidates: readonly Readonly<RecallCandidate>[];
  readonly active_constraints: readonly Readonly<SoulActiveConstraint>[];
  readonly active_constraints_count: number;
  readonly total_scanned: number;
  readonly coarse_filter_count: number;
  readonly fine_assessment_count: number;
  readonly degradation_reason: SoulMemorySearchDegradationReason | null;
  readonly working_projection: null;
  readonly diagnostics?: Readonly<RecallDiagnostics>;
}

export interface RecallSupplementaryData {
  readonly queryProbes: Readonly<import("./recall-query-probes.js").RecallQueryProbes>;
  readonly ftsRanks: Readonly<Record<string, number>>;
  readonly synthesisFtsRanks: Readonly<Record<string, number>>;
  readonly evidenceFtsRanks: Readonly<Record<string, number>>;
  readonly sourceProximityScores: Readonly<Record<string, number>>;
  readonly sourceCohortKeys: Readonly<Record<string, string>>;
  readonly structuralScores: Readonly<Record<string, number>>;
  readonly graphExpansionScores: Readonly<Record<string, number>>;
  readonly pathExpansionScores: Readonly<Record<string, number>>;
  readonly embeddingSimilarityScores: Readonly<Record<string, number>>;
  readonly graphSupportCounts: Readonly<Record<string, number>>;
  readonly budgetPenaltyFactor: number;
  readonly plasticityFactors: Readonly<Record<string, number>>;
  readonly graphAndPathColdScore: number;
  readonly recallsEdgeCount: number;
  readonly weightTransferAmount: number;
}

export interface CoarseRecallCandidate {
  readonly entry: Readonly<MemoryEntry>;
  readonly isAdvisory?: boolean;
  readonly originPlane?: RecallOriginPlane;
  readonly sourceChannel?: string;
  readonly sourceChannels?: readonly string[];
  readonly admissionPlanes?: readonly RecallAdmissionPlane[];
  readonly firstAdmissionPlane?: RecallAdmissionPlane;
  readonly structuralScore?: number;
  readonly scoreMultiplier?: number;
  readonly pathExpansionSources?: readonly RecallPathExpansionSourceDiagnostic[];
  // Set to "synthesis_capsule" when the candidate is sourced from an L2
  // synthesis row rather than an L1 memory_entry. The `entry` is then a
  // synthesis-shaped pseudo memory carrying the synthesis summary as content.
  readonly objectKind?: RecallCandidate["object_kind"];
}

export interface RecallServiceWarnPort {
  (message: string, meta: Record<string, unknown>): void;
}

export type { SoulRecallHostContext };
export type { RecallCandidate } from "@do-soul/alaya-protocol";
