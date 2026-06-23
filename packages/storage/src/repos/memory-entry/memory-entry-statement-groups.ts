import type { StorageDatabase } from "../../sqlite/db.js";
import {
  PATH_RELATION_SOURCE_BACKING_OBJECT_ID_SQL,
  PATH_RELATION_TARGET_BACKING_OBJECT_ID_SQL
} from "../path/path-relation-repo.js";
import { MEMORY_ENTRY_SELECT_COLUMNS } from "./row-mapper.js";
import type {
  SqliteAllStatement,
  SqliteGetStatement,
  SqliteRunStatement
} from "./statement-types.js";

type SqliteStatement = SqliteRunStatement & SqliteGetStatement & SqliteAllStatement;
type SqlDefinitionMap<T extends object> = { readonly [K in keyof T]: string };
type StatementMap<T extends object> = { -readonly [K in keyof T]: SqliteStatement };

export interface MemoryEntryCreateStatements {
  readonly createStatement: SqliteStatement;
}

export interface MemoryEntryReadStatements {
  readonly findByIdStatement: SqliteStatement;
  readonly findByWorkspaceHotStatement: SqliteStatement;
  readonly findByWorkspaceHotPagedStatement: SqliteStatement;
  readonly countByWorkspaceHotStatement: SqliteStatement;
  readonly findByWorkspaceTierStatement: SqliteStatement;
  readonly findByWorkspaceTierPagedStatement: SqliteStatement;
  readonly countByWorkspaceTierStatement: SqliteStatement;
  readonly findByRunIdStatement: SqliteStatement;
  readonly findByRunIdPagedStatement: SqliteStatement;
  readonly countByRunIdStatement: SqliteStatement;
  readonly findByDimensionHotStatement: SqliteStatement;
  readonly findByDimensionHotPagedStatement: SqliteStatement;
  readonly countByDimensionHotStatement: SqliteStatement;
  readonly findByScopeClassHotStatement: SqliteStatement;
  readonly findByScopeClassHotPagedStatement: SqliteStatement;
}

export interface MemoryEntryUpdateStatements {
  readonly updateStatement: SqliteStatement;
  readonly updateScopedStatement: SqliteStatement;
}

export interface MemoryEntrySearchStatements {
  readonly searchByKeywordStatement: SqliteStatement;
  readonly searchByKeywordPorterStatement: SqliteStatement;
}

export interface MemoryEntryLifecycleStatements {
  readonly findLowActivityActiveMemoriesStatement: SqliteStatement;
  readonly findTombstonedMemoriesStatement: SqliteStatement;
  readonly transitionLifecycleStatement: SqliteStatement;
  readonly transitionLifecycleClearForgetStatement: SqliteStatement;
  readonly reviveDormantStatement: SqliteStatement;
  readonly demoteActiveToDormantStatement: SqliteStatement;
  readonly archiveStatement: SqliteStatement;
  readonly hardDeleteTombstonedStatement: SqliteStatement;
  readonly findDormantMemoriesStatement: SqliteStatement;
  readonly autonomousTombstoneStatement: SqliteStatement;
}

export interface MemoryEntryGarbageCollectionStatements {
  readonly findTombstonedWithDispositionStatement: SqliteStatement;
  readonly hardDeleteTombstonedWithDispositionStatement: SqliteStatement;
  readonly hardDeleteTombstonedCompressedGuardedStatement: SqliteStatement;
  readonly hardDeleteTombstonedJudgedUselessGuardedStatement: SqliteStatement;
  readonly deleteOrphanedPathRelationsStatement: SqliteStatement;
  readonly deleteOrphanedCoUsageCountersStatement: SqliteStatement;
}

const ACTIVE_MEMORY_FILTER_SQL = `
        AND COALESCE(retention_state, '') != 'tombstoned'
        AND COALESCE(lifecycle_state, '') != 'dormant'
`;

