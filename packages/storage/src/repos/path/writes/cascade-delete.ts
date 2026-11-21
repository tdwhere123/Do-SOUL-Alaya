import type { SqliteConnection } from "../../../sqlite/db.js";
import { StorageError } from "../../../shared/errors.js";
import { deleteGardenSemanticWorkspaceRows } from "../../garden/semantic-artifact-schema.js";
import { dropWorkspaceLexicalDomains } from "../../source-index/lexical-domain.js";
import { memoryPathTopologyDeletionSql } from "../statements/path-relation-sql.js";

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
// memory_entries, so SQLite cannot cascade them. The shared deletion policy
// preserves foreign topology and frozen legacy projections.
// `bindParams` are re-bound once per IN-match position (source, target,
// co-usage low, co-usage high). Caller must run this inside its transaction.
// cross-file ref: packages/storage/src/repos/path/path-relation-repo.ts backing-object-id SQL
function pruneOrphanedPathTopology(
  connection: SqliteConnection,
  workspaceId: string,
  deletedMemoryIdsSql: string,
  bindParams: readonly unknown[]
): void {
  const statements = memoryPathTopologyDeletionSql(deletedMemoryIdsSql);
  connection.prepare(statements.relations).run(workspaceId, ...bindParams, ...bindParams);
  connection.prepare(statements.counters).run(workspaceId, ...bindParams, ...bindParams);
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
      const run = connection.prepare("SELECT workspace_id FROM runs WHERE run_id = ?").get(runId) as
        { readonly workspace_id: string } | undefined;
      if (run === undefined) return;
      // invariant: prune before deleteMemoryEntries — the subquery resolves
      // deleted ids from memory_entries, which must still hold the run's rows.
      pruneOrphanedPathTopology(
        connection,
        run.workspace_id,
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

// Delete source owners before clearing SourceIndex: their delete triggers
// advance the epoch. The text and projection triggers also clean their FTS rows.
const WORKSPACE_OWNED_ROWS = [
  "memory_entries",
  "evidence_capsules",
  "synthesis_capsules",
  "claim_forms",
  "proposals",
  "karma_events",
  "green_statuses",
  "health_journal",
  "health_issue_groups",
  "files",
  "trust_context_delivery",
  "garden_embedding_backfill_runs",
  "garden_tasks",
  "host_session_sweeps",
  "host_session_planning",
  "host_session_tail_boundaries",
  "host_session_rounds",
  "host_session_messages",
  "host_session_containers",
  "privacy_dependency_quarantine",
  "preservation_capsule_revisions",
  "recall_routing_key_owners",
  "relation_assertion_quarantine",
  "source_statement_relation_pending",
  "source_statement_relation_vectors",
  "retained_source_chunks",
  "source_records",
  "source_record_active_evidence_refs",
  "source_index_lexical_progress",
  "source_index_lexical_projections",
  "source_index_lexical_targets",
  "source_index_lexical_selections",
  "source_index_lexical_generations",
  "source_index_vectors",
  "source_index_windows",
  "source_index_text",
  "source_index_targets",
  "source_index_dependencies",
  "source_index_roots",
  "source_index_selections",
  "source_index_generations",
  "source_index_invalidations",
  "source_index_epochs",
  "runs",
  "workspaces"
] as const;

/** Delete workspace data in one transaction and retain its immutable EventLog. */
export function cascadeDeleteWorkspace(connection: SqliteConnection, workspaceId: string): void {
  try {
    connection.transaction(() => {
      deleteGardenSemanticWorkspaceRows(connection, "task_dependencies", workspaceId);
      dropWorkspaceLexicalDomains(connection, workspaceId);
      connection.prepare(`
        DELETE FROM garden_embedding_backfill_objects
        WHERE task_id IN (SELECT task_id FROM garden_embedding_backfill_runs WHERE workspace_id = ?)
      `).run(workspaceId);
      connection.prepare("DELETE FROM reconciliation_leases WHERE lease_key = ?").run(workspaceId);
      for (const table of WORKSPACE_OWNED_ROWS) {
        connection.prepare(`DELETE FROM ${table} WHERE workspace_id = ?`).run(workspaceId);
      }
      // Observable-mutation triggers update Garden's cursor while rows are deleted.
      deleteGardenSemanticWorkspaceRows(connection, "projections", workspaceId);
    }).immediate();
  } catch (error) {
    throw new StorageError("QUERY_FAILED", `Failed to cascade delete workspace ${workspaceId}.`, error);
  }
}
