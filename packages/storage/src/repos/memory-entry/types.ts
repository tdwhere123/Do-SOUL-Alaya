import {
  StorageTier,
  type MemoryDimension,
  type MemoryEntry,
  type MemoryEntryRepoUpdateFields as ProtocolMemoryEntryRepoUpdateFields,
  type ScopeClass
} from "@do-soul/alaya-protocol";
import type {
  LexicalLiveMergeCapture,
  LexicalRawRankReceipt
} from "./search/lexical-raw-rank-capture.js";

export type MemoryEntryRepoUpdateFields = ProtocolMemoryEntryRepoUpdateFields & {
  readonly last_used_at?: string;
  readonly last_hit_at?: string;
};
export interface MemoryEntryRepoDynamicsUpdateFields {
  readonly activation_score: number;
  readonly retention_score: number;
  readonly manifestation_state: MemoryEntry["manifestation_state"];
  readonly retention_state?: MemoryEntry["retention_state"];
  readonly last_used_at?: string;
  readonly last_hit_at?: string;
  readonly reinforcement_count?: number;
  readonly contradiction_count?: number;
  readonly superseded_by?: string;
}

export interface MemoryEntryListPageOptions {
  readonly limit: number;
  readonly offset: number;
}

export interface RecallTierWindowCursor {
  readonly created_at: string;
  readonly object_id: string;
}

export interface RecallTierWindowQuery {
  readonly workspaceId: string;
  readonly tier: StorageTier;
  readonly limit: number;
  readonly cursor?: Readonly<RecallTierWindowCursor>;
}

export interface RecallTierWindowResult {
  readonly memories: readonly Readonly<MemoryEntry>[];
  readonly next_cursor: Readonly<RecallTierWindowCursor> | null;
  readonly truncated: boolean;
}

export interface RecallEventTimeWindowQuery {
  readonly workspaceId: string;
  readonly tier: StorageTier;
  readonly startTime: string;
  readonly endTime: string;
  readonly limit: number;
}

export interface RecallActivationTopKQuery {
  readonly workspaceId: string;
  readonly tier: StorageTier;
  readonly limit: number;
  readonly min_activation_score?: number | null;
  readonly exclude_object_ids?: readonly string[];
}

export interface MemoryEntryRepoTierUpdateInput {
  readonly objectId: string;
  readonly workspaceId: string;
  readonly fromTier: StorageTier;
  readonly toTier: StorageTier;
  readonly updatedAt: string;
  readonly expectedUpdatedAt: string;
  readonly activationBump?: number;
  readonly lastUsedAt?: string;
  readonly lastHitAt?: string;
}

export interface MemoryEntryKeywordSearchResult {
  readonly object_id: string;
  readonly normalized_rank: number;
  // invariant: trigram_rank marks substring/CJK hits for recall's trigram_fts stream.
  readonly trigram_rank?: number;
  // invariant: object_key_rank marks hits that Key FTS admitted; not a new scoring stream.
  readonly object_key_rank?: number;
}

export interface MemoryEntryKeywordLaneReceipt {
  readonly lane: "exact" | "porter" | "trigram";
  readonly status: "complete" | "truncated" | "unavailable" | "ineligible";
  readonly depth: number;
  readonly observations: readonly Readonly<
    MemoryEntryKeywordSearchResult & { readonly rank: number; readonly source_id?: string }
  >[];
  readonly unseen_upper_bound: number | null;
}

export type MemoryKeywordFieldCaptureVariant =
  | "lexical_relaxed"
  | "lexical_expanded";

export type MemoryKeywordFieldCapture = Readonly<{
  readonly variant: MemoryKeywordFieldCaptureVariant;
}>;

