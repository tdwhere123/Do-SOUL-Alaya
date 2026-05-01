import {
  EventLogOrphanRecordSchema,
  TrustStateEventType,
  type EventLogOrphanExpectedTable,
  type EventLogOrphanRecord,
  type OrphanedMemoryRecord
} from "@do-soul/alaya-protocol";
import { type StorageDatabase } from "@do-soul/alaya-storage";

const ORPHAN_CONFIDENCE_WITHOUT_ACTIVE_BINDING = 0.8;
const MISSING_MEMORY_SURFACE_GAP = "memory.surface_id:null";

interface OrphanMemoryRow {
  readonly object_id: string;
  readonly workspace_id: string;
  readonly surface_id: string | null;
}

interface EventLogOrphanRow {
  readonly event_id: string;
  readonly event_type: string;
  readonly expected_table: EventLogOrphanExpectedTable;
  readonly created_at: string;
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

export async function findEventLogOrphansForWorkspace(
  connection: StorageDatabase["connection"],
  workspaceId: string
): Promise<readonly EventLogOrphanRecord[]> {
  const rows = connection
    .prepare(
      `SELECT
         el.event_id,
         el.event_type,
         CASE el.event_type
           WHEN ? THEN 'trust_context_delivery'
           WHEN ? THEN 'trust_usage_proof'
         END AS expected_table,
         el.created_at
       FROM event_log el
       WHERE el.workspace_id = ?
         AND el.event_type IN (?, ?)
         AND NOT EXISTS (
           SELECT 1 FROM trust_context_delivery tcd WHERE tcd.audit_event_id = el.event_id
         )
         AND NOT EXISTS (
           SELECT 1 FROM trust_usage_proof tup WHERE tup.audit_event_id = el.event_id
         )
         AND NOT EXISTS (
           SELECT 1 FROM orphan_radar radar WHERE radar.target_event_id = el.event_id
         )
         AND datetime(el.created_at) < datetime('now', '-1 minute')
       ORDER BY el.created_at ASC, el.event_id ASC`
    )
    .all(
      TrustStateEventType.MEMORY_DELIVERED,
      TrustStateEventType.MEMORY_USAGE_REPORTED,
      workspaceId,
      TrustStateEventType.MEMORY_DELIVERED,
      TrustStateEventType.MEMORY_USAGE_REPORTED
    ) as EventLogOrphanRow[];

  return rows.map((row) =>
    EventLogOrphanRecordSchema.parse({
      audit_event_id: row.event_id,
      event_type: row.event_type,
      expected_table: row.expected_table,
      detected_at: row.created_at
    })
  );
}
