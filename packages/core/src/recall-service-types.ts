import type {
  BudgetSnapshot,
  EventLogEntry,
  MemoryDimension as MemoryDimensionType,
  MemoryEntry,
  MemoryGraphEdge,
  MemoryGraphEdgeTypeValue,
  PathAnchorRef,
  PathRelation,
  ProjectMappingAnchor,
  RecallCandidate,
  RecallOriginPlane,
  SoulRecallHostContext,
  SoulRecallTokenizerHint,
  SoulMemorySearchDegradationReason,
  Slot,
  StorageTier as StorageTierType
} from "@do-soul/alaya-protocol";
import type { ScopeClass } from "@do-soul/alaya-protocol";
import type {
  EmbeddingRecallSupplementResult,
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
  // see also: 068-evidence-capsule-fts.sql — used by lexical plane to admit
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
  // (floor-clamped to zero baseline — see MEMORY_GRAPH_EDGE_RECALL_WEIGHTS invariant).
  countInboundEdgesWeighted(memoryId: string, workspaceId: string): Promise<number>;
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
}

// invariant: ManifestationSidecarApplierPort produces the bias sidecar
// the recall service forwards into RecallCandidate.pending_incomplete
// and RecallCandidate.unfinishedness_bias. Implementations are expected
// to call PathActivationCandidateProducer and ManifestationResolver in
// sequence. The port is optional — when absent the recall service skips
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
      // this v0.2.0 hint is a conservative heuristic, not a native tokenizer.
      return 3.6;
    case "o200k":
      return 3.2;
    case "approx_chars_per_token":
    case null:
      return 4;
  }
}

export interface RecallServiceEmbeddingRecallPort {
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
  readonly evidenceSearchPort?: RecallServiceEvidenceSearchPort;
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
  | "temporal_proximity"
  | "session_surface_cohort"
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

export interface RecallCandidateDiagnostic {
  readonly object_id: string;
  readonly admission_planes: readonly RecallAdmissionPlane[];
  readonly plane_first_admitted: RecallAdmissionPlane;
  readonly plane_winning_admission: RecallAdmissionPlane;
  readonly pre_budget_rank: number;
  readonly final_rank: number | null;
  readonly dropped_reason: RecallCandidateDropReason | null;
  readonly within_budget: boolean;
  readonly relevance_score: number;
  readonly lexical_rank: number | null;
  readonly structural_score: number;
  readonly source_channels: readonly string[];
}

export interface RecallDiagnostics {
  readonly query_probes: {
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
  readonly candidates: readonly Readonly<RecallCandidateDiagnostic>[];
}

export interface RecallResult {
  readonly candidates: readonly Readonly<RecallCandidate>[];
  readonly total_scanned: number;
  readonly coarse_filter_count: number;
  readonly fine_assessment_count: number;
  readonly degradation_reason: SoulMemorySearchDegradationReason | null;
  readonly working_projection: null;
  readonly diagnostics?: Readonly<RecallDiagnostics>;
}

export interface RecallSupplementaryData {
  readonly ftsRanks: Readonly<Record<string, number>>;
  readonly structuralScores: Readonly<Record<string, number>>;
  readonly graphSupportCounts: Readonly<Record<string, number>>;
  readonly budgetPenaltyFactor: number;
  readonly plasticityFactors: Readonly<Record<string, number>>;
  readonly graphAndPathCold: boolean;
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
}

export interface RecallServiceWarnPort {
  (message: string, meta: Record<string, unknown>): void;
}

export type { SoulRecallHostContext };
export type { RecallCandidate } from "@do-soul/alaya-protocol";
