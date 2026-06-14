import {
  StorageTier,
  type MemoryDimension,
  type MemoryEntry,
  type MemoryEntryRepoUpdateFields as ProtocolMemoryEntryRepoUpdateFields,
  type ScopeClass
} from "@do-soul/alaya-protocol";

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
  findById(objectId: string): Promise<Readonly<MemoryEntry> | null>;
  findByIds(objectIds: readonly string[]): Promise<readonly Readonly<MemoryEntry>[]>;
  findByWorkspaceId(
    workspaceId: string,
    tier?: StorageTier,
    page?: MemoryEntryListPageOptions
  ): Promise<readonly Readonly<MemoryEntry>[]>;
  countByWorkspaceId(workspaceId: string, tier?: StorageTier): Promise<number>;
  findByRunId(
    runId: string,
    page?: MemoryEntryListPageOptions
  ): Promise<readonly Readonly<MemoryEntry>[]>;
  countByRunId(runId: string): Promise<number>;
  findByDimension(
    workspaceId: string,
    dimension: MemoryDimension,
    page?: MemoryEntryListPageOptions
  ): Promise<readonly Readonly<MemoryEntry>[]>;
  countByDimension(workspaceId: string, dimension: MemoryDimension): Promise<number>;
  findByScopeClass(
    workspaceId: string,
    scopeClass: ScopeClass
  ): Promise<readonly Readonly<MemoryEntry>[]>;
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
  searchByKeywordWithinObjectIds?(
    workspaceId: string,
    queryText: string,
    limit: number,
    objectIds: readonly string[]
  ): Promise<readonly MemoryEntryKeywordSearchResult[]>;
  // see also: packages/storage/src/migrations/005-evidence-capsules.sql
  // see also: packages/storage/src/migrations/068-evidence-capsule-fts.sql
  findByEvidenceRefs?(
    workspaceId: string,
    evidenceObjectIds: readonly string[]
  ): Promise<readonly Readonly<MemoryEntry>[]>;
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
  transitionLifecycle(
    objectId: string,
    lifecycleState: MemoryEntry["lifecycle_state"],
    updatedAt: string,
    onTransition?: () => void
  ): Promise<Readonly<MemoryEntry>>;
  // invariant (N1): guarded reversible revival; null when the row was not dormant.
  reviveDormant(objectId: string, updatedAt: string): Promise<Readonly<MemoryEntry> | null>;
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
