import {
  StorageTier,
  type MemoryDimension,
  type MemoryEntry,
  type MemoryEntryRepoUpdateFields as ProtocolMemoryEntryRepoUpdateFields,
  type ScopeClass
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../db.js";
import { StorageError } from "../errors.js";
import {
  buildObjectIdFilterSql,
  countQueryCodepoints,
  createShortKeywordMatcher,
  mergeKeywordSearchRows,
  normalizeKeywordSearchObjectIds,
  tokenBearsCjk,
  tokenizeFtsQuery,
  type ExactKeywordCandidateRow,
  type ExactKeywordSearchRow,
  type FtsKeywordSearchRow
} from "./memory-entry-keyword-search.js";
import {
  MEMORY_ENTRY_SELECT_COLUMNS,
  parseDynamicsUpdateFields,
  parseForgetDisposition,
  parseLifecycleState,
  parseMemoryDimension,
  parseMemoryEntry,
  parseMemoryEntryRow,
  parseScopeClass,
  parseStorageTier,
  parseUpdatedAt,
  parseUpdateFields,
  type MemoryEntryRow
} from "./memory-entry-row-mapper.js";
import {
  PATH_RELATION_SOURCE_BACKING_OBJECT_ID_SQL,
  PATH_RELATION_TARGET_BACKING_OBJECT_ID_SQL
} from "./path-relation-repo.js";
import { parseNonEmptyString } from "./shared/validators.js";

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
  // Trigram-lane ordinal score, present only when the object matched the
  // substring/CJK trigram lane. Recall reads it for the trigram_fts fusion
  // stream; absent when the hit came purely from the exact/porter lanes.
  readonly trigram_rank?: number;
}

export interface MemoryEntryRepo {
  create(entry: MemoryEntry): Promise<Readonly<MemoryEntry>>;
  // invariant: atomic caller-supplied audit/create/co-write. Runs `beforeCreate`,
  // the row insert, and `afterCreate` inside ONE connection.transaction so the
  // EventLog row, created memory row, and co-write (the enrich_pending no-drop
  // marker) commit in EventLog-first order or none commit. Callbacks MUST be
  // synchronous — better-sqlite3 commits on return, so an awaited write would
  // land after COMMIT.
  // see also: packages/core/src/memory-service.ts MemoryService.create enrich enqueue
  // see also: packages/storage/src/repos/enrich-pending-repo.ts enqueue
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
    tier?: StorageTier
  ): Promise<readonly Readonly<MemoryEntry>[]>;
  findByRunId(runId: string): Promise<readonly Readonly<MemoryEntry>[]>;
  findByDimension(
    workspaceId: string,
    dimension: MemoryDimension
  ): Promise<readonly Readonly<MemoryEntry>[]>;
  findByScopeClass(
    workspaceId: string,
    scopeClass: ScopeClass
  ): Promise<readonly Readonly<MemoryEntry>[]>;
  // Hot-tier, non-tombstoned memories in the workspace whose domain_tags
  // JSON array shares >=1 value with `tags`. Each match returned once.
  // invariant: this is the candidate-narrowing source for the
  // INCOMPATIBLE_WITH conflict scan: jaccard(domain_tags) >= the rule
  // gate (0.35) implies >=1 shared tag, so the shared-tag set is a
  // superset of every gate-passing candidate -- the narrowed result is
  // edge-identical to a full findByWorkspaceId scan. Tier/tombstone/order
  // scope MUST match findByWorkspaceId(hot) for that equivalence to hold.
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
  // see also: 005-evidence-capsules.sql + 068-evidence-capsule-fts.sql
  // Returns memory entries whose evidence_refs JSON array references any of
  // the given evidence_capsule.object_id values, scoped to workspace.
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
    updatedAt: string
  ): Promise<Readonly<MemoryEntry>>;
  // invariant (N1): guarded reversible revival; null when the row was not dormant.
  reviveDormant(objectId: string, updatedAt: string): Promise<Readonly<MemoryEntry> | null>;
  // invariant: guarded active -> dormant demotion mirroring reviveDormant. Returns
  // the demoted row when the row was active; returns null (no-op skip) when it was
  // NOT active (changes=0) so the caller skips a spurious from_state="active"
  // audit instead of throwing. onTransition runs synchronously INSIDE the
  // transaction and ONLY when changes>0, so the active->dormant audit append
  // commits atomically with the UPDATE (or rolls back with it). A genuine DB
  // error still surfaces as StorageError.
  transitionToDormantIfActive(
    objectId: string,
    updatedAt: string,
    onTransition?: () => void
  ): Promise<Readonly<MemoryEntry> | null>;
  archive(objectId: string, updatedAt: string): Promise<Readonly<MemoryEntry>>;
  hardDeleteTombstoned(objectId: string): Promise<void>;
  // invariant: dormant memories whose decay already silenced them, eligible for
  // the AUTONOMOUS-tombstone disposition sweep. Returns dormant rows only; the
  // sweep computes a disposition per row before any tombstone write.
  findDormantMemories(workspaceId: string): Promise<readonly Readonly<MemoryEntry>[]>;
  // invariant: the GATED autonomous-tombstone authority. Sets the durable
  // disposition marker AND moves the row to retention_state=tombstoned /
  // lifecycle_state=tombstone in one UPDATE, but ONLY when the row is currently
  // dormant. Refuses (changes=0 -> NOT_FOUND) a non-dormant row so it can never
  // tombstone an active/recallable memory. ref must be null for judged_useless.
  autonomousTombstone(
    input: AutonomousTombstoneInput,
    options?: { readonly onTransition?: () => void }
  ): Promise<Readonly<MemoryEntry>>;
  // invariant: the GATED autonomous physical-delete authority (defense in
  // depth). Physically removes a row ONLY when it is tombstoned AND past the
  // grace age AND carries a non-null forget_disposition. A tombstoned row
  // lacking a disposition (e.g. human Inspector retire) is refused here, never
  // auto-GC'd. The human/legacy path stays on hardDeleteTombstoned.
  // requireLiveCapsuleRef additionally re-asserts the preserving capsule's
  // liveness + membership atomically (compressed path); resolves false when that
  // guard matches 0 rows (preservation revoked), true when a row was deleted.
  // invariant: onDeleted runs synchronously INSIDE the delete transaction and
  // ONLY when changes>0, so the caller's terminal-removal audit append commits
  // atomically with the physical delete (no audit-less deleted row) and never
  // fires on a 0-row preservation-revoked race (no spurious "deleted" audit).
  hardDeleteTombstonedWithDisposition(
    objectId: string,
    options?: {
      readonly requireLiveCapsuleRef?: boolean;
      readonly requireJudgedUselessVerdict?: boolean;
      readonly onDeleted?: () => void;
    }
  ): Promise<boolean>;
  // invariant: tombstoned + past-grace + non-null-disposition rows — the only
  // rows the autonomous TOMBSTONE_GC may physically remove.
  findTombstonedMemoriesWithDisposition(
    workspaceId: string
  ): Promise<readonly Readonly<MemoryEntry>[]>;
}

// invariant: forget_disposition_ref MUST be a live synthesis_capsule id when
// disposition='compressed' and MUST be null when disposition='judged_useless'.
// The caller (memory-service.autonomousTombstone) verifies the capsule is live
// + references this member before invoking; the column stores the verified ref.
export interface AutonomousTombstoneInput {
  readonly objectId: string;
  readonly disposition: MemoryEntry["forget_disposition"];
  readonly dispositionRef: string | null;
  readonly updatedAt: string;
}

