import type { StorageDatabase } from "../../sqlite/db.js";
import { MEMORY_ENTRY_SELECT_COLUMNS } from "./row-mapper.js";
import {
  prepareStatementGroup,
  type SqlDefinitionMap,
  type SqliteStatement
} from "./statement-group-utils.js";
import {
  prepareRecallTierWindowStatements,
  type RecallTierWindowStatements
} from "./recall/recall-tier-window-statements.js";

export interface MemoryEntryCreateStatements {
  readonly createStatement: SqliteStatement;
}

export interface MemoryEntryEvidenceRefIndexStatements {
  readonly deleteEvidenceRefsByMemoryStatement: SqliteStatement;
  readonly insertEvidenceRefStatement: SqliteStatement;
}

interface MemoryEntryBaseReadStatements {
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
  readonly countByScopeClassHotStatement: SqliteStatement;
  readonly findByWorkspaceHotConflictPagedStatement: SqliteStatement;
  readonly countByWorkspaceHotConflictStatement: SqliteStatement;
  readonly findByDimensionHotConflictPagedStatement: SqliteStatement;
  readonly countByDimensionHotConflictStatement: SqliteStatement;
  readonly findByScopeClassHotConflictPagedStatement: SqliteStatement;
  readonly countByScopeClassHotConflictStatement: SqliteStatement;
  readonly findByScopeClassAndDimensionHotConflictPagedStatement: SqliteStatement;
  readonly countByScopeClassAndDimensionHotConflictStatement: SqliteStatement;
}

export interface MemoryEntryReadStatements
  extends MemoryEntryBaseReadStatements,
    RecallTierWindowStatements {}

export interface MemoryEntryUpdateStatements {
  readonly updateStatement: SqliteStatement;
  readonly updateScopedStatement: SqliteStatement;
}

export {
  prepareMemoryEntrySearchStatements,
  type MemoryEntrySearchStatements
} from "./search/search-statements.js";

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

const ACTIVE_MEMORY_FILTER_SQL = `
        AND COALESCE(retention_state, '') != 'tombstoned'
        AND COALESCE(lifecycle_state, '') != 'dormant'
`;

