import type { StorageDatabase } from "../../sqlite/db.js";
import {
  PATH_RELATION_SOURCE_BACKING_OBJECT_ID_SQL,
  PATH_RELATION_TARGET_BACKING_OBJECT_ID_SQL
} from "../path/path-relation-repo.js";
import { MEMORY_ENTRY_SELECT_COLUMNS } from "./row-mapper.js";
import {
  prepareStatementGroup,
  type SqlDefinitionMap,
  type SqliteStatement
} from "./statement-group-utils.js";

export interface MemoryEntryGarbageCollectionStatements {
  readonly findTombstonedWithDispositionStatement: SqliteStatement;
  readonly hardDeleteTombstonedWithDispositionStatement: SqliteStatement;
  readonly hardDeleteTombstonedCompressedGuardedStatement: SqliteStatement;
  readonly hardDeleteTombstonedJudgedUselessGuardedStatement: SqliteStatement;
  readonly deleteOrphanedPathRelationsStatement: SqliteStatement;
  readonly deleteOrphanedCoUsageCountersStatement: SqliteStatement;
}

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

export function prepareMemoryEntryGarbageCollectionStatements(
  db: StorageDatabase
): MemoryEntryGarbageCollectionStatements {
  return prepareStatementGroup(db, MEMORY_ENTRY_GC_SQL);
}