const MEMORY_ENTRY_CREATE_SQL: SqlDefinitionMap<MemoryEntryCreateStatements> = {
  createStatement: `
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
        projection_schema_version,
        event_time_start,
        event_time_end,
        valid_from,
        valid_to,
        time_precision,
        time_source,
        preference_subject,
        preference_predicate,
        preference_object,
        preference_category,
        preference_polarity,
        forget_disposition,
        forget_disposition_ref
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
};

const MEMORY_ENTRY_READ_SQL: SqlDefinitionMap<MemoryEntryReadStatements> = {
  findByIdStatement: `
      SELECT${MEMORY_ENTRY_SELECT_COLUMNS}
      FROM memory_entries
      WHERE object_id = ?
      LIMIT 1
    `,
  findByWorkspaceHotStatement: `
      SELECT${MEMORY_ENTRY_SELECT_COLUMNS}
      FROM memory_entries
      WHERE workspace_id = ? AND storage_tier = 'hot'
${ACTIVE_MEMORY_FILTER_SQL}      ORDER BY created_at ASC, object_id ASC
    `,
  findByWorkspaceHotPagedStatement: `
      SELECT${MEMORY_ENTRY_SELECT_COLUMNS}
      FROM memory_entries
      WHERE workspace_id = ? AND storage_tier = 'hot'
${ACTIVE_MEMORY_FILTER_SQL}      ORDER BY created_at ASC, object_id ASC
      LIMIT ? OFFSET ?
    `,
  countByWorkspaceHotStatement: `
      SELECT COUNT(*) AS total
      FROM memory_entries
      WHERE workspace_id = ? AND storage_tier = 'hot'
${ACTIVE_MEMORY_FILTER_SQL}    `,
  findByWorkspaceTierStatement: `
      SELECT${MEMORY_ENTRY_SELECT_COLUMNS}
      FROM memory_entries
      WHERE workspace_id = ? AND storage_tier = ?
${ACTIVE_MEMORY_FILTER_SQL}      ORDER BY created_at ASC, object_id ASC
    `,
  findByWorkspaceTierPagedStatement: `
      SELECT${MEMORY_ENTRY_SELECT_COLUMNS}
      FROM memory_entries
      WHERE workspace_id = ? AND storage_tier = ?
${ACTIVE_MEMORY_FILTER_SQL}      ORDER BY created_at ASC, object_id ASC
      LIMIT ? OFFSET ?
    `,
  countByWorkspaceTierStatement: `
      SELECT COUNT(*) AS total
      FROM memory_entries
      WHERE workspace_id = ? AND storage_tier = ?
${ACTIVE_MEMORY_FILTER_SQL}    `,
  findByRunIdStatement: `
      SELECT${MEMORY_ENTRY_SELECT_COLUMNS}
      FROM memory_entries
      WHERE run_id = ?
${ACTIVE_MEMORY_FILTER_SQL}      ORDER BY created_at ASC, object_id ASC
    `,
  findByRunIdPagedStatement: `
      SELECT${MEMORY_ENTRY_SELECT_COLUMNS}
      FROM memory_entries
      WHERE run_id = ?
${ACTIVE_MEMORY_FILTER_SQL}      ORDER BY created_at ASC, object_id ASC
      LIMIT ? OFFSET ?
    `,
  countByRunIdStatement: `
      SELECT COUNT(*) AS total
      FROM memory_entries
      WHERE run_id = ?
${ACTIVE_MEMORY_FILTER_SQL}    `,
  findByDimensionHotStatement: `
      SELECT${MEMORY_ENTRY_SELECT_COLUMNS}
      FROM memory_entries
      WHERE workspace_id = ? AND dimension = ? AND storage_tier = 'hot'
${ACTIVE_MEMORY_FILTER_SQL}      ORDER BY created_at ASC, object_id ASC
    `,
  findByDimensionHotPagedStatement: `
      SELECT${MEMORY_ENTRY_SELECT_COLUMNS}
      FROM memory_entries
      WHERE workspace_id = ? AND dimension = ? AND storage_tier = 'hot'
${ACTIVE_MEMORY_FILTER_SQL}      ORDER BY created_at ASC, object_id ASC
      LIMIT ? OFFSET ?
    `,
  countByDimensionHotStatement: `
      SELECT COUNT(*) AS total
      FROM memory_entries
      WHERE workspace_id = ? AND dimension = ? AND storage_tier = 'hot'
${ACTIVE_MEMORY_FILTER_SQL}    `,
  findByScopeClassHotStatement: `
      SELECT${MEMORY_ENTRY_SELECT_COLUMNS}
      FROM memory_entries
      WHERE workspace_id = ? AND scope_class = ? AND storage_tier = 'hot'
${ACTIVE_MEMORY_FILTER_SQL}      ORDER BY created_at ASC, object_id ASC
    `,
  findByScopeClassHotPagedStatement: `
      SELECT${MEMORY_ENTRY_SELECT_COLUMNS}
      FROM memory_entries
      WHERE workspace_id = ? AND scope_class = ? AND storage_tier = 'hot'
${ACTIVE_MEMORY_FILTER_SQL}      ORDER BY created_at ASC, object_id ASC
      LIMIT ? OFFSET ?
    `
};

const MEMORY_ENTRY_UPDATE_SQL: SqlDefinitionMap<MemoryEntryUpdateStatements> = {
  updateStatement: `
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
        projection_schema_version = CASE WHEN ? THEN ? ELSE projection_schema_version END,
        event_time_start = CASE WHEN ? THEN ? ELSE event_time_start END,
        event_time_end = CASE WHEN ? THEN ? ELSE event_time_end END,
        valid_from = CASE WHEN ? THEN ? ELSE valid_from END,
        valid_to = CASE WHEN ? THEN ? ELSE valid_to END,
        time_precision = CASE WHEN ? THEN ? ELSE time_precision END,
        time_source = CASE WHEN ? THEN ? ELSE time_source END,
        preference_subject = CASE WHEN ? THEN ? ELSE preference_subject END,
        preference_predicate = CASE WHEN ? THEN ? ELSE preference_predicate END,
        preference_object = CASE WHEN ? THEN ? ELSE preference_object END,
        preference_category = CASE WHEN ? THEN ? ELSE preference_category END,
        preference_polarity = CASE WHEN ? THEN ? ELSE preference_polarity END,
        updated_at = ?
      WHERE object_id = ?
    `,
  updateScopedStatement: `
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
        projection_schema_version = CASE WHEN ? THEN ? ELSE projection_schema_version END,
        event_time_start = CASE WHEN ? THEN ? ELSE event_time_start END,
        event_time_end = CASE WHEN ? THEN ? ELSE event_time_end END,
        valid_from = CASE WHEN ? THEN ? ELSE valid_from END,
        valid_to = CASE WHEN ? THEN ? ELSE valid_to END,
        time_precision = CASE WHEN ? THEN ? ELSE time_precision END,
        time_source = CASE WHEN ? THEN ? ELSE time_source END,
        preference_subject = CASE WHEN ? THEN ? ELSE preference_subject END,
        preference_predicate = CASE WHEN ? THEN ? ELSE preference_predicate END,
        preference_object = CASE WHEN ? THEN ? ELSE preference_object END,
        preference_category = CASE WHEN ? THEN ? ELSE preference_category END,
        preference_polarity = CASE WHEN ? THEN ? ELSE preference_polarity END,
        updated_at = ?
      WHERE object_id = ? AND workspace_id = ?
    `
};

const MEMORY_ENTRY_SEARCH_SQL: SqlDefinitionMap<MemoryEntrySearchStatements> = {
  searchByKeywordStatement: `
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
    `,
  searchByKeywordPorterStatement: `
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
    `
};

const MEMORY_ENTRY_LIFECYCLE_SQL: SqlDefinitionMap<MemoryEntryLifecycleStatements> = {
  findLowActivityActiveMemoriesStatement: `
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
    `,
  findTombstonedMemoriesStatement: `
      SELECT${MEMORY_ENTRY_SELECT_COLUMNS}
      FROM memory_entries
      WHERE
        workspace_id = ?
        AND retention_state = 'tombstoned'
        AND updated_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')
      ORDER BY updated_at ASC, object_id ASC
    `,
  transitionLifecycleStatement: `
      UPDATE memory_entries
      SET lifecycle_state = ?, updated_at = ?
      WHERE object_id = ?
    `,
  transitionLifecycleClearForgetStatement: `
      UPDATE memory_entries
      SET lifecycle_state = ?,
          updated_at = ?,
          forget_disposition = NULL,
          forget_disposition_ref = NULL
      WHERE object_id = ?
    `,
  reviveDormantStatement: `
      UPDATE memory_entries
      SET lifecycle_state = 'active',
          updated_at = ?,
          forget_disposition = NULL,
          forget_disposition_ref = NULL
      WHERE object_id = ?
        AND lifecycle_state = 'dormant'
    `,
  demoteActiveToDormantStatement: `
      UPDATE memory_entries
      SET lifecycle_state = 'dormant',
          updated_at = ?,
          forget_disposition = NULL,
          forget_disposition_ref = NULL
      WHERE object_id = ?
        AND lifecycle_state = 'active'
    `,
  archiveStatement: `
      UPDATE memory_entries
      SET lifecycle_state = 'archived', updated_at = ?
      WHERE object_id = ?
    `,
  hardDeleteTombstonedStatement: `
      DELETE FROM memory_entries
      WHERE object_id = ?
        AND retention_state = 'tombstoned'
        AND updated_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')
    `,
  findDormantMemoriesStatement: `
      SELECT${MEMORY_ENTRY_SELECT_COLUMNS}
      FROM memory_entries
      WHERE workspace_id = ?
        AND lifecycle_state = 'dormant'
        AND COALESCE(retention_state, '') != 'tombstoned'
      ORDER BY COALESCE(last_hit_at, last_used_at, updated_at, created_at) ASC, object_id ASC
    `,
  autonomousTombstoneStatement: `
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
    `
};

const MEMORY_ENTRY_GC_SQL: SqlDefinitionMap<MemoryEntryGarbageCollectionStatements> = {
  findTombstonedWithDispositionStatement: `
      SELECT${MEMORY_ENTRY_SELECT_COLUMNS}
      FROM memory_entries
      WHERE workspace_id = ?
        AND retention_state = 'tombstoned'
        AND forget_disposition IS NOT NULL
        AND updated_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')
      ORDER BY updated_at ASC, object_id ASC
    `,
  hardDeleteTombstonedWithDispositionStatement: `
      DELETE FROM memory_entries
      WHERE object_id = ?
        AND retention_state = 'tombstoned'
        AND forget_disposition IS NOT NULL
        AND updated_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')
    `,
  hardDeleteTombstonedCompressedGuardedStatement: `
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
    `,
  hardDeleteTombstonedJudgedUselessGuardedStatement: `
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
    `,
  deleteOrphanedPathRelationsStatement: `
      DELETE FROM path_relations
      WHERE ${PATH_RELATION_SOURCE_BACKING_OBJECT_ID_SQL} = ?
         OR ${PATH_RELATION_TARGET_BACKING_OBJECT_ID_SQL} = ?
    `,
  deleteOrphanedCoUsageCountersStatement: `
      DELETE FROM path_relation_co_usage_counters
      WHERE low_memory_id = ? OR high_memory_id = ?
    `
};

export function prepareMemoryEntryCreateStatements(
  db: StorageDatabase
): MemoryEntryCreateStatements {
  return prepareStatementGroup(db, MEMORY_ENTRY_CREATE_SQL);
}

export function prepareMemoryEntryReadStatements(db: StorageDatabase): MemoryEntryReadStatements {
  return prepareStatementGroup(db, MEMORY_ENTRY_READ_SQL);
}

export function prepareMemoryEntryUpdateStatements(
  db: StorageDatabase
): MemoryEntryUpdateStatements {
  return prepareStatementGroup(db, MEMORY_ENTRY_UPDATE_SQL);
}

export function prepareMemoryEntrySearchStatements(
  db: StorageDatabase
): MemoryEntrySearchStatements {
  return prepareStatementGroup(db, MEMORY_ENTRY_SEARCH_SQL);
}

export function prepareMemoryEntryLifecycleStatements(
  db: StorageDatabase
): MemoryEntryLifecycleStatements {
  return prepareStatementGroup(db, MEMORY_ENTRY_LIFECYCLE_SQL);
}

export function prepareMemoryEntryGarbageCollectionStatements(
  db: StorageDatabase
): MemoryEntryGarbageCollectionStatements {
  return prepareStatementGroup(db, MEMORY_ENTRY_GC_SQL);
}

function prepareStatementGroup<T extends object>(
  db: StorageDatabase,
  sqlByName: SqlDefinitionMap<T>
): T {
  const statements = {} as StatementMap<T>;
  for (const key of Object.keys(sqlByName) as Array<keyof T>) {
    statements[key] = db.connection.prepare(sqlByName[key]);
  }
  return statements as T;
}
