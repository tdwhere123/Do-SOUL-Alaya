import { type OrphanedMemoryRecord } from "@do-soul/alaya-protocol";
import { type StorageDatabase } from "@do-soul/alaya-storage";

const ORPHAN_CONFIDENCE_WITHOUT_ACTIVE_BINDING = 0.8;
const MISSING_MEMORY_SURFACE_GAP = "memory.surface_id:null";

interface OrphanMemoryRow {
  readonly object_id: string;
  readonly workspace_id: string;
  readonly surface_id: string | null;
}

export async function findOrphanedMemoriesForWorkspace(
  connection: StorageDatabase["connection"],
  workspaceId: string
): Promise<readonly OrphanedMemoryRecord[]> {
  const rows = connection
    .prepare(
      `SELECT
         m.object_id,
         m.workspace_id,
         m.surface_id
       FROM memory_entries AS m
       WHERE m.workspace_id = ?
         AND m.lifecycle_state = 'active'
         AND NOT EXISTS (
           SELECT 1
           FROM surface_bindings AS sb
           WHERE sb.object_id = m.object_id
             AND sb.workspace_id = m.workspace_id
             AND sb.binding_state = 'active'
         )
       ORDER BY m.created_at ASC, m.object_id ASC`
    )
    .all(workspaceId) as OrphanMemoryRow[];

  return rows.map((row) => ({
    memory_id: row.object_id,
    workspace_id: row.workspace_id,
    suspected_surface_gaps: [row.surface_id ?? MISSING_MEMORY_SURFACE_GAP],
    orphan_confidence: ORPHAN_CONFIDENCE_WITHOUT_ACTIVE_BINDING
  }));
}
