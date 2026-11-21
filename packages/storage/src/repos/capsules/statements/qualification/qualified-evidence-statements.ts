import type BetterSqlite3 from "better-sqlite3";
import type { StorageDatabase } from "../../../../sqlite/db.js";

export interface QualifiedEvidenceStatements {
  readonly findEvidenceRows: BetterSqlite3.Statement;
  readonly findSignalRows: BetterSqlite3.Statement;
  readonly findMaterializationRows: BetterSqlite3.Statement;
  readonly findProjectionRows: BetterSqlite3.Statement;
}

export function prepareQualifiedEvidenceStatements(
  db: StorageDatabase
): QualifiedEvidenceStatements {
  return {
    findEvidenceRows: db.connection.prepare(FIND_EVIDENCE_ROWS_SQL),
    findSignalRows: db.connection.prepare(FIND_SIGNAL_ROWS_SQL),
    findMaterializationRows: db.connection.prepare(FIND_MATERIALIZATION_ROWS_SQL),
    findProjectionRows: db.connection.prepare(FIND_PROJECTION_ROWS_SQL)
  };
}

const FIND_EVIDENCE_ROWS_SQL = `
  SELECT evidence_capsules.object_id AS object_id,
         evidence_capsules.object_kind AS object_kind,
         evidence_capsules.schema_version AS schema_version,
         evidence_capsules.lifecycle_state AS lifecycle_state,
         evidence_capsules.created_at AS created_at,
         evidence_capsules.updated_at AS updated_at,
         evidence_capsules.created_by AS created_by,
         evidence_capsules.evidence_kind AS evidence_kind,
         evidence_capsules.semantic_anchor AS semantic_anchor,
         evidence_capsules.event_anchor AS event_anchor,
         evidence_capsules.physical_anchor AS physical_anchor,
         evidence_capsules.evidence_health_state AS evidence_health_state,
         evidence_capsules.gist AS gist,
         evidence_capsules.excerpt AS excerpt,
         evidence_capsules.source_hash AS source_hash,
         evidence_capsules.run_id AS run_id,
         evidence_capsules.workspace_id AS workspace_id,
         evidence_capsules.surface_id AS surface_id,
         (
           SELECT CASE WHEN COUNT(*) = 1 THEN MIN(owner.signal_id) ELSE NULL END
           FROM recall_routing_key_owners AS owner
           WHERE owner.workspace_id = evidence_capsules.workspace_id
             AND owner.owner_kind = 'evidence_capsule'
             AND owner.owner_id = evidence_capsules.object_id
         ) AS source_signal_id
  FROM evidence_capsules
  WHERE evidence_capsules.workspace_id = ?
    AND evidence_capsules.object_id IN (SELECT value FROM json_each(?))
`;

const FIND_SIGNAL_ROWS_SQL = `
  SELECT signal_id, workspace_id, run_id, surface_id, source, signal_kind,
         object_kind, scope_hint, domain_tags_json, confidence, evidence_refs_json,
         source_memory_refs_json, supersedes_refs_json, exception_to_refs_json,
         contradicts_refs_json, incompatible_with_refs_json, raw_payload_json,
         source_delivery_ids_json, source_observation_json, signal_state, created_at
  FROM signals
  WHERE workspace_id = ?
    AND signal_id IN (SELECT value FROM json_each(?))
`;

const FIND_MATERIALIZATION_ROWS_SQL = `
  SELECT event_type, entity_type, entity_id, workspace_id, run_id, caused_by,
         payload_json
  FROM event_log INDEXED BY idx_event_log_entity
  WHERE workspace_id = ?
    AND entity_type = 'candidate_memory_signal'
    AND entity_id IN (SELECT value FROM json_each(?))
    AND event_type = ?
`;

const FIND_PROJECTION_ROWS_SQL = `
  SELECT projection.evidence_object_id, projection.projection_id,
         projection.projection_kind, projection.workspace_id, projection.source_hash,
         projection.content
  FROM evidence_search_projections AS projection
  WHERE projection.workspace_id = ?
    AND projection.evidence_object_id IN (SELECT value FROM json_each(?))
`;