// invariant: findByEvidenceRefs is BOUNDED (input id-set capped, row scan
// LIMITed) so a pathological evidence set cannot run an unbounded query. The cap
// is fail-safe: a member omitted by truncation is simply never resolved, so it
// is never compress-deleted (the missing-member case falls through to dormant).
// But silent truncation hides a real over-cap input from operators, so the repo
// surfaces a warn-level structured diagnostic AT the boundary (input over cap OR
// output hitting the row LIMIT). Default sink is a no-op so unit tests and
// non-daemon callers stay quiet; the daemon wires it to its warn logger.
export const FIND_BY_EVIDENCE_REFS_INPUT_CAP = 256;
export const FIND_BY_EVIDENCE_REFS_ROW_LIMIT = 512;
export type MemoryEntryRepoDiagnosticSink = (
  message: string,
  meta: Record<string, unknown>
) => void;

export class SqliteMemoryEntryRepo implements MemoryEntryRepo {
  private readonly createStatement;
  private readonly findByIdStatement;
  private readonly findByWorkspaceHotStatement;
  private readonly findByWorkspaceTierStatement;
  private readonly findByRunIdStatement;
  private readonly findByDimensionHotStatement;
  private readonly findByScopeClassHotStatement;
  private readonly updateStatement;
  private readonly updateScopedStatement;
  // updateDynamics uses a dynamic SQL builder to support nullable field clearing.
  private readonly searchByKeywordStatement;
  // see also: 077-memory-content-fts-dual.sql -- word-level porter+unicode61
  // index alongside the trigram-tokenized memory_content_fts table.
  private readonly searchByKeywordPorterStatement;
  private readonly findLowActivityActiveMemoriesStatement;
  private readonly findTombstonedMemoriesStatement;
  private readonly transitionLifecycleStatement;
  // invariant (I3): a revived / non-tombstone transition clears the terminal
  // forget marker so an active/dormant row never carries a removal disposition.
  private readonly transitionLifecycleClearForgetStatement;
  // invariant (N1): guarded dormant -> active revival; changes=0 when not dormant.
  private readonly reviveDormantStatement;
  // invariant: guarded active -> dormant demotion; changes=0 when not active so a
  // candidate that left active between snapshot and turn is a benign no-op skip,
  // not an aborting throw. Clears the forget marker (I3): dormant is non-tombstone.
  private readonly demoteActiveToDormantStatement;
  private readonly archiveStatement;
  private readonly hardDeleteTombstonedStatement;
  private readonly findDormantMemoriesStatement;
  private readonly autonomousTombstoneStatement;
  private readonly findTombstonedWithDispositionStatement;
  private readonly hardDeleteTombstonedWithDispositionStatement;
  // invariant: the compressed-disposition delete restates capsule liveness +
  // membership inside the DELETE so the preservation re-check is atomic with the
  // physical removal (no TOCTOU window). 0 rows changed == preservation revoked.
  private readonly hardDeleteTombstonedCompressedGuardedStatement;
  // invariant: the judged_useless-disposition delete restates the mechanical
  // importance verdict in the DELETE so evidence / reinforcement / protection
  // gained during grace turns into 0 rows changed, not permanent data loss.
  private readonly hardDeleteTombstonedJudgedUselessGuardedStatement;
  // invariant: path topology endpoints reference memory ids only via JSON
  // anchors / plain text (no FK), so hard-delete must prune them explicitly in
  // the same transaction. cross-file ref: cascade-delete.ts pruneOrphanedPathTopology
  private readonly deleteOrphanedPathRelationsStatement;
  private readonly deleteOrphanedCoUsageCountersStatement;

