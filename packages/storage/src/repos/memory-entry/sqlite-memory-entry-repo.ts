import {
  StorageTier,
  type MemoryDimension,
  type MemoryEntry,
  type ScopeClass
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../sqlite/db.js";
import { StorageError } from "../../shared/errors.js";
import {
  PATH_RELATION_SOURCE_BACKING_OBJECT_ID_SQL,
  PATH_RELATION_TARGET_BACKING_OBJECT_ID_SQL
} from "../path-relation-repo.js";
import { parseNonEmptyString } from "../shared/validators.js";
import {
  autonomousTombstone,
  archiveMemoryEntry,
  hardDeleteTombstonedMemoryEntry,
  hardDeleteTombstonedWithDisposition,
  reviveDormantMemoryEntry,
  transitionMemoryEntryLifecycle,
  transitionMemoryEntryToDormantIfActive,
  type MemoryEntryLifecycleWorkflowHost
} from "./lifecycle-workflows.js";
import {
  searchByKeyword,
  searchByKeywordWithinObjectIds,
  type MemoryEntrySearchWorkflowHost
} from "./search-workflows.js";
import {
  MEMORY_ENTRY_SELECT_COLUMNS,
  parseMemoryDimension,
  parseMemoryEntry,
  parseMemoryEntryRow,
  parseScopeClass,
  parseStorageTier,
  type MemoryEntryRow
} from "./row-mapper.js";
import {
  updateMemoryEntry,
  updateMemoryEntryDynamics,
  updateMemoryEntryTier,
  updateScopedMemoryEntry,
  type MemoryEntryUpdateWorkflowHost
} from "./update-workflows.js";
import {
  FIND_BY_EVIDENCE_REFS_INPUT_CAP,
  FIND_BY_EVIDENCE_REFS_ROW_LIMIT,
  type AutonomousTombstoneInput,
  type MemoryEntryKeywordSearchResult,
  type MemoryEntryRepo,
  type MemoryEntryRepoDiagnosticSink,
  type MemoryEntryRepoDynamicsUpdateFields,
  type MemoryEntryRepoTierUpdateInput,
  type MemoryEntryRepoUpdateFields
} from "./types.js";

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
  private readonly searchByKeywordStatement;
  // see also: packages/storage/src/migrations/077-memory-content-fts-dual.sql
  private readonly searchByKeywordPorterStatement;
  private readonly findLowActivityActiveMemoriesStatement;
  private readonly findTombstonedMemoriesStatement;
  private readonly transitionLifecycleStatement;
  // invariant (I3): a revived / non-tombstone transition clears the terminal
  // forget marker so an active/dormant row never carries a removal disposition.
  private readonly transitionLifecycleClearForgetStatement;
  // invariant (N1): guarded dormant -> active revival; changes=0 when not dormant.
  private readonly reviveDormantStatement;
  // invariant: active -> dormant skips benign changes=0 races and clears forget markers.
  private readonly demoteActiveToDormantStatement;
  private readonly archiveStatement;
  private readonly hardDeleteTombstonedStatement;
  private readonly findDormantMemoriesStatement;
  private readonly autonomousTombstoneStatement;
  private readonly findTombstonedWithDispositionStatement;
  private readonly hardDeleteTombstonedWithDispositionStatement;
  // invariant: compressed delete rechecks capsule liveness atomically with removal.
  private readonly hardDeleteTombstonedCompressedGuardedStatement;
  // invariant: judged_useless delete replays the local-only verdict at delete time.
  private readonly hardDeleteTombstonedJudgedUselessGuardedStatement;
  // invariant: hard-delete prunes path topology because endpoints are not FK-backed.
  private readonly deleteOrphanedPathRelationsStatement;
  private readonly deleteOrphanedCoUsageCountersStatement;

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
    // invariant: recall/list loads exclude tombstoned and dormant rows; findById stays unfiltered.
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
    // invariant (I3): non-tombstone transitions clear terminal forget markers.
    this.transitionLifecycleClearForgetStatement = db.connection.prepare(`
      UPDATE memory_entries
      SET lifecycle_state = ?,
          updated_at = ?,
          forget_disposition = NULL,
          forget_disposition_ref = NULL
      WHERE object_id = ?
    `);
    // invariant (N1): dormant -> active reports changes=0 for duplicate revivals.
    this.reviveDormantStatement = db.connection.prepare(`
      UPDATE memory_entries
      SET lifecycle_state = 'active',
          updated_at = ?,
          forget_disposition = NULL,
          forget_disposition_ref = NULL
      WHERE object_id = ?
        AND lifecycle_state = 'dormant'
    `);
  // invariant: active -> dormant mirrors reviveDormant and skips non-active races.
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
    // invariant: autonomous tombstone sweep starts from dormant, non-tombstoned rows.
    this.findDormantMemoriesStatement = db.connection.prepare(`
      SELECT${MEMORY_ENTRY_SELECT_COLUMNS}
      FROM memory_entries
      WHERE workspace_id = ?
        AND lifecycle_state = 'dormant'
        AND COALESCE(retention_state, '') != 'tombstoned'
      ORDER BY COALESCE(last_hit_at, last_used_at, updated_at, created_at) ASC, object_id ASC
    `);
    // invariant: autonomous tombstone terminalizes only dormant, not-explicitly-protected rows.
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
    // invariant: autonomous GC refuses tombstones that lack a forget disposition.
    this.hardDeleteTombstonedWithDispositionStatement = db.connection.prepare(`
      DELETE FROM memory_entries
      WHERE object_id = ?
        AND retention_state = 'tombstoned'
        AND forget_disposition IS NOT NULL
        AND updated_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')
    `);
    // invariant: compressed GC deletes only while the preserving capsule is still live.
    // see also: packages/core/src/memory/memory-service/service.ts:MemoryService.compressedPreservationStillValid
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
    // invariant: judged_useless GC replays the no-evidence/no-reinforcement verdict.
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
    return searchByKeyword.call(this as unknown as MemoryEntrySearchWorkflowHost, workspaceId, queryText, limit);
  }

  public async searchByKeywordWithinObjectIds(
    workspaceId: string,
    queryText: string,
    limit: number,
    objectIds: readonly string[]
  ): Promise<readonly MemoryEntryKeywordSearchResult[]> {
    return searchByKeywordWithinObjectIds.call(
      this as unknown as MemoryEntrySearchWorkflowHost,
      workspaceId,
      queryText,
      limit,
      objectIds
    );
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
    return autonomousTombstone.call(this as unknown as MemoryEntryLifecycleWorkflowHost, input, options);
  }

  public async hardDeleteTombstonedWithDisposition(
    objectId: string,
    options?: {
      readonly requireLiveCapsuleRef?: boolean;
      readonly requireJudgedUselessVerdict?: boolean;
      readonly onDeleted?: () => void;
    }
  ): Promise<boolean> {
    return hardDeleteTombstonedWithDisposition.call(
      this as unknown as MemoryEntryLifecycleWorkflowHost,
      objectId,
      options
    );
  }

  public async update(
    objectId: string,
    fields: MemoryEntryRepoUpdateFields
  ): Promise<Readonly<MemoryEntry>> {
    return updateMemoryEntry.call(this as unknown as MemoryEntryUpdateWorkflowHost, objectId, fields);
  }

  public async updateScoped(
    objectId: string,
    workspaceId: string,
    fields: MemoryEntryRepoUpdateFields
  ): Promise<Readonly<MemoryEntry>> {
    return updateScopedMemoryEntry.call(
      this as unknown as MemoryEntryUpdateWorkflowHost,
      objectId,
      workspaceId,
      fields
    );
  }

  public updateTier(input: MemoryEntryRepoTierUpdateInput): Readonly<MemoryEntry> | null {
    return updateMemoryEntryTier.call(this as unknown as MemoryEntryUpdateWorkflowHost, input);
  }

  public async archive(objectId: string, updatedAt: string): Promise<Readonly<MemoryEntry>> {
    return archiveMemoryEntry.call(this as unknown as MemoryEntryLifecycleWorkflowHost, objectId, updatedAt);
  }

  public async updateDynamics(
    objectId: string,
    fields: MemoryEntryRepoDynamicsUpdateFields,
    updatedAt: string
  ): Promise<Readonly<MemoryEntry>> {
    return updateMemoryEntryDynamics.call(
      this as unknown as MemoryEntryUpdateWorkflowHost,
      objectId,
      fields,
      updatedAt
    );
  }

  public async transitionLifecycle(
    objectId: string,
    lifecycleState: MemoryEntry["lifecycle_state"],
    updatedAt: string
  ): Promise<Readonly<MemoryEntry>> {
    return transitionMemoryEntryLifecycle.call(
      this as unknown as MemoryEntryLifecycleWorkflowHost,
      objectId,
      lifecycleState,
      updatedAt
    );
  }

  public async reviveDormant(
    objectId: string,
    updatedAt: string
  ): Promise<Readonly<MemoryEntry> | null> {
    return reviveDormantMemoryEntry.call(this as unknown as MemoryEntryLifecycleWorkflowHost, objectId, updatedAt);
  }

  public async transitionToDormantIfActive(
    objectId: string,
    updatedAt: string,
    onTransition?: () => void
  ): Promise<Readonly<MemoryEntry> | null> {
    return transitionMemoryEntryToDormantIfActive.call(
      this as unknown as MemoryEntryLifecycleWorkflowHost,
      objectId,
      updatedAt,
      onTransition
    );
  }

  public async hardDeleteTombstoned(objectId: string): Promise<void> {
    return hardDeleteTombstonedMemoryEntry.call(this as unknown as MemoryEntryLifecycleWorkflowHost, objectId);
  }
}
