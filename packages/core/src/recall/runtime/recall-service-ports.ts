import type {
  BudgetSnapshot,
  EventLogEntry,
  EvidenceCapsule,
  MemoryDimension as MemoryDimensionType,
  MemoryEntry,
  PathAnchorRef,
  PathRelation,
  ProjectMappingAnchor,
  SoulActiveConstraint,
  SoulRecallTokenizerHint,
  Slot,
  StorageTier as StorageTierType,
  SynthesisCapsule
} from "@do-soul/alaya-protocol";
import type { ScopeClass } from "@do-soul/alaya-protocol";
import type {
  EmbeddingNeighborHit,
  EmbeddingWorkspaceNeighborResult,
  EmbeddingRecallSupplementResult,
  PreparedEmbeddingSupplement,
  PreparedEmbeddingQueryHandle
} from "../../embedding-recall/embedding-recall-service.js";
import type {
  ManifestationBiasSidecarEntry
} from "../../manifestation/manifestation-resolver.js";
import type {
  GlobalMemoryRecallCachePort,
  GlobalMemoryRecallPort
} from "./global-memory-recall-port.js";
import type { RecallFailureHealthInboxPort } from "./recall-failure-health-inbox.js";

export interface KeywordSearchResult {
  readonly object_id: string;
  readonly normalized_rank: number;
  // Trigram-lane ordinal score, present only for substring/CJK trigram hits; feeds trigram_fts. Absent for exact/porter-only hits.
  readonly trigram_rank?: number;
}

export interface KeywordSearchBatchQuery {
  readonly queryText: string;
  readonly limit: number;
}

export interface RecallMemoryListPageOptions {
  readonly limit: number;
  readonly offset: number;
}

export interface RecallEvidenceSourceAnchor {
  readonly evidence_object_id: string;
  readonly artifact_ref: string;
}

export interface RecallServiceMemoryRepoPort {
  findByWorkspaceId(
    workspaceId: string,
    tier?: StorageTierType,
    page?: RecallMemoryListPageOptions
  ): Promise<readonly Readonly<MemoryEntry>[]>;
  findByDimension(workspaceId: string, dimension: MemoryDimensionType): Promise<readonly Readonly<MemoryEntry>[]>;
  findByScopeClass(workspaceId: string, scopeClass: ScopeClass): Promise<readonly Readonly<MemoryEntry>[]>;
  searchByKeyword?(workspaceId: string, queryText: string, limit: number): Promise<readonly KeywordSearchResult[]>;
  searchByKeywordWithinObjectIds?(
    workspaceId: string,
    queryText: string,
    limit: number,
    objectIds: readonly string[]
  ): Promise<readonly KeywordSearchResult[]>;
  searchManyByKeywordWithinObjectIds?(
    workspaceId: string,
    queries: readonly Readonly<KeywordSearchBatchQuery>[],
    objectIds: readonly string[]
  ): Promise<readonly (readonly KeywordSearchResult[])[]>;
  searchByAnchorWithinObjectIds?(
    workspaceId: string,
    anchorTokens: readonly string[],
    optionalTokens: readonly string[],
    limit: number,
    objectIds: readonly string[]
  ): Promise<readonly KeywordSearchResult[]>;
  // Admits memories whose distilled content lost keywords but whose EvidenceCapsule.gist still matches. see also: 068-evidence-capsule-fts.sql.
  findByEvidenceRefs?(
    workspaceId: string,
    evidenceObjectIds: readonly string[]
  ): Promise<readonly Readonly<MemoryEntry>[]>;
  // Optional id-batch lookup; the embedding coarse-injection path resolves cosine neighbors into MemoryEntry candidates.
  findByIds?(
    workspaceId: string,
    objectIds: readonly string[]
  ): Promise<readonly Readonly<MemoryEntry>[]>;
}

// Evidence FTS port (impl SqliteEvidenceCapsuleRepo, migration 068); widens lexical candidate generation when distillation drops keywords.
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
  findSourceAnchorsByIds?(
    workspaceId: string,
    evidenceObjectIds: readonly string[]
  ): Promise<readonly RecallEvidenceSourceAnchor[]>;
}