  // diagnostics: warn sink for bounded-query truncation. Defaults to a no-op so
  // unit tests and non-daemon callers stay quiet; the daemon wires it.
  public constructor(
    private readonly db: StorageDatabase,
    private readonly diagnostics: MemoryEntryRepoDiagnosticSink = () => {}
  ) {
    this.createStatement = db.connection.prepare(`
      INSERT INTO memory_entries (
        object_id,
        object_kind,
        schema_version,
        lifecycle_state,
        created_at,
        updated_at,
        created_by,
        dimension,
        source_kind,
        formation_kind,
        scope_class,
        content,
        domain_tags,
        evidence_refs,
        workspace_id,
        run_id,
        surface_id,
        storage_tier,
        activation_score,
        retention_score,
        manifestation_state,
        retention_state,
        decay_profile,
        confidence,
        last_used_at,
        last_hit_at,
        reinforcement_count,
        contradiction_count,
        superseded_by,
        forget_disposition,
        forget_disposition_ref
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.findByIdStatement = db.connection.prepare(`
      SELECT${MEMORY_ENTRY_SELECT_COLUMNS}
      FROM memory_entries
      WHERE object_id = ?
      LIMIT 1
    `);
    // invariant: recall/list candidate loads exclude tombstoned (destructive,
    // terminal) AND dormant (REVERSIBLE silencing). A dormant memory drops out
    // of the recall candidate pool but is revived on next use
    // (DynamicsService.processKarmaEvent dormant -> active) and stays directly
    // fetchable by object_id via findById (open_pointer never filters).
    this.findByWorkspaceHotStatement = db.connection.prepare(`
      SELECT${MEMORY_ENTRY_SELECT_COLUMNS}
      FROM memory_entries
      WHERE workspace_id = ? AND storage_tier = 'hot'
        AND COALESCE(retention_state, '') != 'tombstoned'
        AND COALESCE(lifecycle_state, '') != 'dormant'
      ORDER BY created_at ASC, object_id ASC
    `);
    this.findByWorkspaceTierStatement = db.connection.prepare(`
      SELECT${MEMORY_ENTRY_SELECT_COLUMNS}
      FROM memory_entries
      WHERE workspace_id = ? AND storage_tier = ?
        AND COALESCE(retention_state, '') != 'tombstoned'
        AND COALESCE(lifecycle_state, '') != 'dormant'
      ORDER BY created_at ASC, object_id ASC
    `);
    this.findByRunIdStatement = db.connection.prepare(`
      SELECT${MEMORY_ENTRY_SELECT_COLUMNS}
      FROM memory_entries
      WHERE run_id = ?
        AND COALESCE(retention_state, '') != 'tombstoned'
        AND COALESCE(lifecycle_state, '') != 'dormant'
      ORDER BY created_at ASC, object_id ASC
    `);
    this.findByDimensionHotStatement = db.connection.prepare(`
      SELECT${MEMORY_ENTRY_SELECT_COLUMNS}
      FROM memory_entries
      WHERE workspace_id = ? AND dimension = ? AND storage_tier = 'hot'
        AND COALESCE(retention_state, '') != 'tombstoned'
        AND COALESCE(lifecycle_state, '') != 'dormant'
      ORDER BY created_at ASC, object_id ASC
    `);
    this.findByScopeClassHotStatement = db.connection.prepare(`
      SELECT${MEMORY_ENTRY_SELECT_COLUMNS}
      FROM memory_entries
      WHERE workspace_id = ? AND scope_class = ? AND storage_tier = 'hot'
        AND COALESCE(retention_state, '') != 'tombstoned'
        AND COALESCE(lifecycle_state, '') != 'dormant'
      ORDER BY created_at ASC, object_id ASC
    `);
    this.updateStatement = db.connection.prepare(`
      UPDATE memory_entries
      SET
        content = COALESCE(?, content),
        domain_tags = COALESCE(?, domain_tags),
        evidence_refs = COALESCE(?, evidence_refs),
        storage_tier = COALESCE(?, storage_tier),
        confidence = COALESCE(?, confidence),
        retention_state = COALESCE(?, retention_state),
        last_used_at = COALESCE(?, last_used_at),
        last_hit_at = COALESCE(?, last_hit_at),
        updated_at = ?
      WHERE object_id = ?
    `);
    this.updateScopedStatement = db.connection.prepare(`
      UPDATE memory_entries
      SET
        content = COALESCE(?, content),
        domain_tags = COALESCE(?, domain_tags),
        evidence_refs = COALESCE(?, evidence_refs),
        storage_tier = COALESCE(?, storage_tier),
        confidence = COALESCE(?, confidence),
        retention_state = COALESCE(?, retention_state),
        last_used_at = COALESCE(?, last_used_at),
        last_hit_at = COALESCE(?, last_hit_at),
        updated_at = ?
      WHERE object_id = ? AND workspace_id = ?
    `);
    this.searchByKeywordStatement = db.connection.prepare(`
      SELECT
        memory_content_fts.object_id,
        bm25(memory_content_fts) AS raw_rank
      FROM memory_content_fts
      JOIN memory_entries ON memory_entries.object_id = memory_content_fts.object_id
      WHERE
        memory_content_fts.workspace_id = ?
        AND memory_content_fts MATCH ?
        AND COALESCE(memory_entries.retention_state, '') != 'tombstoned'
        AND COALESCE(memory_entries.lifecycle_state, '') != 'dormant'
      ORDER BY raw_rank ASC, memory_content_fts.object_id ASC
      LIMIT ?
    `);
    this.searchByKeywordPorterStatement = db.connection.prepare(`
      SELECT
        memory_content_fts_porter.object_id,
        bm25(memory_content_fts_porter) AS raw_rank
      FROM memory_content_fts_porter
      JOIN memory_entries ON memory_entries.object_id = memory_content_fts_porter.object_id
      WHERE
        memory_content_fts_porter.workspace_id = ?
        AND memory_content_fts_porter MATCH ?
        AND COALESCE(memory_entries.retention_state, '') != 'tombstoned'
        AND COALESCE(memory_entries.lifecycle_state, '') != 'dormant'
      ORDER BY raw_rank ASC, memory_content_fts_porter.object_id ASC
      LIMIT ?
    `);
    this.findLowActivityActiveMemoriesStatement = db.connection.prepare(`
      SELECT${MEMORY_ENTRY_SELECT_COLUMNS}
      FROM memory_entries
      WHERE
        workspace_id = ?
        AND lifecycle_state = 'active'
        AND storage_tier = 'hot'
        AND COALESCE(activation_score, 0.0) <= 0.3
        AND COALESCE(last_hit_at, last_used_at, updated_at, created_at)
          <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-14 days')
      ORDER BY
        COALESCE(last_hit_at, last_used_at, updated_at, created_at) ASC,
        COALESCE(activation_score, 0.0) ASC,
        object_id ASC
    `);
    this.findTombstonedMemoriesStatement = db.connection.prepare(`
      SELECT${MEMORY_ENTRY_SELECT_COLUMNS}
      FROM memory_entries
      WHERE
        workspace_id = ?
        AND retention_state = 'tombstoned'
        AND updated_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')
      ORDER BY updated_at ASC, object_id ASC
    `);
    this.transitionLifecycleStatement = db.connection.prepare(`
      UPDATE memory_entries
      SET lifecycle_state = ?, updated_at = ?
      WHERE object_id = ?
    `);
    // invariant (I3): clear the terminal forget marker on any transition to a
    // NON-tombstone state. A revived / re-activated / re-dormant row must never
    // carry forget_disposition / forget_disposition_ref (a marker that would let
    // the autonomous GC physically delete it). The B1 delete-time re-verify is
    // the backstop for an import-carried stale marker; this clears the marker on
    // the revival path itself.
    this.transitionLifecycleClearForgetStatement = db.connection.prepare(`
      UPDATE memory_entries
      SET lifecycle_state = ?,
          updated_at = ?,
          forget_disposition = NULL,
          forget_disposition_ref = NULL
      WHERE object_id = ?
    `);
    // invariant (N1): guarded reversible revival. Flip a memory dormant -> active
    // ONLY when it is currently dormant, so a concurrent (or duplicate) revival of
    // an already-active row reports changes=0 and the caller skips the audit event
    // instead of emitting a spurious from_state="dormant" transition. Clears the
    // forget marker (I3) since the target state (active) is not tombstone.
    this.reviveDormantStatement = db.connection.prepare(`
      UPDATE memory_entries
      SET lifecycle_state = 'active',
          updated_at = ?,
          forget_disposition = NULL,
          forget_disposition_ref = NULL
      WHERE object_id = ?
        AND lifecycle_state = 'dormant'
    `);
    // invariant: guarded reversible demotion mirroring reviveDormant (N1). Flip a
    // memory active -> dormant ONLY when it is currently active, so a concurrent
    // revival / overlapping sweep / Inspector retire that already moved the row
    // reports changes=0 and the caller skips (no spurious from_state="active"
    // audit, no aborting throw). Clears the forget marker (I3): dormant is not a
    // tombstone state.
    this.demoteActiveToDormantStatement = db.connection.prepare(`
      UPDATE memory_entries
      SET lifecycle_state = 'dormant',
          updated_at = ?,
          forget_disposition = NULL,
          forget_disposition_ref = NULL
      WHERE object_id = ?
        AND lifecycle_state = 'active'
    `);
    this.archiveStatement = db.connection.prepare(`
      UPDATE memory_entries
      SET lifecycle_state = 'archived', updated_at = ?
      WHERE object_id = ?
    `);
    this.hardDeleteTombstonedStatement = db.connection.prepare(`
      DELETE FROM memory_entries
      WHERE object_id = ?
        AND retention_state = 'tombstoned'
        AND updated_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')
    `);
    // invariant: only dormant (recall-silent, reversible) rows enter the
    // autonomous-tombstone sweep. retention_state != 'tombstoned' excludes rows
    // a prior sweep already terminalized so the sweep stays idempotent.
    this.findDormantMemoriesStatement = db.connection.prepare(`
      SELECT${MEMORY_ENTRY_SELECT_COLUMNS}
      FROM memory_entries
      WHERE workspace_id = ?
        AND lifecycle_state = 'dormant'
        AND COALESCE(retention_state, '') != 'tombstoned'
      ORDER BY COALESCE(last_hit_at, last_used_at, updated_at, created_at) ASC, object_id ASC
    `);
    // invariant: GATED autonomous tombstone. Writes the durable disposition
    // marker and terminalizes the row in one UPDATE, but ONLY when the row is
    // currently dormant — refuses (changes=0) an active/archived/already-tombstoned
    // row so a recallable memory can never be silently tombstoned. The explicit
    // keep predicates mirror isMemoryExplicitlyProtected at the SQL authority
    // boundary so a concurrent pin / hazard / canon / consolidated promotion
    // between service precheck and UPDATE resolves changes=0.
    this.autonomousTombstoneStatement = db.connection.prepare(`
      UPDATE memory_entries
      SET forget_disposition = ?,
          forget_disposition_ref = ?,
          retention_state = 'tombstoned',
          lifecycle_state = 'tombstone',
          updated_at = ?
      WHERE object_id = ?
        AND lifecycle_state = 'dormant'
        AND COALESCE(retention_state, '') != 'tombstoned'
        AND COALESCE(decay_profile, '') NOT IN ('pinned', 'hazard')
        AND COALESCE(retention_state, '') NOT IN ('canon', 'consolidated')
    `);
    this.findTombstonedWithDispositionStatement = db.connection.prepare(`
      SELECT${MEMORY_ENTRY_SELECT_COLUMNS}
      FROM memory_entries
      WHERE workspace_id = ?
        AND retention_state = 'tombstoned'
        AND forget_disposition IS NOT NULL
        AND updated_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')
      ORDER BY updated_at ASC, object_id ASC
    `);
    // invariant: the disposition gate is restated in SQL (defense in depth). A
    // tombstoned row without a disposition (human Inspector retire) is refused
    // here even though hardDeleteTombstoned would delete it — the autonomous GC
    // never touches an un-preserved/un-judged row.
    this.hardDeleteTombstonedWithDispositionStatement = db.connection.prepare(`
      DELETE FROM memory_entries
      WHERE object_id = ?
        AND retention_state = 'tombstoned'
        AND forget_disposition IS NOT NULL
        AND updated_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')
    `);
    // invariant: the `compressed`-disposition delete re-asserts the preserving
    // capsule's liveness + membership ATOMICALLY in the same DELETE statement, so
    // there is no TOCTOU window between a service-side re-check and the physical
    // removal. The correlated EXISTS subquery deletes the member ONLY while a live
    // capsule (lifecycle_state != 'tombstone' AND synthesis_status != 'archived')
    // STILL lists this object_id in source_memory_refs. A concurrent capsule
    // archive / tombstone / member-drop / cascade-delete makes EXISTS false, so the
    // statement removes 0 rows and the row stays tombstoned (recoverable).
    // see also: packages/core/src/memory-service.ts compressedPreservationStillValid.
    this.hardDeleteTombstonedCompressedGuardedStatement = db.connection.prepare(`
      DELETE FROM memory_entries
      WHERE object_id = ?
        AND retention_state = 'tombstoned'
        AND forget_disposition = 'compressed'
        AND updated_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')
        AND COALESCE(decay_profile, '') NOT IN ('pinned', 'hazard')
        AND COALESCE(retention_state, '') NOT IN ('canon', 'consolidated')
        AND EXISTS (
          SELECT 1
          FROM synthesis_capsules AS capsule,
               json_each(capsule.source_memory_refs) AS member
          WHERE capsule.object_id = memory_entries.forget_disposition_ref
            AND COALESCE(capsule.lifecycle_state, '') != 'tombstone'
            AND COALESCE(capsule.synthesis_status, '') != 'archived'
            AND member.value = memory_entries.object_id
        )
    `);
    // invariant: the `judged_useless` disposition is not trusted just because it
    // was written at tombstone time. The DELETE replays the local-only verdict
    // shape atomically: no evidence refs, no reinforcement, and no explicit-keep
    // protection. A row that gained any of those during grace matches 0 rows and
    // remains tombstoned/recoverable.
    this.hardDeleteTombstonedJudgedUselessGuardedStatement = db.connection.prepare(`
      DELETE FROM memory_entries
      WHERE object_id = ?
        AND retention_state = 'tombstoned'
        AND forget_disposition = 'judged_useless'
        AND forget_disposition_ref IS NULL
        AND json_array_length(COALESCE(evidence_refs, '[]')) = 0
        AND COALESCE(reinforcement_count, 0) = 0
        AND COALESCE(decay_profile, '') NOT IN ('pinned', 'hazard')
        AND COALESCE(retention_state, '') NOT IN ('canon', 'consolidated')
        AND updated_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')
    `);
    this.deleteOrphanedPathRelationsStatement = db.connection.prepare(`
      DELETE FROM path_relations
      WHERE ${PATH_RELATION_SOURCE_BACKING_OBJECT_ID_SQL} = ?
         OR ${PATH_RELATION_TARGET_BACKING_OBJECT_ID_SQL} = ?
    `);
    this.deleteOrphanedCoUsageCountersStatement = db.connection.prepare(`
      DELETE FROM path_relation_co_usage_counters
      WHERE low_memory_id = ? OR high_memory_id = ?
    `);
  }

  public async create(entry: MemoryEntry): Promise<Readonly<MemoryEntry>> {
    const parsedEntry = parseMemoryEntry(entry);
    this.runCreateStatement(parsedEntry);
    return parsedEntry;
  }

  public createWithinTransaction(
    entry: MemoryEntry,
    callbacks: {
      readonly beforeCreate?: () => void;
      readonly afterCreate?: () => void;
    }
  ): Readonly<MemoryEntry> {
    const parsedEntry = parseMemoryEntry(entry);
    const txn = this.db.connection.transaction(() => {
      callbacks.beforeCreate?.();
      this.runCreateStatement(parsedEntry);
      callbacks.afterCreate?.();
    });
    txn.immediate();
    return parsedEntry;
  }

  private runCreateStatement(parsedEntry: Readonly<MemoryEntry>): void {
    try {
      this.createStatement.run(
        parsedEntry.object_id,
        parsedEntry.object_kind,
        parsedEntry.schema_version,
        parsedEntry.lifecycle_state,
        parsedEntry.created_at,
        parsedEntry.updated_at,
        parsedEntry.created_by,
        parsedEntry.dimension,
        parsedEntry.source_kind,
        parsedEntry.formation_kind,
        parsedEntry.scope_class,
        parsedEntry.content,
        JSON.stringify(parsedEntry.domain_tags),
        JSON.stringify(parsedEntry.evidence_refs),
        parsedEntry.workspace_id,
        parsedEntry.run_id,
        parsedEntry.surface_id,
        parsedEntry.storage_tier,
        parsedEntry.activation_score,
        parsedEntry.retention_score,
        parsedEntry.manifestation_state,
        parsedEntry.retention_state,
        parsedEntry.decay_profile,
        parsedEntry.confidence,
        parsedEntry.last_used_at,
        parsedEntry.last_hit_at,
        parsedEntry.reinforcement_count,
        parsedEntry.contradiction_count,
        parsedEntry.superseded_by,
        parsedEntry.forget_disposition ?? null,
        parsedEntry.forget_disposition_ref ?? null
      );
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to create memory entry ${parsedEntry.object_id}.`,
        error
      );
    }
  }

  public async findById(objectId: string): Promise<Readonly<MemoryEntry> | null> {
    try {
      const row = this.findByIdStatement.get(objectId) as MemoryEntryRow | undefined;
      return row === undefined ? null : parseMemoryEntryRow(row);
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to load memory entry ${objectId}.`, error);
    }
  }

  public async findByIds(objectIds: readonly string[]): Promise<readonly Readonly<MemoryEntry>[]> {
    const parsedObjectIds = Array.from(new Set(objectIds.map((objectId) => parseNonEmptyString(objectId, "object_id"))));

    if (parsedObjectIds.length === 0) {
      return [];
    }

    const placeholders = parsedObjectIds.map(() => "?").join(", ");
    const statement = this.db.connection.prepare(`
      SELECT${MEMORY_ENTRY_SELECT_COLUMNS}
      FROM memory_entries
      WHERE object_id IN (${placeholders})
      ORDER BY created_at ASC, object_id ASC
    `);

    try {
      const rows = statement.all(...parsedObjectIds) as MemoryEntryRow[];
      return rows.map((row) => parseMemoryEntryRow(row));
    } catch (error) {
      throw new StorageError("QUERY_FAILED", "Failed to load memory entries by ids.", error);
    }
  }

  public async findByWorkspaceId(
    workspaceId: string,
    tier?: StorageTier
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    try {
      const parsedTier = tier === undefined ? undefined : parseStorageTier(tier);
      const rows =
        parsedTier === undefined || parsedTier === StorageTier.HOT
          ? (this.findByWorkspaceHotStatement.all(workspaceId) as MemoryEntryRow[])
          : (this.findByWorkspaceTierStatement.all(workspaceId, parsedTier) as MemoryEntryRow[]);
      return rows.map((row) => parseMemoryEntryRow(row));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list memory entries for workspace ${workspaceId}.`,
        error
      );
    }
  }

  // Run-scoped reads intentionally include both hot and cold tiers.
  public async findByRunId(runId: string): Promise<readonly Readonly<MemoryEntry>[]> {
    try {
      const rows = this.findByRunIdStatement.all(runId) as MemoryEntryRow[];
      return rows.map((row) => parseMemoryEntryRow(row));
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to list memory entries for run ${runId}.`, error);
    }
  }

  public async findByDimension(
    workspaceId: string,
    dimension: MemoryDimension
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    const parsedDimension = parseMemoryDimension(dimension);

    try {
      const rows = this.findByDimensionHotStatement.all(workspaceId, parsedDimension) as MemoryEntryRow[];
      return rows.map((row) => parseMemoryEntryRow(row));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list memory entries for workspace ${workspaceId} and dimension ${parsedDimension}.`,
        error
      );
    }
  }

  public async findByScopeClass(
    workspaceId: string,
    scopeClass: ScopeClass
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    const parsedScopeClass = parseScopeClass(scopeClass);

    try {
      const rows = this.findByScopeClassHotStatement.all(workspaceId, parsedScopeClass) as MemoryEntryRow[];
      return rows.map((row) => parseMemoryEntryRow(row));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list memory entries for workspace ${workspaceId} and scope class ${parsedScopeClass}.`,
        error
      );
    }
  }

  public async findBySharedDomainTags(
    workspaceId: string,
    tags: readonly string[]
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    const uniqueTags = Array.from(
      new Set(tags.filter((tag) => typeof tag === "string" && tag.length > 0))
    );
    // A new memory with no tags can never reach jaccard(domain_tags) >= the
    // rule gate, so it has no shared-tag candidates; mirror the full-scan
    // outcome (zero INCOMPATIBLE_WITH edges) by returning empty.
    if (uniqueTags.length === 0) {
      return Object.freeze([]);
    }

    // json_each expands the domain_tags JSON array per row; a row with an
    // empty array yields no json_each rows and is therefore excluded
    // (it cannot pass the >=0.35 gate). DISTINCT collapses rows that share
    // more than one tag to a single result. Tier + tombstone + ORDER BY
    // match findByWorkspaceId(hot) so the candidate set is a strict
    // superset of the full-scan candidates with identical iteration order.
    const placeholders = uniqueTags.map(() => "?").join(", ");
    const statement = this.db.connection.prepare(`
      SELECT DISTINCT${MEMORY_ENTRY_SELECT_COLUMNS}
      FROM memory_entries
      JOIN json_each(memory_entries.domain_tags) AS tag
        ON tag.value IN (${placeholders})
      WHERE memory_entries.workspace_id = ?
        AND memory_entries.storage_tier = 'hot'
        AND COALESCE(memory_entries.retention_state, '') != 'tombstoned'
        AND COALESCE(memory_entries.lifecycle_state, '') != 'dormant'
      ORDER BY memory_entries.created_at ASC, memory_entries.object_id ASC
    `);

    try {
      const rows = statement.all(...uniqueTags, workspaceId) as MemoryEntryRow[];
      return Object.freeze(rows.map((row) => parseMemoryEntryRow(row)));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to find memory entries by shared domain tags in workspace ${workspaceId}.`,
        error
      );
    }
  }

  public async findByEvidenceRefs(
    workspaceId: string,
    evidenceObjectIds: readonly string[]
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    const unique = [...new Set(evidenceObjectIds.filter((id) => typeof id === "string" && id.length > 0))];
    if (unique.length === 0) {
      return Object.freeze([]);
    }
    const cappedIds = unique.slice(0, FIND_BY_EVIDENCE_REFS_INPUT_CAP);
    if (unique.length > FIND_BY_EVIDENCE_REFS_INPUT_CAP) {
      // invariant: input over cap -> some evidence ids are not even queried, so
      // their members can never be resolved (fail-safe, but operator-visible).
      this.diagnostics("memory evidence-ref lookup input truncated", {
        workspace_id: workspaceId,
        input_count: unique.length,
        capped_count: FIND_BY_EVIDENCE_REFS_INPUT_CAP
      });
    }
    // invariant: evidence_refs is stored as a JSON array literal (e.g.
    // ["uuid-a","uuid-b"]). We match each candidate id as a JSON-quoted
    // substring so a partial-match on a non-UUID id cannot collide with
    // an unrelated row. ESCAPE keeps LIKE wildcards (`%` / `_`) literal
    // when an id happens to contain them.
    // invariant: callers produce ids in the [A-Za-z0-9_-] alphabet
    // (UUID / generateObjectId surface). The pattern does not escape
    // `"` or `\\`; if a future generator surfaces those, this match
    // is no longer safe — see evidence-capsule-repo and memory-entry
    // generator paths before widening the id alphabet.
    const likePatterns = cappedIds.map(() => `evidence_refs LIKE ? ESCAPE '\\'`);
    const likeValues = cappedIds.map(
      (id) => `%"${id.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")}"%`
    );
    try {
      const rows = this.db.connection
        .prepare(
          `SELECT${MEMORY_ENTRY_SELECT_COLUMNS}
           FROM memory_entries
           WHERE workspace_id = ?
             AND COALESCE(retention_state, '') != 'tombstoned'
             AND COALESCE(lifecycle_state, '') != 'dormant'
             AND (${likePatterns.join(" OR ")})
           ORDER BY object_id ASC
           LIMIT ${FIND_BY_EVIDENCE_REFS_ROW_LIMIT}`
        )
        .all(workspaceId, ...likeValues) as MemoryEntryRow[];
      if (rows.length >= FIND_BY_EVIDENCE_REFS_ROW_LIMIT) {
        // invariant: row scan hit the LIMIT -> members beyond it are omitted
        // (fail-safe: never compressed), but the omission is operator-visible.
        this.diagnostics("memory evidence-ref lookup rows hit LIMIT", {
          workspace_id: workspaceId,
          input_count: cappedIds.length,
          row_limit: FIND_BY_EVIDENCE_REFS_ROW_LIMIT,
          returned_count: rows.length
        });
      }
      return Object.freeze(rows.map((row) => parseMemoryEntryRow(row)));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to find memory entries by evidence_refs in workspace ${workspaceId}.`,
        error
      );
    }
  }

  public async searchByKeyword(
    workspaceId: string,
    queryText: string,
    limit: number
  ): Promise<readonly MemoryEntryKeywordSearchResult[]> {
    try {
      return this.searchKeywordRows({ workspaceId, queryText, limit });
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to search memory entries for workspace ${workspaceId}.`,
        error
      );
    }
  }

  public async searchByKeywordWithinObjectIds(
    workspaceId: string,
    queryText: string,
    limit: number,
    objectIds: readonly string[]
  ): Promise<readonly MemoryEntryKeywordSearchResult[]> {
    const candidateObjectIds = normalizeKeywordSearchObjectIds(objectIds);

    if (candidateObjectIds.length === 0) {
      return Object.freeze([]);
    }

    try {
      return this.searchKeywordRows({
        workspaceId,
        queryText,
        limit,
        candidateObjectIds
      });
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to search filtered memory entries for workspace ${workspaceId}.`,
        error
      );
    }
  }

  public async findLowActivityActiveMemories(
    workspaceId: string
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    try {
      const rows = this.findLowActivityActiveMemoriesStatement.all(workspaceId) as MemoryEntryRow[];
      return rows.map((row) => parseMemoryEntryRow(row));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to find low-activity active memories for workspace ${workspaceId}.`,
        error
      );
    }
  }

  public async findTombstonedMemories(
    workspaceId: string
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    try {
      const rows = this.findTombstonedMemoriesStatement.all(workspaceId) as MemoryEntryRow[];
      return rows.map((row) => parseMemoryEntryRow(row));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to find tombstoned memories for workspace ${workspaceId}.`,
        error
      );
    }
  }

  public async findDormantMemories(
    workspaceId: string
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    try {
      const rows = this.findDormantMemoriesStatement.all(workspaceId) as MemoryEntryRow[];
      return rows.map((row) => parseMemoryEntryRow(row));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to find dormant memories for workspace ${workspaceId}.`,
        error
      );
    }
  }

  public async findTombstonedMemoriesWithDisposition(
    workspaceId: string
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    try {
      const rows = this.findTombstonedWithDispositionStatement.all(workspaceId) as MemoryEntryRow[];
      return rows.map((row) => parseMemoryEntryRow(row));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to find tombstoned-with-disposition memories for workspace ${workspaceId}.`,
        error
      );
    }
  }

  public async autonomousTombstone(
    input: AutonomousTombstoneInput,
    options?: { readonly onTransition?: () => void }
  ): Promise<Readonly<MemoryEntry>> {
    const parsedDisposition = parseForgetDisposition(input.disposition);
    // invariant: judged_useless carries no ref; compressed MUST carry one. This
    // refuses a malformed marker before it reaches the durable column.
    if (parsedDisposition === "judged_useless" && input.dispositionRef !== null) {
      throw new StorageError(
        "VALIDATION_FAILED",
        "judged_useless disposition must not carry a disposition ref."
      );
    }
    if (parsedDisposition === "compressed" && input.dispositionRef === null) {
      throw new StorageError(
        "VALIDATION_FAILED",
        "compressed disposition requires a live synthesis-capsule ref."
      );
    }
    const parsedUpdatedAt = parseUpdatedAt(input.updatedAt);
    const onTransition = options?.onTransition;

    try {
      return this.db.connection.transaction(() => {
        const result = this.autonomousTombstoneStatement.run(
          parsedDisposition,
          input.dispositionRef,
          parsedUpdatedAt,
          input.objectId
        );

        if (result.changes === 0) {
          throw new StorageError(
            "NOT_FOUND",
            `Memory entry ${input.objectId} was not found or is not dormant (not eligible for autonomous tombstone).`
          );
        }

        onTransition?.();

        const updated = this.findByIdStatement.get(input.objectId) as MemoryEntryRow | undefined;
        if (updated === undefined) {
          throw new StorageError(
            "NOT_FOUND",
            `Memory entry ${input.objectId} was not found after autonomous tombstone.`
          );
        }

        return parseMemoryEntryRow(updated);
      })();
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError(
        "QUERY_FAILED",
        `Failed to autonomously tombstone memory entry ${input.objectId}.`,
        error
      );
    }
  }

  public async hardDeleteTombstonedWithDisposition(
    objectId: string,
    options?: {
      readonly requireLiveCapsuleRef?: boolean;
      readonly requireJudgedUselessVerdict?: boolean;
      readonly onDeleted?: () => void;
    }
  ): Promise<boolean> {
    const requireLiveCapsuleRef = options?.requireLiveCapsuleRef === true;
    const requireJudgedUselessVerdict = options?.requireJudgedUselessVerdict === true;
    const onDeleted = options?.onDeleted;
    try {
      if (requireLiveCapsuleRef && requireJudgedUselessVerdict) {
        throw new StorageError(
          "VALIDATION_FAILED",
          "A disposition-gated delete cannot require both compressed-capsule and judged_useless verdict guards."
        );
      }

      return this.db.connection.transaction(() => {
        // invariant: a `compressed` member earned terminal removal ONLY because a
        // live capsule preserved its content. requireLiveCapsuleRef routes the
        // delete through the guarded statement that re-asserts that capsule's
        // liveness + membership atomically. 0 rows changed is the legitimate
        // preservation_revoked outcome (the capsule changed during the grace
        // window), NOT an error: the row stays tombstoned and the caller skips.
        if (requireLiveCapsuleRef) {
          const guarded = this.hardDeleteTombstonedCompressedGuardedStatement.run(objectId);
          if (guarded.changes === 0) {
            return false;
          }
          // invariant: the terminal-removal audit append shares THIS transaction
          // (onDeleted -> eventLogRepo.append joins the open SQLite txn), so the
          // physical delete and its "deleted" audit commit or roll back together;
          // it runs only after changes>0 so a 0-row race emits no spurious audit.
          onDeleted?.();
          this.deleteOrphanedPathRelationsStatement.run(objectId, objectId);
          this.deleteOrphanedCoUsageCountersStatement.run(objectId, objectId);
          return true;
        }

        const result = requireJudgedUselessVerdict
          ? this.hardDeleteTombstonedJudgedUselessGuardedStatement.run(objectId)
          : this.hardDeleteTombstonedWithDispositionStatement.run(objectId);

        if (result.changes === 0) {
          if (requireJudgedUselessVerdict) {
            return false;
          }
          throw new StorageError(
            "NOT_FOUND",
            `Tombstoned memory entry ${objectId} was not found, lacks a forget disposition, or is within the grace window (not eligible for autonomous GC).`
          );
        }

        onDeleted?.();

        // invariant: prune topology only after the disposition-gated row was
        // actually deleted, so a no-disposition row never strips its live paths.
        this.deleteOrphanedPathRelationsStatement.run(objectId, objectId);
        this.deleteOrphanedCoUsageCountersStatement.run(objectId, objectId);
        return true;
      })();
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError(
        "QUERY_FAILED",
        `Failed to autonomously hard-delete memory entry ${objectId}.`,
        error
      );
    }
  }

  public async update(
    objectId: string,
    fields: MemoryEntryRepoUpdateFields
  ): Promise<Readonly<MemoryEntry>> {
    const parsedFields = parseUpdateFields(fields);

    try {
      const result = this.updateStatement.run(
        parsedFields.content ?? null,
        parsedFields.domain_tags === undefined ? null : JSON.stringify(parsedFields.domain_tags),
        parsedFields.evidence_refs === undefined ? null : JSON.stringify(parsedFields.evidence_refs),
        parsedFields.storage_tier ?? null,
        parsedFields.confidence ?? null,
        parsedFields.retention_state ?? null,
        parsedFields.last_used_at ?? null,
        parsedFields.last_hit_at ?? null,
        parsedFields.updated_at,
        objectId
      );

      if (result.changes === 0) {
        throw new StorageError("NOT_FOUND", `Memory entry ${objectId} was not found.`);
      }

      const updated = await this.findById(objectId);

      if (updated === null) {
        throw new StorageError("NOT_FOUND", `Memory entry ${objectId} was not found after update.`);
      }

      return updated;
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError("QUERY_FAILED", `Failed to update memory entry ${objectId}.`, error);
    }
  }

  public async updateScoped(
    objectId: string,
    workspaceId: string,
    fields: MemoryEntryRepoUpdateFields
  ): Promise<Readonly<MemoryEntry>> {
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace_id");
    const parsedFields = parseUpdateFields(fields);

    try {
      const result = this.updateScopedStatement.run(
        parsedFields.content ?? null,
        parsedFields.domain_tags === undefined ? null : JSON.stringify(parsedFields.domain_tags),
        parsedFields.evidence_refs === undefined ? null : JSON.stringify(parsedFields.evidence_refs),
        parsedFields.storage_tier ?? null,
        parsedFields.confidence ?? null,
        parsedFields.retention_state ?? null,
        parsedFields.last_used_at ?? null,
        parsedFields.last_hit_at ?? null,
        parsedFields.updated_at,
        objectId,
        parsedWorkspaceId
      );

      if (result.changes === 0) {
        throw new StorageError("NOT_FOUND", `Memory entry ${objectId} was not found.`);
      }

      const updated = await this.findById(objectId);

      if (updated === null || updated.workspace_id !== parsedWorkspaceId) {
        throw new StorageError("NOT_FOUND", `Memory entry ${objectId} was not found after update.`);
      }

      return updated;
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError("QUERY_FAILED", `Failed to update memory entry ${objectId}.`, error);
    }
  }

  public updateTier(input: MemoryEntryRepoTierUpdateInput): Readonly<MemoryEntry> | null {
    const objectId = parseNonEmptyString(input.objectId, "object_id");
    const workspaceId = parseNonEmptyString(input.workspaceId, "workspace_id");
    const fromTier = parseStorageTier(input.fromTier);
    const toTier = parseStorageTier(input.toTier);
    const updatedAt = parseUpdatedAt(input.updatedAt);
    const expectedUpdatedAt = parseUpdatedAt(input.expectedUpdatedAt);
    const lastUsedAt = input.lastUsedAt === undefined ? undefined : parseUpdatedAt(input.lastUsedAt);
    const lastHitAt = input.lastHitAt === undefined ? undefined : parseUpdatedAt(input.lastHitAt);
    const activationBump = input.activationBump ?? 0;
    if (!Number.isFinite(activationBump) || activationBump < 0 || activationBump > 1) {
      throw new StorageError("VALIDATION_FAILED", "Failed to validate activation tier bump.");
    }

    try {
      const result = this.db.connection
        .prepare(
          `UPDATE memory_entries
           SET storage_tier = ?,
               activation_score = min(1.0, COALESCE(activation_score, 0.0) + ?),
               last_used_at = COALESCE(?, last_used_at),
               last_hit_at = COALESCE(?, last_hit_at),
               updated_at = ?
           WHERE object_id = ?
             AND workspace_id = ?
             AND storage_tier = ?
             AND updated_at = ?`
        )
        .run(
          toTier,
          activationBump,
          lastUsedAt ?? null,
          lastHitAt ?? null,
          updatedAt,
          objectId,
          workspaceId,
          fromTier,
          expectedUpdatedAt
        );

      if (result.changes === 0) {
        return null;
      }

      const row = this.findByIdStatement.get(objectId) as MemoryEntryRow | undefined;
      if (row === undefined) {
        throw new StorageError("NOT_FOUND", `Memory entry ${objectId} was not found after tier update.`);
      }
      return parseMemoryEntryRow(row);
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError("QUERY_FAILED", `Failed to update memory entry tier for ${objectId}.`, error);
    }
  }

  public async archive(objectId: string, updatedAt: string): Promise<Readonly<MemoryEntry>> {
    const parsedUpdatedAt = parseUpdatedAt(updatedAt);

    try {
      const result = this.archiveStatement.run(parsedUpdatedAt, objectId);

      if (result.changes === 0) {
        throw new StorageError("NOT_FOUND", `Memory entry ${objectId} was not found.`);
      }

      const archived = await this.findById(objectId);

      if (archived === null) {
        throw new StorageError("NOT_FOUND", `Memory entry ${objectId} was not found after archive.`);
      }

      return archived;
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError("QUERY_FAILED", `Failed to archive memory entry ${objectId}.`, error);
    }
  }

  public async updateDynamics(
    objectId: string,
    fields: MemoryEntryRepoDynamicsUpdateFields,
    updatedAt: string
  ): Promise<Readonly<MemoryEntry>> {
    const parsedFields = parseDynamicsUpdateFields(fields);
    const parsedUpdatedAt = parseUpdatedAt(updatedAt);

    // Build the SET clause dynamically so that:
    // - undefined fields are omitted (keep existing DB value)
    // - null fields are SET to NULL (explicit clear)
    // - value fields are SET to the provided value
    // The fixed COALESCE pattern could not distinguish undefined from null, so
    // callers could not clear a nullable field back to null via this method.
    const setClauses: string[] = [
      "activation_score = ?",
      "retention_score = ?",
      "manifestation_state = ?"
    ];
    const params: Array<string | number | null> = [
      parsedFields.activation_score,
      parsedFields.retention_score,
      parsedFields.manifestation_state as string
    ];

    const optionalFields: Array<readonly [string, string | number | null | undefined]> = [
      ["retention_state", parsedFields.retention_state as string | null | undefined],
      ["last_used_at", parsedFields.last_used_at],
      ["last_hit_at", parsedFields.last_hit_at],
      ["reinforcement_count", parsedFields.reinforcement_count],
      ["contradiction_count", parsedFields.contradiction_count],
      ["superseded_by", parsedFields.superseded_by]
    ];

    for (const [column, value] of optionalFields) {
      if (value !== undefined) {
        setClauses.push(`${column} = ?`);
        params.push(value ?? null);
      }
    }

    setClauses.push("updated_at = ?");
    params.push(parsedUpdatedAt);
    params.push(objectId);

    try {
      const result = this.db.connection
        .prepare(`UPDATE memory_entries SET ${setClauses.join(", ")} WHERE object_id = ?`)
        .run(...params);

      if (result.changes === 0) {
        throw new StorageError("NOT_FOUND", `Memory entry ${objectId} was not found.`);
      }

      const updated = await this.findById(objectId);

      if (updated === null) {
        throw new StorageError("NOT_FOUND", `Memory entry ${objectId} was not found after update.`);
      }

      return updated;
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError(
        "QUERY_FAILED",
        `Failed to update dynamics for memory entry ${objectId}.`,
        error
      );
    }
  }

  public async transitionLifecycle(
    objectId: string,
    lifecycleState: MemoryEntry["lifecycle_state"],
    updatedAt: string
  ): Promise<Readonly<MemoryEntry>> {
    const parsedLifecycleState = parseLifecycleState(lifecycleState);
    const parsedUpdatedAt = parseUpdatedAt(updatedAt);

    try {
      // invariant (I3): transitioning to any NON-tombstone state clears the
      // terminal forget marker; only a tombstone transition keeps it (the
      // marker is what authorizes the disposition-gated GC).
      const statement =
        parsedLifecycleState === "tombstone"
          ? this.transitionLifecycleStatement
          : this.transitionLifecycleClearForgetStatement;
      const result = statement.run(parsedLifecycleState, parsedUpdatedAt, objectId);

      if (result.changes === 0) {
        throw new StorageError("NOT_FOUND", `Memory entry ${objectId} was not found.`);
      }

      const updated = await this.findById(objectId);

      if (updated === null) {
        throw new StorageError("NOT_FOUND", `Memory entry ${objectId} was not found after lifecycle update.`);
      }

      return updated;
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError(
        "QUERY_FAILED",
        `Failed to transition lifecycle for memory entry ${objectId}.`,
        error
      );
    }
  }

  // invariant (N1): guarded reversible revival. Returns the updated row when the
  // memory was dormant and is now active; returns null when the row was NOT
  // dormant (changes=0) so the caller can skip emitting a spurious
  // from_state="dormant" -> "active" audit event for an already-active row.
  public async reviveDormant(
    objectId: string,
    updatedAt: string
  ): Promise<Readonly<MemoryEntry> | null> {
    const parsedUpdatedAt = parseUpdatedAt(updatedAt);
    try {
      const result = this.reviveDormantStatement.run(parsedUpdatedAt, objectId);
      if (result.changes === 0) {
        return null;
      }
      const updated = await this.findById(objectId);
      if (updated === null) {
        throw new StorageError("NOT_FOUND", `Memory entry ${objectId} was not found after revival.`);
      }
      return updated;
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }
      throw new StorageError("QUERY_FAILED", `Failed to revive dormant memory entry ${objectId}.`, error);
    }
  }

  // invariant: guarded reversible demotion. Returns the demoted row when the
  // memory was active and is now dormant; returns null when the row was NOT
  // active (changes=0) so the caller skips emitting a spurious from_state="active"
  // audit for a row a concurrent revival / overlapping sweep / Inspector retire
  // already moved. onTransition (the active->dormant audit append) runs INSIDE
  // this transaction and ONLY on changes>0, so it commits atomically with the
  // UPDATE and never fires on the benign no-op skip.
  public async transitionToDormantIfActive(
    objectId: string,
    updatedAt: string,
    onTransition?: () => void
  ): Promise<Readonly<MemoryEntry> | null> {
    const parsedUpdatedAt = parseUpdatedAt(updatedAt);
    try {
      const demoted = this.db.connection.transaction(() => {
        const result = this.demoteActiveToDormantStatement.run(parsedUpdatedAt, objectId);
        if (result.changes === 0) {
          return false;
        }
        onTransition?.();
        return true;
      })();
      if (!demoted) {
        return null;
      }
      const updated = await this.findById(objectId);
      if (updated === null) {
        throw new StorageError("NOT_FOUND", `Memory entry ${objectId} was not found after dormant demotion.`);
      }
      return updated;
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to demote active memory entry ${objectId} to dormant.`,
        error
      );
    }
  }

  public async hardDeleteTombstoned(objectId: string): Promise<void> {
    try {
      this.db.connection.transaction(() => {
        const result = this.hardDeleteTombstonedStatement.run(objectId);

        if (result.changes === 0) {
          throw new StorageError(
            "NOT_FOUND",
            `Tombstoned memory entry ${objectId} was not found or is not eligible for deletion.`
          );
        }

        // invariant: only prune once the memory row actually qualified and was
        // deleted, so an ineligible (non-tombstoned / <24h) row never strips its
        // live path topology.
        this.deleteOrphanedPathRelationsStatement.run(objectId, objectId);
        this.deleteOrphanedCoUsageCountersStatement.run(objectId, objectId);
      })();
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError(
        "QUERY_FAILED",
        `Failed to hard-delete tombstoned memory entry ${objectId}.`,
        error
      );
    }
  }

  private searchKeywordRows(params: Readonly<{
    readonly workspaceId: string;
    readonly queryText: string;
    readonly limit: number;
    readonly candidateObjectIds?: readonly string[];
  }>): readonly MemoryEntryKeywordSearchResult[] {
    const tokens = tokenizeFtsQuery(params.queryText);

    if (tokens.length === 0 || !Number.isInteger(params.limit) || params.limit <= 0) {
      return Object.freeze([]);
    }

    const shortTokens = tokens.filter((token) => countQueryCodepoints(token) < 3);
    const trigramTokens = tokens.filter((token) => countQueryCodepoints(token) >= 3);
    // Dual-index routing: the trigram table stays the substring/CJK source
    // for every long token; word-like Latin/space-delimited tokens are
    // additionally probed against the porter+unicode61 table so English
    // ranking gets stemmed word-level BM25. A mixed query consults both.
    const porterTokens = trigramTokens.filter((token) => !tokenBearsCjk(token));
    const exactRows = this.searchExactKeywordRows(
      params.workspaceId,
      shortTokens,
      params.limit,
      params.candidateObjectIds
    );
    const trigramRows = this.searchTrigramKeywordRows(
      params.workspaceId,
      trigramTokens,
      params.limit,
      params.candidateObjectIds
    );
    const porterRows = this.searchPorterKeywordRows(
      params.workspaceId,
      porterTokens,
      params.limit,
      params.candidateObjectIds
    );
    const mergedRows = mergeKeywordSearchRows(
      exactRows,
      trigramRows,
      params.limit,
      porterRows
    );

    return Object.freeze(
      mergedRows.map((row) =>
        Object.freeze({
          object_id: row.object_id,
          normalized_rank: row.normalized_rank,
          ...(row.trigram_rank !== undefined ? { trigram_rank: row.trigram_rank } : {})
        })
      )
    );
  }

  private searchExactKeywordRows(
    workspaceId: string,
    tokens: readonly string[],
    limit: number,
    candidateObjectIds?: readonly string[]
  ): readonly ExactKeywordSearchRow[] {
    if (tokens.length === 0) {
      return [];
    }

    const tokenMatchers = tokens.map((token) => createShortKeywordMatcher(token));
    const objectIdFilter = buildObjectIdFilterSql(candidateObjectIds);
    const rows = this.db.connection.prepare(`
      SELECT
        object_id,
        content
      FROM memory_entries
      WHERE workspace_id = ?
      AND COALESCE(retention_state, '') != 'tombstoned'
      AND COALESCE(lifecycle_state, '') != 'dormant'
      ${objectIdFilter.sql}
      ORDER BY object_id ASC
    `).all(workspaceId, ...objectIdFilter.params) as readonly ExactKeywordCandidateRow[];

    return rows
      .map((row) =>
        Object.freeze({
          object_id: row.object_id,
          matched_token_count: tokenMatchers.reduce(
            (count, matcher) => count + (matcher(row.content) ? 1 : 0),
            0
          )
        })
      )
      .filter((row) => row.matched_token_count > 0)
      .sort((left, right) => {
        const matchDelta = right.matched_token_count - left.matched_token_count;
        if (matchDelta !== 0) {
          return matchDelta;
        }

        return left.object_id.localeCompare(right.object_id);
      })
      .slice(0, limit);
  }

  private searchTrigramKeywordRowsWithinObjectIds(
    workspaceId: string,
    tokens: readonly string[],
    limit: number,
    candidateObjectIds: readonly string[]
  ): readonly FtsKeywordSearchRow[] {
    const objectIdFilter = buildObjectIdFilterSql(candidateObjectIds, "memory_content_fts.object_id");

    return this.db.connection.prepare(`
      SELECT
        memory_content_fts.object_id,
        bm25(memory_content_fts) AS raw_rank
      FROM memory_content_fts
      JOIN memory_entries ON memory_entries.object_id = memory_content_fts.object_id
      WHERE
        memory_content_fts.workspace_id = ?
        AND memory_content_fts MATCH ?
        AND COALESCE(memory_entries.retention_state, '') != 'tombstoned'
        AND COALESCE(memory_entries.lifecycle_state, '') != 'dormant'
      ${objectIdFilter.sql}
      ORDER BY raw_rank ASC, memory_content_fts.object_id ASC
      LIMIT ?
    `).all(
      workspaceId,
      tokens.map((token) => `"${token}"`).join(" OR "),
      ...objectIdFilter.params,
      limit
    ) as readonly FtsKeywordSearchRow[];
  }

  private searchTrigramKeywordRows(
    workspaceId: string,
    tokens: readonly string[],
    limit: number,
    candidateObjectIds?: readonly string[]
  ): readonly FtsKeywordSearchRow[] {
    if (tokens.length === 0) {
      return [];
    }

    if (candidateObjectIds !== undefined) {
      return this.searchTrigramKeywordRowsWithinObjectIds(
        workspaceId,
        tokens,
        limit,
        candidateObjectIds
      );
    }

    return this.searchByKeywordStatement.all(
      workspaceId,
      tokens.map((token) => `"${token}"`).join(" OR "),
      limit
    ) as readonly FtsKeywordSearchRow[];
  }

  private searchPorterKeywordRowsWithinObjectIds(
    workspaceId: string,
    tokens: readonly string[],
    limit: number,
    candidateObjectIds: readonly string[]
  ): readonly FtsKeywordSearchRow[] {
    const objectIdFilter = buildObjectIdFilterSql(
      candidateObjectIds,
      "memory_content_fts_porter.object_id"
    );

    return this.db.connection.prepare(`
      SELECT
        memory_content_fts_porter.object_id,
        bm25(memory_content_fts_porter) AS raw_rank
      FROM memory_content_fts_porter
      JOIN memory_entries ON memory_entries.object_id = memory_content_fts_porter.object_id
      WHERE
        memory_content_fts_porter.workspace_id = ?
        AND memory_content_fts_porter MATCH ?
        AND COALESCE(memory_entries.retention_state, '') != 'tombstoned'
        AND COALESCE(memory_entries.lifecycle_state, '') != 'dormant'
      ${objectIdFilter.sql}
      ORDER BY raw_rank ASC, memory_content_fts_porter.object_id ASC
      LIMIT ?
    `).all(
      workspaceId,
      tokens.map((token) => `"${token}"`).join(" OR "),
      ...objectIdFilter.params,
      limit
    ) as readonly FtsKeywordSearchRow[];
  }

  private searchPorterKeywordRows(
    workspaceId: string,
    tokens: readonly string[],
    limit: number,
    candidateObjectIds?: readonly string[]
  ): readonly FtsKeywordSearchRow[] {
    if (tokens.length === 0) {
      return [];
    }

    if (candidateObjectIds !== undefined) {
      return this.searchPorterKeywordRowsWithinObjectIds(
        workspaceId,
        tokens,
        limit,
        candidateObjectIds
      );
    }

    return this.searchByKeywordPorterStatement.all(
      workspaceId,
      tokens.map((token) => `"${token}"`).join(" OR "),
      limit
    ) as readonly FtsKeywordSearchRow[];
  }
}
