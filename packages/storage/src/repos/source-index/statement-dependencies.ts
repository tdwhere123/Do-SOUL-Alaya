import type { SourceStatementArtifact, SourceIndexBudget } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../sqlite/db.js";
import { cachedReadStatement } from "../../sqlite/dynamic-prepared-statement-cache.js";
import { StorageError } from "../../shared/errors.js";
import { CURRENT_SOURCE_RECORD_ORDER } from "../field/source-representation-read.js";

/** Reuse the raw-source owner's head ordering; replacement is not world-claim falsity. */
function unavailableDependencySql(dependency: string): string {
  return `NOT EXISTS (SELECT 1 FROM source_records retained
    WHERE retained.workspace_id=${dependency}.workspace_id AND retained.record_id=${dependency}.record_id
      AND retained.source_body IS NOT NULL AND retained.record_id=(
        SELECT source_records.record_id FROM source_records
        WHERE source_records.workspace_id=${dependency}.workspace_id AND source_records.source_id=${dependency}.source_id
        ORDER BY ${CURRENT_SOURCE_RECORD_ORDER} LIMIT 1))
    OR EXISTS (SELECT 1 FROM projection_erase_barriers barrier WHERE barrier.workspace_id=${dependency}.workspace_id
      AND barrier.subject_kind='source_record' AND barrier.subject_id=${dependency}.record_id)`;
}

/** A shared eligibility projection for native keys and only explicitly bound derived memory. */
const UNAVAILABLE_STATEMENT_DEPENDENCY_SQL = unavailableDependencySql("dependency");
const UNAVAILABLE_BOUND_STATEMENT_SQL = `NOT EXISTS (SELECT 1 FROM evidence_capsules evidence
    WHERE evidence.workspace_id=binding.workspace_id AND evidence.object_id=binding.artifact_id AND evidence.lifecycle_state='active')
  OR NOT EXISTS (SELECT 1 FROM source_statement_dependencies dependency
    WHERE dependency.workspace_id=binding.workspace_id AND dependency.artifact_id=binding.artifact_id)
  OR EXISTS (SELECT 1 FROM source_statement_dependencies dependency
    WHERE dependency.workspace_id=binding.workspace_id AND dependency.artifact_id=binding.artifact_id
      AND (${UNAVAILABLE_STATEMENT_DEPENDENCY_SQL}))`;
export const CURRENT_STATEMENT_MEMORY_FILTER_SQL = `AND NOT EXISTS (
  SELECT 1 FROM source_statement_memory_bindings binding
  WHERE binding.workspace_id=memory_entries.workspace_id AND binding.memory_id=memory_entries.object_id
    AND (${UNAVAILABLE_BOUND_STATEMENT_SQL}))`;

export function putStatementDependencies(database: StorageDatabase, artifact: SourceStatementArtifact, sourceId: string): void {
  const bound = artifact.bound, workspace = bound.source_target.workspace_id;
  const roots = [{ workspace_id: workspace, root_id: bound.source_root_id, source_id: sourceId }, ...bound.source_context];
  const insert = database.connection.prepare(`INSERT INTO source_statement_dependencies(workspace_id,artifact_id,record_id,source_id)
    VALUES(?,?,?,?) ON CONFLICT(workspace_id,artifact_id,record_id) DO NOTHING`);
  for (const root of roots) {
    if (root.workspace_id !== workspace) throw new StorageError("VALIDATION_FAILED", "statement dependency crosses workspace");
    insert.run(workspace, artifact.artifact_id, root.root_id, root.source_id);
  }
}

export function putSourceStatementMemoryBinding(database: StorageDatabase, workspaceId: string, memoryId: string, artifactId: string): void {
  if (!database.connection.inTransaction) throw new StorageError("CONFLICT", "statement memory binding requires its owning transaction");
  const memory = database.connection.prepare(`SELECT 1 FROM memory_entries WHERE workspace_id=? AND object_id=?
    AND dimension='observation' AND source_kind='compiler' AND formation_kind='extracted'
    AND EXISTS (SELECT 1 FROM json_each(evidence_refs) WHERE value=?)`).get(workspaceId, memoryId, artifactId);
  if (memory === undefined || database.connection.prepare(`SELECT 1 FROM source_statement_dependencies
    WHERE workspace_id=? AND artifact_id=? LIMIT 1`).get(workspaceId, artifactId) === undefined) {
    throw new StorageError("VALIDATION_FAILED", "statement memory has no published dependency");
  }
  database.connection.prepare(`INSERT INTO source_statement_memory_bindings(workspace_id,memory_id,artifact_id)
    VALUES(?,?,?) ON CONFLICT(workspace_id,memory_id) DO NOTHING`).run(workspaceId, memoryId, artifactId);
  const stored = database.connection.prepare(`SELECT artifact_id FROM source_statement_memory_bindings
    WHERE workspace_id=? AND memory_id=?`).get(workspaceId, memoryId) as { artifact_id: string };
  if (stored.artifact_id !== artifactId) throw new StorageError("CONFLICT", "statement memory binding is immutable");
}

export function requireCurrentStatementMemory(database: StorageDatabase, workspace: string, memoryId: string): void {
  if (cachedReadStatement(database, `SELECT 1 FROM source_statement_memory_bindings binding
    WHERE binding.workspace_id=? AND binding.memory_id=? AND (${UNAVAILABLE_BOUND_STATEMENT_SQL}) LIMIT 1`)
    .get(workspace, memoryId) !== undefined) {
    throw new StorageError("CONFLICT", "Source-dependent statement memory is unavailable because its captured source is no longer current.");
  }
}

/** No body reads or unbounded result materialization. Every dependency visit is charged. */
export function readStatementDependencies(database: StorageDatabase, workspace: string, artifactId: string, budget: SourceIndexBudget) {
  const resources = { work: 0, native_bytes: 0 };
  if (budget.work < 1 || budget.native_bytes < 16) return { status: "partial" as const, resources };
  const { n } = database.connection.prepare(`SELECT COUNT(*) AS n FROM source_statement_dependencies WHERE workspace_id=? AND artifact_id=?`)
    .get(workspace, artifactId) as { n: number };
  resources.work = 1; resources.native_bytes = 8;
  const dependencyWork = 4 * n;
  if (n === 0 || dependencyWork + 1 > budget.work) return { status: "partial" as const, resources };
  const stale = database.connection.prepare(`SELECT 1 FROM source_statement_dependencies dependency
    WHERE workspace_id=? AND artifact_id=? AND (${UNAVAILABLE_STATEMENT_DEPENDENCY_SQL}) LIMIT 1`).get(workspace, artifactId) !== undefined;
  resources.work += dependencyWork; resources.native_bytes += 8;
  return { status: stale ? "stale" as const : "ready" as const, resources };
}