// Synthesis FTS port (impl SqliteSynthesisCapsuleRepo, migration 079); synthesis rows route as capsules and expand source_memory_refs into candidates, but are not themselves delivered. see also: storage/repos/capsules/synthesis-capsule-repo.ts.
export interface RecallServiceSynthesisSearchPort {
  searchByKeyword(
    workspaceId: string,
    queryText: string,
    limit: number
  ): Promise<readonly KeywordSearchResult[]>;
  findByIds(
    workspaceId: string,
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
  // Inbound graph edges aggregated by edge_type weight into one signed support score (floor-clamped to 0). see also: MEMORY_GRAPH_EDGE_RECALL_WEIGHTS invariant.
  countInboundEdgesWeighted(memoryId: string, workspaceId: string): Promise<number>;
  // Inbound RECALLS edges only; cold-mode transfer uses this as explicit evidence of recall graph activity.
  countInboundRecalls?(memoryId: string, workspaceId: string): Promise<number>;
  countInboundRecallMetricsByMemoryId?(
    memoryIds: readonly string[],
    workspaceId: string
  ): Promise<ReadonlyMap<string, Readonly<{
    readonly weightedEdgeCount: number;
    readonly recallCount: number;
  }>>>;
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
  findByIds(workspaceId: string, objectIds: readonly string[]): Promise<readonly Readonly<{
    readonly object_id: string;
    readonly source_object_refs: readonly string[];
  }>[]>;
}

/** Optional port: strongest direction-eligible PathPlasticityState.strength per memory (value in [0,1]); missing entry = no plasticity boost. Reads precomputed PathRelation rows; recall does not compute paths itself. */
export interface RecallServicePathPlasticityPort {
  getStrengthByMemoryId(
    workspaceId: string,
    memoryIds: readonly string[]
  ): Promise<ReadonlyMap<string, number>>;
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

// invariant: produces the bias sidecar forwarded into RecallCandidate.pending_incomplete / unfinishedness_bias. Optional — when absent the sidecar step is skipped and candidates emit unchanged.
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
      // Conservative chars/token heuristic, not a native tokenizer.
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
  // Embedding-on coarse-injection path: top-K workspace cosine neighbors that
  // lexical recall never admitted. Optional so keyword-only providers and
  // older test doubles stay valid.
  collectWorkspaceNeighbors?(params: {
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly queryText: string;
    readonly excludeObjectIds: readonly string[];
    readonly maxNeighbors: number;
  }): Promise<readonly Readonly<EmbeddingNeighborHit>[]>;
  collectWorkspaceNeighborsWithMetadata?(params: {
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly queryText: string;
    readonly excludeObjectIds: readonly string[];
    readonly maxNeighbors: number;
  }): Promise<Readonly<EmbeddingWorkspaceNeighborResult>>;
  // Re-rank path: cosine(query, stored-vector) for candidates ALREADY in the pool —
  // the inverse of injection (which excludes pooled ids). Lets embedding lift a
  // buried-but-pooled gold above its lexical topic-neighbor.
  scorePoolCandidates?(params: {
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly queryText: string;
    readonly objectIds: readonly string[];
  }): Promise<ReadonlyMap<string, number>>;
}

export interface RecallServiceAnswerRerankPort {
  score(
    query: string,
    passages: readonly string[]
  ): Promise<readonly number[]>;
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
  readonly answerRerankService?: RecallServiceAnswerRerankPort;
  readonly pathPlasticityPort?: RecallServicePathPlasticityPort;
  readonly pathExpansionPort?: RecallServicePathExpansionPort;
  readonly activeConstraintsPort?: RecallServiceActiveConstraintsPort;
  readonly evidenceSearchPort?: RecallServiceEvidenceSearchPort;
  readonly synthesisSearchPort?: RecallServiceSynthesisSearchPort;
  readonly manifestationSidecarPort?: RecallServiceManifestationSidecarPort;
  // Optional decorator over every buildDefaultPolicy output; the daemon injects runtime-driven scoring_weight_overrides. Must return a valid RecallPolicy; identity is the safe default.
  readonly defaultPolicyDecorator?: (
    policy: Readonly<import("@do-soul/alaya-protocol").RecallPolicy>
  ) => Readonly<import("@do-soul/alaya-protocol").RecallPolicy>;
  // see also: shared/entity-extraction-port.ts, shared/entity-extraction-rules.ts RuleBasedEntityExtractor.
  readonly entityExtractionPort?: import("../../shared/entity-extraction-port.js").EntityExtractionPort;
  // Opt-in (ALAYA_RECALL_SOURCE_REF_ROBUST): also parse round-labeled / per-fact source refs (`s3-r2`, `s3-r2-f1`) so source proximity engages on conversational corpora. Default off.
  readonly robustSourceRefParsing?: boolean;
  readonly generateRuntimeId?: () => string;
  readonly now?: () => string;
  readonly warn?: RecallServiceWarnPort;
  // Unexpected recall auxiliary failures (not graceful degradations) land here.
  readonly recallFailureHealthInbox?: RecallFailureHealthInboxPort;
}

export interface RecallServiceWarnPort {
  (message: string, meta: Record<string, unknown>): void;
}
