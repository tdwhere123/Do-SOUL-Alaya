import type { StorageDatabase } from "../../../sqlite/db.js";
import { memoryPathTopologyDeletionSql } from "../../path/statements/path-relation-sql.js";
import { MEMORY_ENTRY_SELECT_COLUMNS } from "../mappers/row-mapper.js";
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
        AND NOT EXISTS (SELECT 1 FROM memory_gc_deferrals deferred
          WHERE deferred.workspace_id=memory_entries.workspace_id AND deferred.memory_id=memory_entries.object_id)
        -- Irreversible capture invalidation/erase already owns refusal of this proof.
        -- Keep the row recoverable without re-auditing that transition on every sweep.
        AND NOT EXISTS (SELECT 1 FROM historical_memory_captures proof
          WHERE proof.workspace_id=memory_entries.workspace_id AND proof.memory_id=memory_entries.object_id
            AND proof.capsule_id=memory_entries.forget_disposition_ref AND proof.state<>'active')
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
        AND EXISTS (SELECT 1 FROM historical_preservation_available proof
          WHERE proof.workspace_id=memory_entries.workspace_id AND proof.memory_id=memory_entries.object_id
            AND proof.capsule_id=memory_entries.forget_disposition_ref AND proof.audit_event_id IS NOT NULL)
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
  deleteOrphanedPathRelationsStatement: memoryPathTopologyDeletionSql("SELECT ?").relations,
  deleteOrphanedCoUsageCountersStatement: memoryPathTopologyDeletionSql("SELECT ?").counters
};

export function prepareMemoryEntryGarbageCollectionStatements(
  db: StorageDatabase
): MemoryEntryGarbageCollectionStatements {
  return prepareStatementGroup(db, MEMORY_ENTRY_GC_SQL);
}
