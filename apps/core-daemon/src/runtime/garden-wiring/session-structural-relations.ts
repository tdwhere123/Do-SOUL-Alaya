import {
  SessionStructuralRelationService,
  type RelationAssertionService,
  type RoundStructuralNode,
  type SessionStructuralMaterializeResult,
  type StatementStructuralNode,
  type StructuralSourceEventRecord
} from "@do-soul/alaya-core";
import type { StorageDatabase } from "@do-soul/alaya-storage";

type RoundQueryRow = Readonly<{
  readonly workspace_id: string;
  readonly container_key: string;
  readonly round_index: number;
  readonly record_id: string;
  readonly host_reported_at: string | null;
  readonly event_time: string | null;
  readonly recorded_at: string;
  readonly event_id: string;
  readonly event_type: string;
  readonly entity_type: string;
  readonly entity_id: string;
  readonly run_id: string | null;
  readonly caused_by: string | null;
  readonly revision: number;
  readonly payload_json: string;
  readonly event_created_at: string;
}>;

type StatementQueryRow = Readonly<{
  readonly workspace_id: string;
  readonly artifact_id: string;
  readonly record_id: string;
  readonly memory_id: string | null;
  readonly memory_active: number;
  readonly content: string;
  readonly valid_from: string | null;
  readonly event_time: string | null;
  readonly recorded_at: string;
  readonly event_id: string;
  readonly event_type: string;
  readonly entity_type: string;
  readonly entity_id: string;
  readonly run_id: string | null;
  readonly caused_by: string | null;
  readonly revision: number;
  readonly payload_json: string;
  readonly event_created_at: string;
}>;

export type MaterializeWorkspaceStructuralRelationsInput = Readonly<{
  readonly database: StorageDatabase;
  readonly assertionService: Pick<
    RelationAssertionService,
    "admitDeferredProjection" | "refreshProjection"
  >;
  readonly workspaceId: string;
  readonly runId?: string | null;
  readonly causedBy?: string;
  readonly containerKey?: string;
  readonly includeStatements?: boolean;
  readonly admittedAt?: string;
  readonly warn?: (message: string, meta: Record<string, unknown>) => void;
}>;

/**
 * Single daemon-side owner for deterministic intra-session and statement
 * structural relation materialization across capture hooks, backfill, and evaluation.
 */
export async function materializeWorkspaceSessionStructuralRelations(
  input: MaterializeWorkspaceStructuralRelationsInput
): Promise<SessionStructuralMaterializeResult> {
  const rounds = loadRoundStructuralNodes(
    input.database.connection,
    input.workspaceId,
    input.containerKey
  );
  const statements = input.includeStatements === false
    ? []
    : loadStatementStructuralNodes(input.database.connection, input.workspaceId);
  const service = new SessionStructuralRelationService({
    assertionService: input.assertionService,
    ...(input.warn === undefined ? {} : { warn: input.warn })
  });
  return await service.materialize({
    workspaceId: input.workspaceId,
    runId: input.runId ?? null,
    causedBy: input.causedBy ?? "session_structural_materializer",
    rounds,
    statements,
    ...(input.admittedAt === undefined ? {} : { admittedAt: input.admittedAt })
  });
}

export function loadRoundStructuralNodes(
  connection: StorageDatabase["connection"],
  workspaceId: string,
  containerKey?: string
): readonly RoundStructuralNode[] {
  const rows = connection.prepare(`
    SELECT hsm.workspace_id,
           hsm.container_key,
           hsm.round_index,
           sr.record_id,
           MAX(hsm.host_reported_at) AS host_reported_at,
           sr.event_time,
           sr.recorded_at,
           el.event_id,
           el.event_type,
           el.entity_type,
           el.entity_id,
           el.run_id,
           el.caused_by,
           el.revision,
           el.payload_json,
           el.created_at AS event_created_at
    FROM host_session_messages hsm
    JOIN source_records sr
      ON sr.workspace_id = hsm.workspace_id
     AND sr.record_id = hsm.round_root_id
    JOIN event_log el
      ON el.workspace_id = sr.workspace_id
     AND el.event_type = 'soul.field.source_record.admitted'
     AND el.entity_type = 'source_record'
     AND el.entity_id = sr.record_id
    WHERE hsm.workspace_id = ?
      AND hsm.round_root_id IS NOT NULL
      AND hsm.round_index IS NOT NULL
      AND (? IS NULL OR hsm.container_key = ?)
      AND NOT EXISTS (
        SELECT 1 FROM projection_erase_barriers b
        WHERE b.workspace_id = sr.workspace_id
          AND b.subject_kind = 'source_record'
          AND b.subject_id = sr.record_id
      )
    GROUP BY hsm.workspace_id, hsm.container_key, hsm.round_index, sr.record_id
    ORDER BY hsm.container_key ASC, hsm.round_index ASC
  `).all(workspaceId, containerKey ?? null, containerKey ?? null) as RoundQueryRow[];
  return rows.map((row) => {
    const sourceOccurredAt = row.event_time ?? row.recorded_at;
    return {
      workspaceId: row.workspace_id,
      containerKey: row.container_key,
      roundIndex: row.round_index,
      recordId: row.record_id,
      observedAt: row.event_time ?? row.host_reported_at ?? row.recorded_at,
      sourceOccurredAt,
      sourceEvent: toSourceEvent(row)
    };
  });
}

