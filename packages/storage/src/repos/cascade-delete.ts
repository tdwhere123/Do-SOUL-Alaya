import type { SqliteConnection } from "../sqlite/db.js";
import { StorageError } from "../shared/errors.js";
import {
  PATH_RELATION_SOURCE_BACKING_OBJECT_ID_SQL,
  PATH_RELATION_TARGET_BACKING_OBJECT_ID_SQL
} from "./path-relation-repo.js";

/**
 * Deletes a run and all domain data scoped to it, wrapped in a single transaction.
 *
 * event_log is intentionally excluded — events are the permanent audit trail.
 * Their run_id references become historical after deletion, which is correct.
 *
 * Tables handled:
 *   memory_entries, evidence_capsules, synthesis_capsules, proposals,
 *   health_journal, files, handoff_records, gap_records — deleted by run_id.
 *   runs — deleted last; SQLite ON DELETE CASCADE on signals fires automatically.
 */
// invariant: path_relations endpoints (JSON anchors) and
// path_relation_co_usage_counters (plain-text memory ids) carry no FK to
// memory_entries, so SQLite cannot cascade them; this prunes every row whose
// endpoint memory id is in `deletedMemoryIdsSql` (a SELECT of object_id values).
// `bindParams` are re-bound once per IN-match position (source, target,
// co-usage low, co-usage high). Caller must run this inside its transaction.
// cross-file ref: packages/storage/src/repos/path-relation-repo.ts backing-object-id SQL
function pruneOrphanedPathTopology(
  connection: SqliteConnection,
  deletedMemoryIdsSql: string,
  bindParams: readonly unknown[]
): void {
  const deletePathRelations = connection.prepare(`
    DELETE FROM path_relations
    WHERE ${PATH_RELATION_SOURCE_BACKING_OBJECT_ID_SQL} IN (${deletedMemoryIdsSql})
       OR ${PATH_RELATION_TARGET_BACKING_OBJECT_ID_SQL} IN (${deletedMemoryIdsSql})
  `);
  const deleteCoUsageCounters = connection.prepare(`
    DELETE FROM path_relation_co_usage_counters
    WHERE low_memory_id IN (${deletedMemoryIdsSql})
       OR high_memory_id IN (${deletedMemoryIdsSql})
  `);

  deletePathRelations.run(...bindParams, ...bindParams);
  deleteCoUsageCounters.run(...bindParams, ...bindParams);
}

export function cascadeDeleteRun(connection: SqliteConnection, runId: string): void {
  const deleteMemoryEntries = connection.prepare("DELETE FROM memory_entries WHERE run_id = ?");
  const deleteEvidenceCapsules = connection.prepare("DELETE FROM evidence_capsules WHERE run_id = ?");
  const deleteSynthesisCapsules = connection.prepare("DELETE FROM synthesis_capsules WHERE run_id = ?");
  const deleteProposals = connection.prepare("DELETE FROM proposals WHERE run_id = ?");
  const deleteHealthJournal = connection.prepare("DELETE FROM health_journal WHERE run_id = ?");
  const deleteFiles = connection.prepare("DELETE FROM files WHERE run_id = ?");
  const deleteHandoffRecords = connection.prepare("DELETE FROM handoff_records WHERE source_run_id = ?");
  const deleteGapRecords = connection.prepare("DELETE FROM gap_records WHERE detected_in_run_id = ?");
  const deleteRun = connection.prepare("DELETE FROM runs WHERE run_id = ?");

  try {
    connection.transaction(() => {
      // invariant: prune before deleteMemoryEntries — the subquery resolves
      // deleted ids from memory_entries, which must still hold the run's rows.
      pruneOrphanedPathTopology(
        connection,
        "SELECT object_id FROM memory_entries WHERE run_id = ?",
        [runId]
      );
      deleteMemoryEntries.run(runId);
      deleteEvidenceCapsules.run(runId);
      deleteSynthesisCapsules.run(runId);
      deleteProposals.run(runId);
      deleteHealthJournal.run(runId);
      deleteFiles.run(runId);
      deleteHandoffRecords.run(runId);
      deleteGapRecords.run(runId);
      // Delete the run row last — signals cascade via FK ON DELETE CASCADE.
      deleteRun.run(runId);
    })();
  } catch (error) {
    throw new StorageError("QUERY_FAILED", `Failed to cascade delete run ${runId}.`, error);
  }
}

