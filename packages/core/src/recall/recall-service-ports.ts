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
} from "../embedding-recall/embedding-recall-service.js";
import type {
  ManifestationBiasSidecarEntry
} from "../manifestation/manifestation-resolver.js";
import type {
  GlobalMemoryRecallCachePort,
  GlobalMemoryRecallPort
} from "./global-memory-recall-port.js";
import type { RecallFailureHealthInboxPort } from "./recall-failure-health-inbox.js";

export interface KeywordSearchResult {
  readonly object_id: string;
  readonly normalized_rank: number;
  // Trigram-lane ordinal score, present only when the keyword search routed a
  // hit through the substring/CJK trigram lane. Feeds the trigram_fts fusion
  // stream. Absent for exact/porter-only hits.
  readonly trigram_rank?: number;
}

export interface RecallMemoryListPageOptions {
  readonly limit: number;
  readonly offset: number;
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
  searchByAnchorWithinObjectIds?(
    workspaceId: string,
    anchorTokens: readonly string[],
    optionalTokens: readonly string[],
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
  // Optional id-batch lookup. Used by the embedding-on coarse-injection path
  // to resolve workspace cosine neighbors into MemoryEntry candidates.
  findByIds?(objectIds: readonly string[]): Promise<readonly Readonly<MemoryEntry>[]>;
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
// FTS-backed keyword path, uses synthesis rows as routing capsules, and expands
// active same-workspace source_memory_refs into memory_entry candidates before
// fusion and delivery-budget selection. Synthesis capsules are not delivered.
// see also: packages/storage/src/repos/capsules/synthesis-capsule-repo.ts
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
  readonly pathExpansionPort?: RecallServicePathExpansionPort;
  readonly activeConstraintsPort?: RecallServiceActiveConstraintsPort;
  readonly evidenceSearchPort?: RecallServiceEvidenceSearchPort;
  readonly synthesisSearchPort?: RecallServiceSynthesisSearchPort;
  readonly manifestationSidecarPort?: RecallServiceManifestationSidecarPort;
  // Optional decorator applied to every policy buildDefaultPolicy emits.
  // The daemon uses it to inject scoring_weight_overrides driven by runtime
  // state (e.g. raise the embedding_similarity fusion weight when the
  // embedding provider is wired). Decorators must return a structurally
  // valid RecallPolicy; an identity function is the safe default.
  readonly defaultPolicyDecorator?: (
    policy: Readonly<import("@do-soul/alaya-protocol").RecallPolicy>
  ) => Readonly<import("@do-soul/alaya-protocol").RecallPolicy>;
  // see also: packages/core/src/shared/entity-extraction-port.ts
  // see also: packages/core/src/shared/entity-extraction-rules.ts RuleBasedEntityExtractor
  readonly entityExtractionPort?: import("../shared/entity-extraction-port.js").EntityExtractionPort;
  // Opt-in (ALAYA_RECALL_SOURCE_REF_ROBUST): also parse round-labeled / per-fact
  // evidence source refs (`s3-r2`, `s3-r2-f1`) so source proximity engages on
  // conversational corpora. Default off keeps t/turn/chunk parsing unchanged.
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
