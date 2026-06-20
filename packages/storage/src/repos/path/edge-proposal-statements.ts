import type { StorageDatabase } from "../../sqlite/db.js";
import {
  PATH_RELATION_SOURCE_BACKING_OBJECT_ID_SQL,
  PATH_RELATION_TARGET_BACKING_OBJECT_ID_SQL
} from "./path-relation-repo.js";

export interface SqliteEdgeProposalStatement {
  readonly source: string;
  run(...args: readonly unknown[]): { readonly changes: number };
  get(...args: readonly unknown[]): unknown;
  all(...args: readonly unknown[]): readonly unknown[];
}

export interface EdgeProposalStatements {
  readonly createStatement: SqliteEdgeProposalStatement;
  readonly findByIdStatement: SqliteEdgeProposalStatement;
  readonly findPendingDuplicateStatement: SqliteEdgeProposalStatement;
  readonly listAcceptedAwaitingPathStatement: SqliteEdgeProposalStatement;
  readonly acceptedPositiveRecallsPathExistsStatement: SqliteEdgeProposalStatement;
  readonly acceptedDirectionalPathExistsStatement: SqliteEdgeProposalStatement;
  readonly updateReviewStatement: SqliteEdgeProposalStatement;
  readonly reconcileAfterMintFailureStatement: SqliteEdgeProposalStatement;
}

type EdgeProposalSqlMap = { readonly [K in keyof EdgeProposalStatements]: string };
type MutableEdgeProposalStatements = {
  -readonly [K in keyof EdgeProposalStatements]: SqliteEdgeProposalStatement;
};

const POSITIVE_RECALLS_FAMILY_RELATION_KIND_SQL =
  "'recalls', 'co_recalled', 'shares_entity', 'signal_graph_ref'";

const EDGE_PROPOSAL_SQL: EdgeProposalSqlMap = {
  createStatement: `
      INSERT INTO edge_proposals (
        proposal_id,
        workspace_id,
        source_memory_id,
        target_memory_id,
        edge_type,
        trigger_source,
        confidence,
        reason,
        source_signal_id,
        run_id,
        status,
        reviewer_identity,
        review_reason,
        created_at,
        updated_at,
        expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?, ?)
    `,
  findByIdStatement: `
      SELECT *
      FROM edge_proposals
      WHERE proposal_id = ?
      LIMIT 1
    `,
  findPendingDuplicateStatement: `
      SELECT *
      FROM edge_proposals
      WHERE workspace_id = ?
        AND source_memory_id = ?
        AND target_memory_id = ?
        AND edge_type = ?
        AND status = 'pending'
      LIMIT 1
    `,
  listAcceptedAwaitingPathStatement: `
      SELECT *
      FROM edge_proposals
      WHERE workspace_id = ?
        AND status IN ('accepted', 'auto_accepted')
      ORDER BY created_at ASC, proposal_id ASC
      LIMIT ?
      OFFSET ?
    `,
  acceptedPositiveRecallsPathExistsStatement: `
      SELECT 1
      FROM path_relations INDEXED BY idx_path_relations_source_backing_object_id
      WHERE workspace_id = ?
        AND ${PATH_RELATION_SOURCE_BACKING_OBJECT_ID_SQL} = ?
        AND ${PATH_RELATION_TARGET_BACKING_OBJECT_ID_SQL} = ?
        AND json_extract(constitution_json, '$.relation_kind') IN (${POSITIVE_RECALLS_FAMILY_RELATION_KIND_SQL})
        AND json_extract(effect_vector_json, '$.recall_bias') > 0
      UNION ALL
      SELECT 1
      FROM path_relations INDEXED BY idx_path_relations_target_backing_object_id
      WHERE workspace_id = ?
        AND ${PATH_RELATION_SOURCE_BACKING_OBJECT_ID_SQL} = ?
        AND ${PATH_RELATION_TARGET_BACKING_OBJECT_ID_SQL} = ?
        AND json_extract(constitution_json, '$.relation_kind') IN (${POSITIVE_RECALLS_FAMILY_RELATION_KIND_SQL})
        AND json_extract(effect_vector_json, '$.recall_bias') > 0
      LIMIT 1
    `,
  acceptedDirectionalPathExistsStatement: `
      SELECT 1
      FROM path_relations INDEXED BY idx_path_relations_source_backing_object_id
      WHERE workspace_id = ?
        AND ${PATH_RELATION_SOURCE_BACKING_OBJECT_ID_SQL} = ?
        AND ${PATH_RELATION_TARGET_BACKING_OBJECT_ID_SQL} = ?
        AND json_extract(constitution_json, '$.relation_kind') = ?
        AND (
          (? = 'positive' AND json_extract(effect_vector_json, '$.recall_bias') > 0)
          OR (? = 'negative' AND json_extract(effect_vector_json, '$.recall_bias') < 0)
          OR (? = 'neutral' AND json_extract(effect_vector_json, '$.recall_bias') = 0)
        )
      LIMIT 1
    `,
  updateReviewStatement: `
      UPDATE edge_proposals
      SET status = ?,
          reviewer_identity = ?,
          review_reason = ?,
          updated_at = ?
      WHERE proposal_id = ?
        AND status = 'pending'
    `,
  reconcileAfterMintFailureStatement: `
      UPDATE edge_proposals
      SET status = ?,
          reviewer_identity = ?,
          review_reason = ?,
          updated_at = ?
      WHERE proposal_id = ?
        AND status = ?
    `
};

export function prepareEdgeProposalStatements(db: StorageDatabase): EdgeProposalStatements {
  return prepareEdgeProposalStatementGroup(db, EDGE_PROPOSAL_SQL);
}

function prepareEdgeProposalStatementGroup(
  db: StorageDatabase,
  sqlByName: EdgeProposalSqlMap
): EdgeProposalStatements {
  const statements = {} as MutableEdgeProposalStatements;
  for (const key of Object.keys(sqlByName) as Array<keyof EdgeProposalStatements>) {
    statements[key] = db.connection.prepare(sqlByName[key]);
  }
  return statements;
}