/**
 * Deletes a workspace and all domain data scoped to it, wrapped in a single transaction.
 *
 * event_log is intentionally excluded — events are the permanent audit trail.
 *
 * Order:
 *   1. Tables without (or regardless of) FK constraints deleted by workspace_id.
 *   2. runs deleted by workspace_id (triggers signals cascade).
 *   3. workspaces deleted last (triggers FK CASCADE on engine_bindings, slots,
 *      conflict_matrix_edges, surface_*, cross_cutting_permissions,
 *      orphan_radar, project_mapping_anchors,
 *      path_relations, path_graph_snapshots, bootstrapping_records,
 *      drift_leases).
 *
 * extension_descriptors is intentionally excluded — it holds process-wide
 * registry entries (e.g. MCP providers, builtin tools) that outlive a single
 * workspace and are keyed by descriptor_id rather than workspace_id.
 */
export function cascadeDeleteWorkspace(connection: SqliteConnection, workspaceId: string): void {
  const deleteMemoryEntries = connection.prepare("DELETE FROM memory_entries WHERE workspace_id = ?");
  const deleteEvidenceCapsules = connection.prepare("DELETE FROM evidence_capsules WHERE workspace_id = ?");
  const deleteSynthesisCapsules = connection.prepare("DELETE FROM synthesis_capsules WHERE workspace_id = ?");
  const deleteClaimForms = connection.prepare("DELETE FROM claim_forms WHERE workspace_id = ?");
  const deleteProposals = connection.prepare("DELETE FROM proposals WHERE workspace_id = ?");
  const deleteKarmaEvents = connection.prepare("DELETE FROM karma_events WHERE workspace_id = ?");
  const deleteGreenStatuses = connection.prepare("DELETE FROM green_statuses WHERE workspace_id = ?");
  const deleteHealthJournal = connection.prepare("DELETE FROM health_journal WHERE workspace_id = ?");
  const deleteFiles = connection.prepare("DELETE FROM files WHERE workspace_id = ?");
  // runs has a non-cascade FK → workspaces; must delete runs before workspace row.
  const deleteRuns = connection.prepare("DELETE FROM runs WHERE workspace_id = ?");
  const deleteWorkspace = connection.prepare("DELETE FROM workspaces WHERE workspace_id = ?");

  try {
    connection.transaction(() => {
      deleteMemoryEntries.run(workspaceId);
      deleteEvidenceCapsules.run(workspaceId);
      deleteSynthesisCapsules.run(workspaceId);
      deleteClaimForms.run(workspaceId);
      deleteProposals.run(workspaceId);
      deleteKarmaEvents.run(workspaceId);
      deleteGreenStatuses.run(workspaceId);
      deleteHealthJournal.run(workspaceId);
      deleteFiles.run(workspaceId);
      // Delete runs before workspace row — signals cascade via FK ON DELETE CASCADE.
      deleteRuns.run(workspaceId);
      // Delete workspace last — FK CASCADE handles engine_bindings, slots,
      // conflict_matrix_edges, surface_*, cross_cutting_permissions,
      // orphan_radar, project_mapping_anchors,
      // path_relations, path_graph_snapshots, bootstrapping_records,
      // drift_leases.
      deleteWorkspace.run(workspaceId);
    })();
  } catch (error) {
    throw new StorageError("QUERY_FAILED", `Failed to cascade delete workspace ${workspaceId}.`, error);
  }
}
