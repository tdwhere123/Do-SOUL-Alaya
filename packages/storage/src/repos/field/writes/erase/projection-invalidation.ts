import type { StorageDatabase } from "../../../../sqlite/db.js";
import { markProjectionRefreshRequired } from "../../../path/writes/relation-assertion/projection-writer.js";
import type { FieldEraseBarrierRow } from "../../ports.js";

export function discoverEraseGenerationSubjects(database: StorageDatabase, workspaceId: string):
  readonly Readonly<{ subject_kind: "generation"; subject_id: string }>[] {
  return database.connection.prepare(`
    SELECT 'generation' AS subject_kind, generation_id AS subject_id
    FROM projection_generations
    WHERE workspace_id = ?
    ORDER BY generation_id
  `).all(workspaceId) as Readonly<{ subject_kind: "generation"; subject_id: string }>[];
}

export function retainErasedEvidenceBarriers(database: StorageDatabase,
  barrier: FieldEraseBarrierRow, evidenceIds: readonly string[]): void {
  database.connection.prepare(`
    INSERT INTO source_erase_evidence_barriers (workspace_id, evidence_id, barrier_id)
    SELECT capsule.workspace_id, capsule.object_id, ?
    FROM json_each(?) AS affected JOIN evidence_capsules AS capsule ON capsule.object_id = affected.value
    WHERE capsule.workspace_id = ?
    ON CONFLICT DO NOTHING
  `).run(barrier.barrier_id, JSON.stringify(evidenceIds), barrier.workspace_id);
}

export function invalidateErasedProjections(database: StorageDatabase,
  barrier: FieldEraseBarrierRow, generationIds: readonly string[]): void {
  const connection = database.connection;
  const workspaceId = barrier.workspace_id;
  const deletePointer = connection.prepare(`
    DELETE FROM projection_generation_pointer
    WHERE workspace_id = ? AND active_generation_id = ?
  `);
  const retire = connection.prepare(`
    UPDATE projection_generations SET status = 'retired'
    WHERE workspace_id = ? AND generation_id = ? AND status = 'active'
  `);
  const deletePins = connection.prepare(
    "DELETE FROM projection_pins WHERE workspace_id = ? AND generation_id = ?"
  );
  const deleteArtifacts = connection.prepare(`
    DELETE FROM projection_generation_artifacts
    WHERE workspace_id = ? AND generation_id = ?
  `);
  for (const generationId of generationIds) {
    deletePointer.run(workspaceId, generationId);
    retire.run(workspaceId, generationId);
    deletePins.run(workspaceId, generationId);
    deleteArtifacts.run(workspaceId, generationId);
  }
  if (barrier.subject_kind === "source_record") {
    markProjectionRefreshRequired(database);
  }
}
