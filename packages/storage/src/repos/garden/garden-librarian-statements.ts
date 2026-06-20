import type { StorageDatabase } from "../../sqlite/db.js";
import { ACTIVE_STATE } from "./garden-data-port-shared.js";

interface SqliteStatement {
  get(...args: readonly unknown[]): unknown;
  all(...args: readonly unknown[]): readonly unknown[];
}

export interface MergeStatements {
  readonly mergeRowsStatement: SqliteStatement;
  readonly templateRowsStatement: SqliteStatement;
  readonly hasPendingStatement: SqliteStatement;
}

export interface CompressionStatements {
  readonly chainStatement: SqliteStatement;
}

export interface SynthesisStatements {
  readonly synthesisStatement: SqliteStatement;
  readonly hasPendingStatement: SqliteStatement;
}

const MERGE_GROUP_LIMIT = 60;
const MERGE_ROW_LIMIT = 600;
const TEMPLATE_GROUP_LIMIT = 60;
const TEMPLATE_ROW_LIMIT = 600;
const COMPRESSION_CHAIN_LIMIT = 300;
const SYNTHESIS_CLUSTER_LIMIT = 80;
const SYNTHESIS_CLUSTER_ROW_LIMIT = 800;

const MERGE_ROWS_SQL = `
    WITH keyed AS (
      SELECT
        object_id,
        object_kind,
        COALESCE(
          NULLIF(CASE WHEN json_valid(content) THEN json_extract(content, '$.subject') END, ''),
          lower(trim(substr(content, 1, 80)))
        ) AS subject_key
      FROM memory_entries
      WHERE workspace_id = ?
        AND lifecycle_state = '${ACTIVE_STATE}'
    ),
    candidate_subjects AS (
      SELECT subject_key
      FROM keyed
      WHERE subject_key IS NOT NULL
        AND subject_key <> ''
      GROUP BY subject_key
      HAVING COUNT(*) >= 2
      ORDER BY COUNT(*) DESC, subject_key ASC
      LIMIT ${MERGE_GROUP_LIMIT}
    )
    SELECT k.subject_key, k.object_id, k.object_kind
    FROM keyed k
    JOIN candidate_subjects s ON s.subject_key = k.subject_key
    ORDER BY k.subject_key ASC, k.object_id ASC
    LIMIT ${MERGE_ROW_LIMIT}
  `;

const TEMPLATE_ROWS_SQL = `
    WITH templated AS (
      SELECT
        object_id,
        dimension || ':' || COALESCE(
          NULLIF(CASE WHEN json_valid(content) THEN json_extract(content, '$.subject') END, ''),
          lower(trim(substr(content, 1, 60)))
        ) AS pattern_description
      FROM memory_entries
      WHERE workspace_id = ?
        AND lifecycle_state = '${ACTIVE_STATE}'
    ),
    candidate_clusters AS (
      SELECT pattern_description
      FROM templated
      WHERE pattern_description IS NOT NULL
        AND pattern_description <> ''
      GROUP BY pattern_description
      HAVING COUNT(*) >= ?
      ORDER BY COUNT(*) DESC, pattern_description ASC
      LIMIT ${TEMPLATE_GROUP_LIMIT}
    )
    SELECT t.pattern_description, t.object_id
    FROM templated t
    JOIN candidate_clusters c ON c.pattern_description = t.pattern_description
    ORDER BY t.pattern_description ASC, t.object_id ASC
    LIMIT ${TEMPLATE_ROW_LIMIT}
  `;

const HAS_PENDING_DERIVED_SQL = `
    SELECT 1
    FROM proposals
    WHERE resolution_state = 'pending'
      AND derived_from = ?
    LIMIT 1
  `;

const HAS_PENDING_WORKSPACE_DERIVED_SQL = `
    SELECT 1
    FROM proposals
    WHERE workspace_id = ?
      AND resolution_state = 'pending'
      AND derived_from = ?
    LIMIT 1
  `;

const COMPRESSION_CHAINS_SQL = `
    WITH recalls_links AS (
      SELECT
        json_extract(anchors_json, '$.source_anchor.object_id') AS source_object_id,
        json_extract(anchors_json, '$.target_anchor.object_id') AS target_object_id
      FROM path_relations
      WHERE workspace_id = ?
        AND json_valid(constitution_json) = 1
        AND json_valid(effect_vector_json) = 1
        AND json_valid(lifecycle_json) = 1
        AND json_extract(constitution_json, '$.relation_kind') = 'recalls'
        AND COALESCE(json_extract(lifecycle_json, '$.status'), 'active') = 'active'
        AND json_extract(effect_vector_json, '$.recall_bias') > 0
        AND json_extract(anchors_json, '$.source_anchor.object_id') IS NOT NULL
        AND json_extract(anchors_json, '$.target_anchor.object_id') IS NOT NULL
    )
    SELECT
      l1.source_object_id AS chain_start,
      l2.target_object_id AS chain_end,
      l1.target_object_id AS intermediate_id
    FROM recalls_links l1
    JOIN recalls_links l2
      ON l1.target_object_id = l2.source_object_id
    WHERE l1.source_object_id <> l2.target_object_id
    ORDER BY chain_start ASC, chain_end ASC, intermediate_id ASC
    LIMIT ${COMPRESSION_CHAIN_LIMIT}
  `;

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
      UNION ALL
      SELECT
        object_id AS evidence_id,
        COALESCE(
          NULLIF(lower(trim(topic_key)), ''),
          NULLIF(lower(trim(summary)), ''),
          lower(trim(substr(object_id, 1, 80)))
        ) AS subject
      FROM synthesis_capsules
      WHERE workspace_id = ?
        AND lifecycle_state = '${ACTIVE_STATE}'
    ),
    candidate_subjects AS (
      SELECT subject
      FROM keyed
      WHERE subject IS NOT NULL
        AND subject <> ''
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

export function prepareMergeStatements(database: StorageDatabase): MergeStatements {
  return {
    mergeRowsStatement: database.connection.prepare(MERGE_ROWS_SQL),
    templateRowsStatement: database.connection.prepare(TEMPLATE_ROWS_SQL),
    hasPendingStatement: database.connection.prepare(HAS_PENDING_DERIVED_SQL)
  };
}

export function prepareCompressionStatements(database: StorageDatabase): CompressionStatements {
  return {
    chainStatement: database.connection.prepare(COMPRESSION_CHAINS_SQL)
  };
}

export function prepareSynthesisStatements(database: StorageDatabase): SynthesisStatements {
  return {
    synthesisStatement: database.connection.prepare(SYNTHESIS_CLUSTERS_SQL),
    hasPendingStatement: database.connection.prepare(HAS_PENDING_WORKSPACE_DERIVED_SQL)
  };
}
