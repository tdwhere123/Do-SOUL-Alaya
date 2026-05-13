import type {
  BudgetSnapshot,
  EventLogEntry,
  MemoryDimension as MemoryDimensionType,
  MemoryEntry,
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
}

export interface RecallServiceSlotRepoPort {
  findByWorkspace(workspaceId: string): Promise<readonly Readonly<Slot>[]>;
}

export interface RecallServiceEventLogRepoPort {
  append(entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">): EventLogEntry | Promise<EventLogEntry>;
  queryByEntity(entityType: string, entityId: string): Promise<readonly EventLogEntry[]>;
}

export interface RecallServiceGraphSupportPort {
  /** @deprecated since v0.3.3 — recall reads `countInboundEdgesWeighted` instead.
   * Kept on the port for one release for non-recall callers. */
  countInboundSupports(memoryId: string, workspaceId: string): Promise<number>;
  // Aggregates inbound graph edges by edge_type weight into one signed
  // support score. The recall service consumes this so that derives_from /
  // recalls signals also lift graph_support, and supersedes pulls it down
  // (currently floor-at-zero — see MEMORY_GRAPH_EDGE_RECALL_WEIGHTS comment).
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
  readonly generateRuntimeId?: () => string;
  readonly now?: () => string;
  readonly warn?: RecallServiceWarnPort;
}

export interface RecallResult {
  readonly candidates: readonly Readonly<RecallCandidate>[];
  readonly total_scanned: number;
  readonly coarse_filter_count: number;
  readonly fine_assessment_count: number;
  readonly degradation_reason: SoulMemorySearchDegradationReason | null;
  readonly working_projection: null;
}

export interface RecallSupplementaryData {
  readonly ftsRanks: Readonly<Record<string, number>>;
  readonly graphSupportCounts: Readonly<Record<string, number>>;
  readonly budgetPenaltyFactor: number;
  readonly plasticityFactors: Readonly<Record<string, number>>;
}

export interface CoarseRecallCandidate {
  readonly entry: Readonly<MemoryEntry>;
  readonly isAdvisory?: boolean;
  readonly originPlane?: RecallOriginPlane;
  readonly sourceChannel?: string;
  readonly scoreMultiplier?: number;
}

export interface RecallServiceWarnPort {
  (message: string, meta: Record<string, unknown>): void;
}

export type { SoulRecallHostContext };
export type { RecallCandidate } from "@do-soul/alaya-protocol";
