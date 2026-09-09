import type {
  EvidenceCapsule,
  MemoryDimension as MemoryDimensionType,
  MemoryEntry,
  PathAnchorRef,
  PathRelation,
  ScopeClass,
  SoulActiveConstraint,
  StorageTier as StorageTierType,
  SynthesisCapsule,
  RecallPolicy
} from "@do-soul/alaya-protocol";
import type { RecallReadSnapshotPort } from "./recall-read-snapshot.js";
import type {
  KeywordSearchBatchQuery,
  KeywordSearchFieldResult,
  KeywordSearchLaneScope,
  KeywordSearchResult,
  MemoryKeywordFieldCapture,
  RecallEvidenceSearchMatch,
  RecallQualifiedEvidence
} from "./recall-search-port-types.js";
import type {
  RecallActivationTopKQuery,
  RecallEventTimeWindowQuery,
  RecallMemoryListPageOptions,
  RecallTierWindowCursor,
  RecallTierWindowResult
} from "./recall-memory-window-port.js";
import type {
  RecallEvidenceSourceAnchor,
  RecallTemporalProjectionReadOptions
} from "./recall-service-port-types.js";

export type {
  KeywordLexicalLaneId,
  KeywordLexicalMergeCapture,
  KeywordSearchBatchQuery,
  KeywordSearchFieldRefinementLevel,
  KeywordSearchFieldResult,
  KeywordSearchLaneId,
  KeywordSearchLaneObservation,
  KeywordSearchLaneReceipt,
  KeywordSearchLaneScope,
  KeywordSearchLaneStatus,
  KeywordSearchResult,
  MemoryKeywordFieldCapture,
  MemoryKeywordFieldCaptureVariant,
  RecallEvidenceSearchMatch,
  RecallEvidenceSearchProjectionIdentity,
  RecallQualifiedEvidence
} from "./recall-search-port-types.js";
export type {
  RecallActivationTopKQuery,
  RecallEventTimeWindowQuery,
  RecallMemoryListPageOptions,
  RecallTierWindowCursor,
  RecallTierWindowResult
} from "./recall-memory-window-port.js";
export type {
  RecallEvidenceSourceAnchor,
  RecallTemporalProjectionReadOptions,
  TokenEstimator
} from "./recall-service-port-types.js";
export {
  makeTokenEstimator,
  readWithTemporalProjection
} from "./recall-service-port-helpers.js";