export interface MemoryEntryKeywordFieldResult {
  readonly matches: readonly Readonly<MemoryEntryKeywordSearchResult>[];
  readonly lanes: readonly Readonly<MemoryEntryKeywordLaneReceipt>[];
  readonly lexical_raw_rank?: Readonly<LexicalLiveMergeCapture>;
  readonly lexical_raw_rank_receipt?: Readonly<LexicalRawRankReceipt>;
  readonly refinement_levels?: readonly Readonly<{
    readonly requested_depth: number;
    readonly matches: readonly Readonly<MemoryEntryKeywordSearchResult>[];
    readonly lanes: readonly Readonly<MemoryEntryKeywordLaneReceipt>[];
  }>[];
}

export interface MemoryEntryRepo {
  create(entry: MemoryEntry): Promise<Readonly<MemoryEntry>>;
  // invariant: callbacks and row insert share one synchronous SQLite transaction.
  // see also: packages/core/src/memory/memory-service/service.ts:MemoryService.create
  // see also: packages/storage/src/repos/enrich-pending-repo.ts:SqliteEnrichPendingRepo.enqueue
  createWithinTransaction(
    entry: MemoryEntry,
    callbacks: {
      readonly beforeCreate?: () => void;
      readonly afterCreate?: () => void;
    }
  ): Readonly<MemoryEntry>;
  // invariant: callbacks and row update share one synchronous SQLite transaction.
  updateWithinTransaction(
    objectId: string,
    fields: MemoryEntryRepoUpdateFields,
    callbacks: {
      readonly beforeUpdate?: () => void;
      readonly afterUpdate?: () => void;
    },
    workspaceId?: string
  ): Readonly<MemoryEntry>;
  findById(objectId: string): Promise<Readonly<MemoryEntry> | null>;
  // invariant (§7): synchronous read for the single-transaction karma path.
  findByIdSync?(objectId: string): Readonly<MemoryEntry> | null;
  findByIds(
    workspaceId: string,
    objectIds: readonly string[]
  ): Promise<readonly Readonly<MemoryEntry>[]>;
  findByWorkspaceId(
    workspaceId: string,
    tier?: StorageTier,
    page?: MemoryEntryListPageOptions
  ): Promise<readonly Readonly<MemoryEntry>[]>;
  findRecallTierWindow(query: RecallTierWindowQuery): Promise<Readonly<RecallTierWindowResult>>;
  findRecallActivationTopK(
    query: RecallActivationTopKQuery
  ): Promise<readonly Readonly<MemoryEntry>[]>;
  findByEventTimeWindow(
    query: RecallEventTimeWindowQuery
  ): Promise<readonly Readonly<MemoryEntry>[]>;
  findByWorkspaceIdAll(
    workspaceId: string,
    tier?: StorageTier
  ): Promise<readonly Readonly<MemoryEntry>[]>;
  countByWorkspaceId(workspaceId: string, tier?: StorageTier): Promise<number>;
  findByRunId(
    runId: string,
    page?: MemoryEntryListPageOptions
  ): Promise<readonly Readonly<MemoryEntry>[]>;
  findByRunIdAll(runId: string): Promise<readonly Readonly<MemoryEntry>[]>;
  countByRunId(runId: string): Promise<number>;
  findByDimension(
    workspaceId: string,
    dimension: MemoryDimension,
    page?: MemoryEntryListPageOptions
  ): Promise<readonly Readonly<MemoryEntry>[]>;
  findByDimensionAll(
    workspaceId: string,
    dimension: MemoryDimension
  ): Promise<readonly Readonly<MemoryEntry>[]>;
  countByDimension(workspaceId: string, dimension: MemoryDimension): Promise<number>;
  findByScopeClass(
    workspaceId: string,
    scopeClass: ScopeClass,
    page?: MemoryEntryListPageOptions
  ): Promise<readonly Readonly<MemoryEntry>[]>;
  findByScopeClassAll(
    workspaceId: string,
    scopeClass: ScopeClass
  ): Promise<readonly Readonly<MemoryEntry>[]>;
  countByScopeClass(workspaceId: string, scopeClass: ScopeClass): Promise<number>;
  findByWorkspaceIdWithConflict(
    workspaceId: string,
    page?: MemoryEntryListPageOptions
  ): Promise<readonly Readonly<MemoryEntry>[]>;
  countByWorkspaceIdWithConflict(workspaceId: string): Promise<number>;
  findByDimensionWithConflict(
    workspaceId: string,
    dimension: MemoryDimension,
    page?: MemoryEntryListPageOptions
  ): Promise<readonly Readonly<MemoryEntry>[]>;
  countByDimensionWithConflict(workspaceId: string, dimension: MemoryDimension): Promise<number>;
  findByScopeClassWithConflict(
    workspaceId: string,
    scopeClass: ScopeClass,
    page?: MemoryEntryListPageOptions
  ): Promise<readonly Readonly<MemoryEntry>[]>;
  countByScopeClassWithConflict(workspaceId: string, scopeClass: ScopeClass): Promise<number>;
  findByScopeClassAndDimensionWithConflict(
    workspaceId: string,
    scopeClass: ScopeClass,
    dimension: MemoryDimension,
    page?: MemoryEntryListPageOptions
  ): Promise<readonly Readonly<MemoryEntry>[]>;
  countByScopeClassAndDimensionWithConflict(
    workspaceId: string,
    scopeClass: ScopeClass,
    dimension: MemoryDimension
  ): Promise<number>;
  // invariant: shared-tag narrowing is a superset of every INCOMPATIBLE_WITH candidate.
  findBySharedDomainTags(
    workspaceId: string,
    tags: readonly string[]
  ): Promise<readonly Readonly<MemoryEntry>[]>;
  searchByKeyword(
    workspaceId: string,
    queryText: string,
    limit: number
  ): Promise<readonly MemoryEntryKeywordSearchResult[]>;
  searchByKeywordField?(
    workspaceId: string,
    queryText: string,
    limit: number,
    scope?: Readonly<{ readonly objectIds?: readonly string[]; readonly tier?: StorageTier }>,
    refinementDepths?: readonly number[],
    capture?: Readonly<MemoryKeywordFieldCapture>
  ): Promise<Readonly<MemoryEntryKeywordFieldResult>>;
  searchByKeywordWithinObjectIds?(
    workspaceId: string,
    queryText: string,
    limit: number,
    objectIds: readonly string[]
  ): Promise<readonly MemoryEntryKeywordSearchResult[]>;
  searchByKeywordWithinTier?(
    workspaceId: string,
    queryText: string,
    limit: number,
    tier: StorageTier
  ): Promise<readonly MemoryEntryKeywordSearchResult[]>;
  searchByAnchorWithinObjectIds?(
    workspaceId: string,
    anchorTokens: readonly string[],
    optionalTokens: readonly string[],
    limit: number,
    objectIds: readonly string[]
  ): Promise<readonly MemoryEntryKeywordSearchResult[]>;
  searchByAnchorWithinTier?(
    workspaceId: string,
    anchorTokens: readonly string[],
    optionalTokens: readonly string[],
    limit: number,
    tier: StorageTier
  ): Promise<readonly MemoryEntryKeywordSearchResult[]>;
  searchByAnchorField?(
    workspaceId: string,
    anchorTokens: readonly string[],
    optionalTokens: readonly string[],
    limit: number,
    scope?: Readonly<{ readonly objectIds?: readonly string[]; readonly tier?: StorageTier }>,
    refinementDepths?: readonly number[]
  ): Promise<Readonly<MemoryEntryKeywordFieldResult>>;
  // see also: packages/storage/src/migrations/001-runtime-foundation.sql
  // see also: packages/storage/src/migrations/003-memory-fts-and-garden.sql
  findByEvidenceRefs?(
    workspaceId: string,
    evidenceObjectIds: readonly string[]
  ): Promise<readonly Readonly<MemoryEntry>[]>;
  findBoundEvidenceRefs?(
    workspaceId: string,
    evidenceObjectIds: readonly string[]
  ): Promise<readonly string[]>;
  findLowActivityActiveMemories(workspaceId: string): Promise<readonly Readonly<MemoryEntry>[]>;
  findTombstonedMemories(workspaceId: string): Promise<readonly Readonly<MemoryEntry>[]>;
  update(objectId: string, fields: MemoryEntryRepoUpdateFields): Promise<Readonly<MemoryEntry>>;
  updateScoped(objectId: string, workspaceId: string, fields: MemoryEntryRepoUpdateFields): Promise<Readonly<MemoryEntry>>;
  updateTier(input: MemoryEntryRepoTierUpdateInput): Readonly<MemoryEntry> | null;
  updateDynamics(
    objectId: string,
    fields: MemoryEntryRepoDynamicsUpdateFields,
    updatedAt: string
  ): Promise<Readonly<MemoryEntry>>;
  // invariant (§7): synchronous dynamics write for the single-transaction karma path.
  updateDynamicsSync?(
    objectId: string,
    fields: MemoryEntryRepoDynamicsUpdateFields,
    updatedAt: string
  ): Readonly<MemoryEntry>;
  transitionLifecycle(
    objectId: string,
    lifecycleState: MemoryEntry["lifecycle_state"],
    updatedAt: string,
    onTransition?: () => void
  ): Promise<Readonly<MemoryEntry>>;
  // invariant (§7): synchronous lifecycle transition (revival fallback) for the
  // single-transaction karma path.
  transitionLifecycleSync?(
    objectId: string,
    lifecycleState: MemoryEntry["lifecycle_state"],
    updatedAt: string,
    onTransition?: () => void
  ): Readonly<MemoryEntry>;
  // invariant (N1): guarded reversible revival; null when the row was not dormant.
  reviveDormant(objectId: string, updatedAt: string): Promise<Readonly<MemoryEntry> | null>;
  // invariant (§7 + N1): synchronous guarded revival for the single-transaction karma path.
  reviveDormantSync?(objectId: string, updatedAt: string): Readonly<MemoryEntry> | null;
  // invariant: active -> dormant audit runs in the demotion transaction only on changes>0.
  transitionToDormantIfActive(
    objectId: string,
    updatedAt: string,
    onTransition?: () => void
  ): Promise<Readonly<MemoryEntry> | null>;
  archive(objectId: string, updatedAt: string, onArchived?: () => void): Promise<Readonly<MemoryEntry>>;
  hardDeleteTombstoned(objectId: string, onDeleted?: () => void): Promise<void>;
  // invariant: autonomous tombstone candidates are dormant-only and pre-disposition.
  findDormantMemories(workspaceId: string): Promise<readonly Readonly<MemoryEntry>[]>;
  // invariant: autonomous tombstone can terminalize only currently dormant rows.
  autonomousTombstone(
    input: AutonomousTombstoneInput,
    options?: { readonly onTransition?: () => void }
  ): Promise<Readonly<MemoryEntry>>;
  // invariant: disposition-gated GC deletes only tombstones with live delete authority.
  hardDeleteTombstonedWithDisposition(
    objectId: string,
    options?: {
      readonly requireLiveCapsuleRef?: boolean;
      readonly requireJudgedUselessVerdict?: boolean;
      readonly onDeleted?: () => void;
    }
  ): Promise<boolean>;
  // invariant: TOMBSTONE_GC only sees past-grace tombstones with a disposition.
  findTombstonedMemoriesWithDisposition(
    workspaceId: string
  ): Promise<readonly Readonly<MemoryEntry>[]>;
}

// invariant: dispositionRef is live-capsule-only for compressed and null for judged_useless.
export interface AutonomousTombstoneInput {
  readonly objectId: string;
  readonly disposition: MemoryEntry["forget_disposition"];
  readonly dispositionRef: string | null;
  readonly updatedAt: string;
}

// invariant: evidence-ref lookup is bounded and reports truncation at the repo boundary.
export const FIND_BY_EVIDENCE_REFS_INPUT_CAP = 256;
export const FIND_BY_EVIDENCE_REFS_ROW_LIMIT = 512;
export type MemoryEntryRepoDiagnosticSink = (
  message: string,
  meta: Record<string, unknown>
) => void;