export function loadStatementStructuralNodes(
  connection: StorageDatabase["connection"],
  workspaceId: string
): readonly StatementStructuralNode[] {
  const rows = connection.prepare(`
    SELECT ssa.workspace_id,
           ssa.artifact_id,
           sr.record_id,
           ssmb.memory_id,
           CASE
             WHEN ssmb.memory_id IS NULL THEN 1
             WHEN me.object_id IS NOT NULL
              AND me.lifecycle_state = 'active'
              AND NOT EXISTS (
                SELECT 1 FROM privacy_current_quarantine q
                WHERE q.workspace_id = me.workspace_id
                  AND q.object_kind = 'memory_entry'
                  AND q.object_id = me.object_id
              ) THEN 1
             ELSE 0
           END AS memory_active,
           COALESCE(me.content, ssa.key_text) AS content,
           me.valid_from,
           sr.event_time,
           sr.recorded_at,
           el.event_id,
           el.event_type,
           el.entity_type,
           el.entity_id,
           el.run_id,
           el.caused_by,
           el.revision,
           el.payload_json,
           el.created_at AS event_created_at
    FROM source_statement_artifacts ssa
    JOIN source_records sr
      ON sr.workspace_id = ssa.workspace_id
     AND sr.record_id = ssa.record_id
    JOIN event_log el
      ON el.workspace_id = sr.workspace_id
     AND el.event_type = 'soul.field.source_record.admitted'
     AND el.entity_type = 'source_record'
     AND el.entity_id = sr.record_id
    JOIN evidence_capsules ec
      ON ec.object_id = ssa.artifact_id
     AND ec.workspace_id = ssa.workspace_id
     AND ec.lifecycle_state = 'active'
    LEFT JOIN source_statement_memory_bindings ssmb
      ON ssmb.workspace_id = ssa.workspace_id
     AND ssmb.artifact_id = ssa.artifact_id
    LEFT JOIN memory_entries me
      ON me.workspace_id = ssmb.workspace_id
     AND me.object_id = ssmb.memory_id
    WHERE ssa.workspace_id = ?
      AND NOT EXISTS (
        SELECT 1 FROM projection_erase_barriers b
        WHERE b.workspace_id = sr.workspace_id
          AND b.subject_kind = 'source_record'
          AND b.subject_id = sr.record_id
      )
    ORDER BY ssa.artifact_id ASC
  `).all(workspaceId) as StatementQueryRow[];
  const nodes: StatementStructuralNode[] = [];
  for (const row of rows) {
    if (row.memory_active !== 1) continue;
    const sourceOccurredAt = row.event_time ?? row.recorded_at;
    nodes.push({
      workspaceId: row.workspace_id,
      artifactId: row.artifact_id,
      recordId: row.record_id,
      targetObjectId: row.memory_id ?? row.record_id,
      content: row.content,
      observedAt: row.valid_from ?? row.event_time ?? row.recorded_at,
      sourceOccurredAt,
      sourceEvent: toSourceEvent(row)
    });
  }
  return nodes;
}

function toSourceEvent(row: Pick<
  RoundQueryRow,
  | "event_id"
  | "event_type"
  | "entity_type"
  | "entity_id"
  | "workspace_id"
  | "run_id"
  | "caused_by"
  | "revision"
  | "payload_json"
  | "event_created_at"
>): StructuralSourceEventRecord {
  return {
    event_id: row.event_id,
    event_type: row.event_type,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    workspace_id: row.workspace_id,
    run_id: row.run_id,
    caused_by: row.caused_by,
    revision: row.revision,
    payload_json: JSON.parse(row.payload_json),
    created_at: row.event_created_at
  };
}