const CONFLICT_MEMORY_FILTER_SQL = `
        AND contradiction_count > 0
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
        facet_tags,
        canonical_entities,
        forget_disposition,
        forget_disposition_ref
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
};

const MEMORY_ENTRY_EVIDENCE_REF_INDEX_SQL: SqlDefinitionMap<MemoryEntryEvidenceRefIndexStatements> = {
  deleteEvidenceRefsByMemoryStatement: `
      DELETE FROM memory_entry_evidence_refs
      WHERE memory_id = ?
    `,
  insertEvidenceRefStatement: `
      INSERT OR IGNORE INTO memory_entry_evidence_refs(workspace_id, memory_id, evidence_ref)
      VALUES (?, ?, ?)
    `
};

const MEMORY_ENTRY_READ_SQL: SqlDefinitionMap<MemoryEntryBaseReadStatements> = {
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
    `,
  countByScopeClassHotStatement: `
      SELECT COUNT(*) AS total
      FROM memory_entries
      WHERE workspace_id = ? AND scope_class = ? AND storage_tier = 'hot'
${ACTIVE_MEMORY_FILTER_SQL}    `,
  findByWorkspaceHotConflictPagedStatement: `
      SELECT${MEMORY_ENTRY_SELECT_COLUMNS}
      FROM memory_entries
      WHERE workspace_id = ? AND storage_tier = 'hot'
${ACTIVE_MEMORY_FILTER_SQL}${CONFLICT_MEMORY_FILTER_SQL}      ORDER BY created_at ASC, object_id ASC
      LIMIT ? OFFSET ?
    `,
  countByWorkspaceHotConflictStatement: `
      SELECT COUNT(*) AS total
      FROM memory_entries
      WHERE workspace_id = ? AND storage_tier = 'hot'
${ACTIVE_MEMORY_FILTER_SQL}${CONFLICT_MEMORY_FILTER_SQL}    `,
  findByDimensionHotConflictPagedStatement: `
      SELECT${MEMORY_ENTRY_SELECT_COLUMNS}
      FROM memory_entries
      WHERE workspace_id = ? AND dimension = ? AND storage_tier = 'hot'
${ACTIVE_MEMORY_FILTER_SQL}${CONFLICT_MEMORY_FILTER_SQL}      ORDER BY created_at ASC, object_id ASC
      LIMIT ? OFFSET ?
    `,
  countByDimensionHotConflictStatement: `
      SELECT COUNT(*) AS total
      FROM memory_entries
      WHERE workspace_id = ? AND dimension = ? AND storage_tier = 'hot'
${ACTIVE_MEMORY_FILTER_SQL}${CONFLICT_MEMORY_FILTER_SQL}    `,
  findByScopeClassHotConflictPagedStatement: `
      SELECT${MEMORY_ENTRY_SELECT_COLUMNS}
      FROM memory_entries
      WHERE workspace_id = ? AND scope_class = ? AND storage_tier = 'hot'
${ACTIVE_MEMORY_FILTER_SQL}${CONFLICT_MEMORY_FILTER_SQL}      ORDER BY created_at ASC, object_id ASC
      LIMIT ? OFFSET ?
    `,
  countByScopeClassHotConflictStatement: `
      SELECT COUNT(*) AS total
      FROM memory_entries
      WHERE workspace_id = ? AND scope_class = ? AND storage_tier = 'hot'
${ACTIVE_MEMORY_FILTER_SQL}${CONFLICT_MEMORY_FILTER_SQL}    `,
  findByScopeClassAndDimensionHotConflictPagedStatement: `
      SELECT${MEMORY_ENTRY_SELECT_COLUMNS}
      FROM memory_entries
      WHERE workspace_id = ? AND scope_class = ? AND dimension = ? AND storage_tier = 'hot'
${ACTIVE_MEMORY_FILTER_SQL}${CONFLICT_MEMORY_FILTER_SQL}      ORDER BY created_at ASC, object_id ASC
      LIMIT ? OFFSET ?
    `,
  countByScopeClassAndDimensionHotConflictStatement: `
      SELECT COUNT(*) AS total
      FROM memory_entries
      WHERE workspace_id = ? AND scope_class = ? AND dimension = ? AND storage_tier = 'hot'
${ACTIVE_MEMORY_FILTER_SQL}${CONFLICT_MEMORY_FILTER_SQL}    `
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
        facet_tags = CASE WHEN ? THEN ? ELSE facet_tags END,
        canonical_entities = CASE WHEN ? THEN ? ELSE canonical_entities END,
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
        facet_tags = CASE WHEN ? THEN ? ELSE facet_tags END,
        canonical_entities = CASE WHEN ? THEN ? ELSE canonical_entities END,
        updated_at = ?
      WHERE object_id = ? AND workspace_id = ?
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

export function prepareMemoryEntryCreateStatements(
  db: StorageDatabase
): MemoryEntryCreateStatements {
  return prepareStatementGroup(db, MEMORY_ENTRY_CREATE_SQL);
}

export function prepareMemoryEntryEvidenceRefIndexStatements(
  db: StorageDatabase
): MemoryEntryEvidenceRefIndexStatements {
  return prepareStatementGroup(db, MEMORY_ENTRY_EVIDENCE_REF_INDEX_SQL);
}

export function prepareMemoryEntryReadStatements(db: StorageDatabase): MemoryEntryReadStatements {
  return {
    ...prepareStatementGroup(db, MEMORY_ENTRY_READ_SQL),
    ...prepareRecallTierWindowStatements(db)
  };
}

export function prepareMemoryEntryUpdateStatements(
  db: StorageDatabase
): MemoryEntryUpdateStatements {
  return prepareStatementGroup(db, MEMORY_ENTRY_UPDATE_SQL);
}

export function prepareMemoryEntryLifecycleStatements(
  db: StorageDatabase
): MemoryEntryLifecycleStatements {
  return prepareStatementGroup(db, MEMORY_ENTRY_LIFECYCLE_SQL);
}
