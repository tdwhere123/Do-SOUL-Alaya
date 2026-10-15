import {
  SourceIndexConfigurationSchema, SourceIndexGenerationStatusSchema, type SourceIndexSelection, type SourceIndexGeneration
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../sqlite/db.js";
import { StorageError } from "../../shared/errors.js";
import { readIntegerField, readJsonColumn, readNonEmptyStringField, readNullableStringField,
  readRecord, readSqliteBooleanIntField } from "../shared/parse-row.js";

export function sourceIndexEpoch(database: StorageDatabase, workspaceId: string): number {
  const raw = database.connection.prepare("SELECT epoch FROM source_index_epochs WHERE workspace_id = ?").get(workspaceId);
  return raw === undefined ? 0 : readIntegerField(readRecord(raw, "source epoch"), "epoch");
}
export function selectionFromRow(value: unknown): SourceIndexSelection {
  const row = readRecord(value, "source index selection");
  return Object.freeze({ workspace_id: readNonEmptyStringField(row, "workspace_id"),
    selection_revision: readIntegerField(row, "selection_revision"), config_id: readNonEmptyStringField(row, "config_id"),
    profile_id: readNonEmptyStringField(row, "profile_id"),
    configuration: SourceIndexConfigurationSchema.parse(readJsonColumn(row, "configuration_json")) });
}
export function readSourceIndexSelection(database: StorageDatabase, workspaceId: string): SourceIndexSelection | null {
  const raw = database.connection.prepare("SELECT * FROM source_index_selections WHERE workspace_id = ?").get(workspaceId);
  return raw === undefined ? null : selectionFromRow(raw);
}

/** Counts are storage-maintained by verified coverage and transaction-local payload invalidation. */
export function readSourceIndexGeneration(database: StorageDatabase, workspaceId: string, generationId: string): SourceIndexGeneration | null {
  const raw = database.connection.prepare(`SELECT * FROM source_index_generations
    WHERE workspace_id = ? AND generation_id = ?`).get(workspaceId, generationId);
  if (raw === undefined) return null;
  const row = readRecord(raw, "source index generation");
  const status = SourceIndexGenerationStatusSchema.parse(readNonEmptyStringField(row, "status"));
  return Object.freeze({ selection: selectionFromRow(raw), generation_id: readNonEmptyStringField(row, "generation_id"),
    source_epoch: readIntegerField(row, "source_epoch"), status,
    enumeration_complete: readSqliteBooleanIntField(row, "enumeration_complete") === 1,
    after_source_id: readNullableStringField(row, "after_source_id"), target_count: readIntegerField(row, "target_count"),
    completed_count: readIntegerField(row, "completed_count"), reason: readNullableStringField(row, "reason") });
}
/** Reconcile captured manifests in SQLite, never hydrating the source population into JavaScript. */
export function verifySourceIndexTargetCoverage(database: StorageDatabase, workspaceId: string, generationId: string, rootKey?: string): void {
  database.connection.prepare(`UPDATE source_index_targets AS t SET complete = CASE WHEN
    t.expected_windows IS NOT NULL AND EXISTS (
      SELECT 1 FROM source_index_roots r JOIN source_index_text x
        ON x.workspace_id=r.workspace_id AND x.root_key=r.root_key
      WHERE r.workspace_id=t.workspace_id AND r.root_key=t.root_key
        AND x.content_digest=json_extract(r.target_json,'$.target.content_digest')
        AND x.body_bytes=json_extract(r.target_json,'$.body_bytes'))
    AND (SELECT COUNT(*) FROM source_index_windows w WHERE w.workspace_id=t.workspace_id
      AND w.generation_id=t.generation_id AND w.root_key=t.root_key)=t.expected_windows
    AND (SELECT COUNT(*) FROM source_index_windows w JOIN source_index_vectors v
      ON v.workspace_id=w.workspace_id AND v.generation_id=w.generation_id AND v.window_id=w.window_id AND v.root_key=w.root_key
      WHERE w.workspace_id=t.workspace_id AND w.generation_id=t.generation_id AND w.root_key=t.root_key)=t.expected_windows
    THEN 1 ELSE 0 END WHERE workspace_id=? AND generation_id=?${rootKey === undefined ? "" : " AND root_key=?"}`)
    .run(...(rootKey === undefined ? [workspaceId, generationId] : [workspaceId, generationId, rootKey]));
}

/** Native epoch and selected configuration are both CAS inputs, including after restart. */
export function sourceIndexBuildGuard(database: StorageDatabase, generation: SourceIndexGeneration): "superseded" | "stale" | null {
  const selection = readSourceIndexSelection(database, generation.selection.workspace_id);
  if (selection === null || selection.selection_revision !== generation.selection.selection_revision ||
      selection.config_id !== generation.selection.config_id || generation.status === "retired") return "superseded";
  if (sourceIndexEpoch(database, selection.workspace_id) !== generation.source_epoch) return "stale";
  return null;
}
export function requireSourceIndexGeneration(database: StorageDatabase, workspaceId: string, generationId: string): SourceIndexGeneration {
  const generation = readSourceIndexGeneration(database, workspaceId, generationId);
  if (generation === null) throw new StorageError("NOT_FOUND", "source index generation not found");
  return generation;
}
