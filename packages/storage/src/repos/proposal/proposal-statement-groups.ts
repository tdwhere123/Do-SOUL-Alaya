import type { StorageDatabase } from "../../sqlite/db.js";
import { MEMORY_ENTRY_SELECT_COLUMNS } from "../memory-entry/row-mapper.js";
import { PROPOSAL_SELECT_COLUMNS } from "./rows.js";

export interface SqliteStatement {
  run(...args: readonly unknown[]): { readonly changes: number };
  get(...args: readonly unknown[]): unknown;
  all(...args: readonly unknown[]): readonly unknown[];
}

type SqlDefinitionMap<T extends object> = { readonly [K in keyof T]: string };
type StatementMap<T extends object> = { -readonly [K in keyof T]: SqliteStatement };

export interface ProposalCreateStatements {
  readonly createStatement: SqliteStatement;
}

export interface ProposalReadStatements {
  readonly findByIdStatement: SqliteStatement;
  readonly findByWorkspaceIdStatement: SqliteStatement;
  readonly findByWorkspaceIdPagedStatement: SqliteStatement;
  readonly countByWorkspaceIdStatement: SqliteStatement;
  readonly findPendingStatement: SqliteStatement;
  readonly findPendingPagedStatement: SqliteStatement;
  readonly findPendingByDedupeKeyStatement: SqliteStatement;
  readonly countPendingStatement: SqliteStatement;
  readonly findPendingByRunIdStatement: SqliteStatement;
}

export interface ProposalReviewerStatements {
  readonly assignReviewerStatement: SqliteStatement;
  readonly findReviewerAssignmentStatement: SqliteStatement;
}

export interface ProposalResolutionStatements {
  readonly updateResolutionStatement: SqliteStatement;
  readonly updateResolutionWithIdentityStatement: SqliteStatement;
  readonly updatePendingResolutionStatement: SqliteStatement;
  readonly updatePendingResolutionWithIdentityStatement: SqliteStatement;
}

export interface ProposalMemoryApplyStatements {
  readonly findMemoryEntryByIdStatement: SqliteStatement;
  readonly updateMemoryEntryStatement: SqliteStatement;
  readonly findRevokableGreenStatusStatement: SqliteStatement;
  readonly revokeGreenStatusStatement: SqliteStatement;
}

export interface ProposalPathRelationApplyStatements {
  readonly findPathRelationByAnchorMemoryIdStatement: SqliteStatement;
  readonly createPathRelationStatement: SqliteStatement;
  readonly updatePathRelationLegitimacyStatement: SqliteStatement;
}

export interface ProposalSynthesisApplyStatements {
  readonly createSynthesisCapsuleStatement: SqliteStatement;
}