export interface RecallServiceMemoryRepoPort {
  findByWorkspaceId(
    workspaceId: string,
    tier?: StorageTierType,
    page?: RecallMemoryListPageOptions
  ): Promise<readonly Readonly<MemoryEntry>[]>;
  findRecallTierWindow?(query: Readonly<{
    readonly workspaceId: string;
    readonly tier: StorageTierType;
    readonly limit: number;
    readonly cursor?: Readonly<RecallTierWindowCursor>;
  }>): Promise<Readonly<RecallTierWindowResult>>;
  findRecallActivationTopK?(
    query: Readonly<RecallActivationTopKQuery>
  ): Promise<readonly Readonly<MemoryEntry>[]>;
  findByEventTimeWindow?(
    query: Readonly<RecallEventTimeWindowQuery>
  ): Promise<readonly Readonly<MemoryEntry>[]>;
  findByDimension(workspaceId: string, dimension: MemoryDimensionType): Promise<readonly Readonly<MemoryEntry>[]>;
  findByScopeClass(workspaceId: string, scopeClass: ScopeClass): Promise<readonly Readonly<MemoryEntry>[]>;
  searchByKeyword?(workspaceId: string, queryText: string, limit: number): Promise<readonly KeywordSearchResult[]>;
  searchByKeywordField?(
    workspaceId: string,
    queryText: string,
    limit: number,
    scope?: Readonly<KeywordSearchLaneScope>,
    refinementDepths?: readonly number[],
    capture?: Readonly<MemoryKeywordFieldCapture>
  ): Promise<Readonly<KeywordSearchFieldResult>>;
  searchByKeywordWithinObjectIds?(
    workspaceId: string,
    queryText: string,
    limit: number,
    objectIds: readonly string[]
  ): Promise<readonly KeywordSearchResult[]>;
  searchByKeywordWithinTier?(
    workspaceId: string,
    queryText: string,
    limit: number,
    tier: StorageTierType
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
  searchByAnchorWithinTier?(
    workspaceId: string,
    anchorTokens: readonly string[],
    optionalTokens: readonly string[],
    limit: number,
    tier: StorageTierType
  ): Promise<readonly KeywordSearchResult[]>;
  searchByAnchorField?(
    workspaceId: string,
    anchorTokens: readonly string[],
    optionalTokens: readonly string[],
    limit: number,
    scope?: Readonly<KeywordSearchLaneScope>,
    refinementDepths?: readonly number[]
  ): Promise<Readonly<KeywordSearchFieldResult>>;
  // Admits memories whose distilled content lost keywords but whose EvidenceCapsule.gist still matches. see also: 068-evidence-capsule-fts.sql.
  findByEvidenceRefs?(
    workspaceId: string,
    evidenceObjectIds: readonly string[]
  ): Promise<readonly Readonly<MemoryEntry>[]>;
  findBoundEvidenceRefs?(
    workspaceId: string,
    evidenceObjectIds: readonly string[]
  ): Promise<readonly string[]>;
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
    limit: number,
    refinementDepths?: readonly number[]
  ): Promise<readonly KeywordSearchResult[]>;
  searchByKeywordField?(
    workspaceId: string,
    queryText: string,
    limit: number,
    refinementDepths?: readonly number[]
  ): Promise<Readonly<KeywordSearchFieldResult>>;
  searchManyByKeywordField?(
    workspaceId: string,
    queries: readonly Readonly<KeywordSearchBatchQuery>[]
  ): Promise<readonly Readonly<KeywordSearchFieldResult>[]>;
  findByIds?(
    workspaceId: string,
    evidenceObjectIds: readonly string[]
  ): Promise<readonly Readonly<EvidenceCapsule>[]>;
  findRecallQualifiedByIds?(
    workspaceId: string,
    matches: readonly RecallEvidenceSearchMatch[]
  ): Promise<readonly RecallQualifiedEvidence[]>;
  findRecallQualifiedFactKeysByIds?(
    workspaceId: string,
    evidenceObjectIds: readonly string[]
  ): Promise<readonly RecallQualifiedEvidence[]>;
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
    limit: number,
    refinementDepths?: readonly number[]
  ): Promise<readonly KeywordSearchResult[]>;
  searchByKeywordField?(
    workspaceId: string,
    queryText: string,
    limit: number,
    refinementDepths?: readonly number[]
  ): Promise<Readonly<KeywordSearchFieldResult>>;
  searchManyByKeywordField?(
    workspaceId: string,
    queries: readonly Readonly<KeywordSearchBatchQuery>[]
  ): Promise<readonly Readonly<KeywordSearchFieldResult>[]>;
  findByIds(
    workspaceId: string,
    objectIds: readonly string[]
  ): Promise<readonly Readonly<SynthesisCapsule>[]>;
}

/** Historical worker reads retain direction-eligible PathRelation strength. */
export interface RecallServicePathPlasticityPort {
  getStrengthByMemoryId(
    workspaceId: string,
    memoryIds: readonly string[],
    options?: RecallTemporalProjectionReadOptions
  ): Promise<ReadonlyMap<string, number>>;
}

export interface RecallServicePathExpansionPort {
  findByAnchors(
    workspaceId: string,
    anchorRefs: readonly PathAnchorRef[],
    options?: RecallTemporalProjectionReadOptions
  ): Promise<readonly Readonly<PathRelation>[]>;
  findByTimeConcernWindowDigests?(
    workspaceId: string,
    windowDigests: readonly string[],
    options?: RecallTemporalProjectionReadOptions
  ): Promise<readonly Readonly<PathRelation>[]>;
}

export interface RecallServiceActiveConstraintsPort {
  readBounded?(params: Readonly<import("@do-soul/alaya-protocol").BoundedActiveConstraintsRequest>):
    Promise<Readonly<import("@do-soul/alaya-protocol").BoundedActiveConstraintsResult>>;
  findActiveConstraints(params: Readonly<{
    readonly workspaceId: string;
    readonly cap?: number | null;
    readonly asOf?: string;
  }>): Promise<Readonly<{
    readonly constraints: readonly Readonly<SoulActiveConstraint>[];
    readonly total_count: number;
  }>>;
}

export interface RecallServiceDependencies {
  readonly activeConstraintsPort?: RecallServiceActiveConstraintsPort;
  // The decorator applies runtime policy defaults before request validation.
  readonly defaultPolicyDecorator?: (
    policy: Readonly<RecallPolicy>
  ) => Readonly<RecallPolicy>;
  readonly generateRuntimeId?: () => string;
  readonly now?: () => string;
  readonly readSnapshot?: RecallReadSnapshotPort;
}
