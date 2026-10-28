import type { StorageDatabase } from "../../../sqlite/db.js";
import { ACTIVE_STATE } from "../garden-data-port-shared.js";

interface SqliteStatement {
  get(...args: readonly unknown[]): unknown;
  all(...args: readonly unknown[]): readonly unknown[];
}

export interface SynthesisStatements {
  readonly synthesisStatement: SqliteStatement;
  readonly hasPendingStatement: SqliteStatement;
}

const SYNTHESIS_CLUSTER_LIMIT = 80;
const SYNTHESIS_CLUSTER_ROW_LIMIT = 800;

const SYNTHESIS_CLUSTERS_SQL = `
    WITH keyed AS (
      SELECT
        object_id AS evidence_id,
        COALESCE(
          NULLIF(CASE WHEN json_valid(semantic_anchor) THEN json_extract(semantic_anchor, '$.subject') END, ''),
          NULLIF(CASE WHEN json_valid(semantic_anchor) THEN json_extract(semantic_anchor, '$.topic') END, ''),
          lower(trim(substr(gist, 1, 80)))
        ) AS subject
      FROM evidence_capsules
      WHERE workspace_id = ?
        AND lifecycle_state = '${ACTIVE_STATE}'
    ),
    candidate_subjects AS (
      SELECT subject
      FROM keyed
      WHERE subject IS NOT NULL
        AND subject <> ''
        AND NOT EXISTS (
          SELECT 1 FROM proposals p
          WHERE p.workspace_id = ? AND p.resolution_state = 'pending'
            AND p.derived_from = 'synthesis-subject:' || keyed.subject
        )
      GROUP BY subject
      HAVING COUNT(*) >= 2
      ORDER BY COUNT(*) DESC, subject ASC
      LIMIT ${SYNTHESIS_CLUSTER_LIMIT}
    )
    SELECT k.subject, k.evidence_id
    FROM keyed k
    JOIN candidate_subjects s ON s.subject = k.subject
    ORDER BY k.subject ASC, k.evidence_id ASC
    LIMIT ${SYNTHESIS_CLUSTER_ROW_LIMIT}
  `;

const HAS_PENDING_WORKSPACE_DERIVED_SQL = `
    SELECT 1
    FROM proposals
    WHERE workspace_id = ?
      AND resolution_state = 'pending'
      AND derived_from = ?
    LIMIT 1
  `;

export function prepareSynthesisStatements(database: StorageDatabase): SynthesisStatements {
  return {
    synthesisStatement: database.connection.prepare(SYNTHESIS_CLUSTERS_SQL),
    hasPendingStatement: database.connection.prepare(HAS_PENDING_WORKSPACE_DERIVED_SQL)
  };
}