const PROPOSAL_CREATE_SQL: SqlDefinitionMap<ProposalCreateStatements> = {
  createStatement: `
      INSERT INTO proposals (
        runtime_id,
        object_kind,
        proposal_id,
        task_surface_ref,
        derived_from,
        retention_policy,
        dossier_ref,
        recommended_option_id,
        proposal_options,
        resolution_state,
        expires_at,
        last_updated_at,
        workspace_id,
        run_id,
        target_object_kind,
        proposed_change_summary,
        proposed_changes,
        proposed_path_relation,
        created_at,
        target_baseline_updated_at,
        source_delivery_ids
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
};

const PROPOSAL_READ_SQL: SqlDefinitionMap<ProposalReadStatements> = {
  findByIdStatement: `
      SELECT${PROPOSAL_SELECT_COLUMNS}
      FROM proposals
      WHERE proposal_id = ?
      LIMIT 1
    `,
  findByWorkspaceIdStatement: `
      SELECT${PROPOSAL_SELECT_COLUMNS}
      FROM proposals
      WHERE workspace_id = ?
      ORDER BY last_updated_at DESC, proposal_id DESC
    `,
  findByWorkspaceIdPagedStatement: `
      SELECT${PROPOSAL_SELECT_COLUMNS}
      FROM proposals
      WHERE workspace_id = ?
      ORDER BY last_updated_at DESC, proposal_id DESC
      LIMIT ? OFFSET ?
    `,
  countByWorkspaceIdStatement: `
      SELECT COUNT(*) AS total
      FROM proposals
      WHERE workspace_id = ?
    `,
  findPendingStatement: `
      SELECT${PROPOSAL_SELECT_COLUMNS}
      FROM proposals
      WHERE workspace_id = ? AND resolution_state = 'pending'
      ORDER BY last_updated_at DESC, proposal_id DESC
    `,
  findPendingPagedStatement: `
      SELECT${PROPOSAL_SELECT_COLUMNS}
      FROM proposals
      WHERE workspace_id = ? AND resolution_state = 'pending'
      ORDER BY last_updated_at DESC, proposal_id DESC
      LIMIT ? OFFSET ?
    `,
  findPendingByDedupeKeyStatement: `
      SELECT${PROPOSAL_SELECT_COLUMNS}
      FROM proposals
      WHERE workspace_id = ?
        AND resolution_state = 'pending'
        AND target_object_kind = ?
        AND derived_from = ?
        AND dossier_ref = ?
      ORDER BY last_updated_at DESC, proposal_id DESC
      LIMIT 1
    `,
  countPendingStatement: `
      SELECT COUNT(*) AS total
      FROM proposals
      WHERE workspace_id = ? AND resolution_state = 'pending'
    `,
  findPendingByRunIdStatement: `
      SELECT${PROPOSAL_SELECT_COLUMNS}
      FROM proposals
      WHERE run_id = ? AND resolution_state = 'pending' AND dossier_ref IS NOT NULL
      ORDER BY last_updated_at DESC, proposal_id DESC
      LIMIT 1
    `
};

const PROPOSAL_REVIEWER_SQL: SqlDefinitionMap<ProposalReviewerStatements> = {
  assignReviewerStatement: `
      INSERT INTO proposal_reviewer_assignments (
        proposal_id,
        reviewer_identity,
        assigned_at,
        deadline_at,
        escalation_after_ms
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(proposal_id) DO UPDATE SET
        reviewer_identity = excluded.reviewer_identity,
        assigned_at = excluded.assigned_at,
        deadline_at = excluded.deadline_at,
        escalation_after_ms = excluded.escalation_after_ms
    `,
  findReviewerAssignmentStatement: `
      SELECT
        proposal_id,
        reviewer_identity,
        assigned_at,
        deadline_at,
        escalation_after_ms
      FROM proposal_reviewer_assignments
      WHERE proposal_id = ?
      LIMIT 1
    `
};

const PROPOSAL_RESOLUTION_SQL: SqlDefinitionMap<ProposalResolutionStatements> = {
  updateResolutionStatement: `
      UPDATE proposals
      SET resolution_state = ?, last_updated_at = ?
      WHERE proposal_id = ?
    `,
  updateResolutionWithIdentityStatement: `
      UPDATE proposals
      SET resolution_state = ?, last_updated_at = ?, reviewer_identity = ?
      WHERE proposal_id = ?
    `,
  updatePendingResolutionStatement: `
      UPDATE proposals
      SET resolution_state = ?, last_updated_at = ?
      WHERE proposal_id = ? AND resolution_state = 'pending'
    `,
  updatePendingResolutionWithIdentityStatement: `
      UPDATE proposals
      SET resolution_state = ?, last_updated_at = ?, reviewer_identity = ?
      WHERE proposal_id = ? AND resolution_state = 'pending'
    `
};

const PROPOSAL_MEMORY_APPLY_SQL: SqlDefinitionMap<ProposalMemoryApplyStatements> = {
  findMemoryEntryByIdStatement: `
      SELECT${MEMORY_ENTRY_SELECT_COLUMNS}
      FROM memory_entries
      WHERE object_id = ?
      LIMIT 1
    `,
  updateMemoryEntryStatement: `
      UPDATE memory_entries
      SET
        content = COALESCE(?, content),
        domain_tags = COALESCE(?, domain_tags),
        evidence_refs = COALESCE(?, evidence_refs),
        storage_tier = COALESCE(?, storage_tier),
        confidence = COALESCE(?, confidence),
        retention_state = COALESCE(?, retention_state),
        updated_at = ?
      WHERE object_id = ?
    `,
  findRevokableGreenStatusStatement: `
      SELECT object_id
      FROM green_statuses
      WHERE target_object_id = ?
        AND workspace_id = ?
        AND green_state IN ('eligible', 'grace')
      LIMIT 1
    `,
  revokeGreenStatusStatement: `
      UPDATE green_statuses
      SET
        green_state = 'revoked',
        revoke_reason = ?,
        updated_at = ?,
        last_transition_at = ?
      WHERE object_id = ?
        AND target_object_id = ?
        AND workspace_id = ?
        AND green_state IN ('eligible', 'grace')
    `
};

const PROPOSAL_PATH_RELATION_APPLY_SQL: SqlDefinitionMap<ProposalPathRelationApplyStatements> = {
  findPathRelationByAnchorMemoryIdStatement: `
      SELECT
        path_id,
        workspace_id,
        anchors_json,
        constitution_json,
        effect_vector_json,
        plasticity_state_json,
        lifecycle_json,
        legitimacy_json,
        created_at,
        updated_at
      FROM path_relations
      WHERE workspace_id = ?
        AND (
          json_extract(anchors_json, '$.source_anchor.object_id') = ?
          OR json_extract(anchors_json, '$.target_anchor.object_id') = ?
          OR json_extract(anchors_json, '$.source_anchor.source_object_id') = ?
          OR json_extract(anchors_json, '$.target_anchor.source_object_id') = ?
        )
      ORDER BY
        CASE WHEN COALESCE(json_extract(lifecycle_json, '$.status'), 'active') = 'retired' THEN 1 ELSE 0 END,
        created_at ASC,
        path_id ASC
    `,
  createPathRelationStatement: `
      INSERT INTO path_relations (
        path_id,
        workspace_id,
        anchors_json,
        constitution_json,
        effect_vector_json,
        plasticity_state_json,
        lifecycle_json,
        legitimacy_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  updatePathRelationLegitimacyStatement: `
      UPDATE path_relations
      SET legitimacy_json = ?, updated_at = ?
      WHERE path_id = ?
    `
};

const PROPOSAL_SYNTHESIS_APPLY_SQL: SqlDefinitionMap<ProposalSynthesisApplyStatements> = {
  createSynthesisCapsuleStatement: `
      INSERT INTO synthesis_capsules (
        object_id,
        object_kind,
        schema_version,
        lifecycle_state,
        created_at,
        updated_at,
        created_by,
        topic_key,
        synthesis_type,
        summary,
        evidence_refs,
        source_memory_refs,
        workspace_id,
        run_id,
        synthesis_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
};

export function prepareProposalCreateStatements(db: StorageDatabase): ProposalCreateStatements {
  return prepareStatementGroup(db, PROPOSAL_CREATE_SQL);
}

export function prepareProposalReadStatements(db: StorageDatabase): ProposalReadStatements {
  return prepareStatementGroup(db, PROPOSAL_READ_SQL);
}

export function prepareProposalReviewerStatements(db: StorageDatabase): ProposalReviewerStatements {
  return prepareStatementGroup(db, PROPOSAL_REVIEWER_SQL);
}

export function prepareProposalResolutionStatements(
  db: StorageDatabase
): ProposalResolutionStatements {
  return prepareStatementGroup(db, PROPOSAL_RESOLUTION_SQL);
}

export function prepareProposalMemoryApplyStatements(
  db: StorageDatabase
): ProposalMemoryApplyStatements {
  return prepareStatementGroup(db, PROPOSAL_MEMORY_APPLY_SQL);
}

export function prepareProposalPathRelationApplyStatements(
  db: StorageDatabase
): ProposalPathRelationApplyStatements {
  return prepareStatementGroup(db, PROPOSAL_PATH_RELATION_APPLY_SQL);
}

export function prepareProposalSynthesisApplyStatements(
  db: StorageDatabase
): ProposalSynthesisApplyStatements {
  return prepareStatementGroup(db, PROPOSAL_SYNTHESIS_APPLY_SQL);
}

function prepareStatementGroup<T extends object>(
  db: StorageDatabase,
  sqlByName: SqlDefinitionMap<T>
): T {
  const statements = {} as StatementMap<T>;
  for (const key of Object.keys(sqlByName) as Array<keyof T>) {
    statements[key] = db.connection.prepare(sqlByName[key]);
  }
  return statements as T;
}
