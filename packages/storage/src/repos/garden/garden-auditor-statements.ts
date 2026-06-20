import type { StorageDatabase } from "../../sqlite/db.js";
import {
  DRAFT_CANDIDATE_LIMIT,
  EXPIRING_GREEN_LIMIT,
  PATTERN_LIMIT,
  POINTER_QUERY_LIMIT
} from "./garden-background-port-constants.js";
import { ACTIVE_STATE } from "./garden-data-port-shared.js";

interface SqliteStatement {
  run(...args: readonly unknown[]): { readonly changes: number };
  get(...args: readonly unknown[]): unknown;
  all(...args: readonly unknown[]): readonly unknown[];
}

export interface PointerHealthStatements {
  readonly memoryEvidenceQuery: SqliteStatement;
  readonly synthesisEvidenceQuery: SqliteStatement;
  readonly synthesisMemoryQuery: SqliteStatement;
  readonly claimEvidenceQuery: SqliteStatement;
  readonly claimSourceObjectQuery: SqliteStatement;
}

export interface GreenMaintenanceStatements {
  readonly expiringStatusesStatement: SqliteStatement;
  readonly renewPassiveStableStatement: SqliteStatement;
  readonly requestActiveVerificationStatement: SqliteStatement;
  readonly revokeStatement: SqliteStatement;
  readonly readMemoryEvidenceRefsStatement: SqliteStatement;
}

export interface BootstrappingStatements {
  readonly countMemoriesStatement: SqliteStatement;
  readonly countClaimsStatement: SqliteStatement;
  readonly draftCandidatesStatement: SqliteStatement;
  readonly patternStatement: SqliteStatement;
  readonly hasPendingStatement: SqliteStatement;
}

const POINTER_MEMORY_EVIDENCE_SQL = `
    SELECT
      m.object_id AS source_object_id,
      'memory_entry' AS source_object_kind,
      ref.value AS broken_ref,
      'evidence_ref' AS ref_kind
    FROM memory_entries m
    JOIN json_each(m.evidence_refs) ref
    LEFT JOIN evidence_capsules e
      ON e.object_id = ref.value
     AND e.workspace_id = m.workspace_id
    WHERE m.workspace_id = ?
      AND m.lifecycle_state = '${ACTIVE_STATE}'
      AND e.object_id IS NULL
    ORDER BY m.updated_at ASC, m.object_id ASC
    LIMIT ${POINTER_QUERY_LIMIT}
  `;

const POINTER_SYNTHESIS_EVIDENCE_SQL = `
    SELECT
      s.object_id AS source_object_id,
      'synthesis_capsule' AS source_object_kind,
      ref.value AS broken_ref,
      'evidence_ref' AS ref_kind
    FROM synthesis_capsules s
    JOIN json_each(s.evidence_refs) ref
    LEFT JOIN evidence_capsules e
      ON e.object_id = ref.value
     AND e.workspace_id = s.workspace_id
    WHERE s.workspace_id = ?
      AND s.lifecycle_state = '${ACTIVE_STATE}'
      AND e.object_id IS NULL
    ORDER BY s.updated_at ASC, s.object_id ASC
    LIMIT ${POINTER_QUERY_LIMIT}
  `;

const POINTER_SYNTHESIS_MEMORY_SQL = `
    SELECT
      s.object_id AS source_object_id,
      'synthesis_capsule' AS source_object_kind,
      ref.value AS broken_ref,
      'memory_ref' AS ref_kind
    FROM synthesis_capsules s
    JOIN json_each(s.source_memory_refs) ref
    LEFT JOIN memory_entries m
      ON m.object_id = ref.value
     AND m.workspace_id = s.workspace_id
    WHERE s.workspace_id = ?
      AND s.lifecycle_state = '${ACTIVE_STATE}'
      AND m.object_id IS NULL
    ORDER BY s.updated_at ASC, s.object_id ASC
    LIMIT ${POINTER_QUERY_LIMIT}
  `;

const POINTER_CLAIM_EVIDENCE_SQL = `
    SELECT
      c.object_id AS source_object_id,
      'claim_form' AS source_object_kind,
      ref.value AS broken_ref,
      'evidence_ref' AS ref_kind
    FROM claim_forms c
    JOIN json_each(c.evidence_refs) ref
    LEFT JOIN evidence_capsules e
      ON e.object_id = ref.value
     AND e.workspace_id = c.workspace_id
    WHERE c.workspace_id = ?
      AND c.lifecycle_state = '${ACTIVE_STATE}'
      AND e.object_id IS NULL
    ORDER BY c.updated_at ASC, c.object_id ASC
    LIMIT ${POINTER_QUERY_LIMIT}
  `;

const POINTER_CLAIM_SOURCE_SQL = `
    SELECT
      c.object_id AS source_object_id,
      'claim_form' AS source_object_kind,
      ref.value AS broken_ref,
      'source_object_ref' AS ref_kind
    FROM claim_forms c
    JOIN json_each(c.source_object_refs) ref
    LEFT JOIN memory_entries m
      ON m.object_id = ref.value
     AND m.workspace_id = c.workspace_id
    LEFT JOIN synthesis_capsules s
      ON s.object_id = ref.value
     AND s.workspace_id = c.workspace_id
    WHERE c.workspace_id = ?
      AND c.lifecycle_state = '${ACTIVE_STATE}'
      AND m.object_id IS NULL
      AND s.object_id IS NULL
    ORDER BY c.updated_at ASC, c.object_id ASC
    LIMIT ${POINTER_QUERY_LIMIT}
  `;

const EXPIRING_GREEN_SQL = `
    SELECT
      g.object_id AS green_status_id,
      g.target_object_id AS memory_entry_id,
      m.dimension AS dimension,
      g.valid_until AS valid_until
    FROM green_statuses g
    JOIN memory_entries m
      ON m.object_id = g.target_object_id
     AND m.workspace_id = g.workspace_id
    WHERE g.workspace_id = ?
      AND g.green_state IN ('eligible', 'grace')
      AND g.valid_until IS NOT NULL
      AND g.valid_until <= ?
    ORDER BY g.valid_until ASC, g.object_id ASC
    LIMIT ${EXPIRING_GREEN_LIMIT}
  `;

const GREEN_RENEW_SQL = `
    UPDATE green_statuses
    SET green_state = 'eligible',
        verification_basis = 'passive_stable',
        verified_by = 'auditor',
        verified_at = ?,
        valid_until = NULL,
        revoke_reason = 'none',
        updated_at = ?,
        last_transition_at = ?
    WHERE object_id = ?
  `;

const GREEN_REQUEST_ACTIVE_SQL = `
    UPDATE green_statuses
    SET green_state = 'grace',
        verification_basis = 'active_verification',
        verified_by = 'auditor',
        verified_at = ?,
        valid_until = CASE
          WHEN valid_until IS NULL OR valid_until < ? THEN ?
          ELSE valid_until
        END,
        revoke_reason = 'none',
        updated_at = ?,
        last_transition_at = ?
    WHERE object_id = ?
  `;

const GREEN_REVOKE_SQL = `
    UPDATE green_statuses
    SET green_state = 'revoked',
        revoke_reason = ?,
        updated_at = ?,
        last_transition_at = ?
    WHERE target_object_id = ?
      AND workspace_id = ?
      AND green_state IN ('eligible', 'grace')
  `;

const READ_MEMORY_EVIDENCE_REFS_SQL = `
    SELECT evidence_refs
    FROM memory_entries
    WHERE object_id = ? AND workspace_id = ?
    LIMIT 1
  `;

const BOOTSTRAP_COUNT_MEMORIES_SQL = `
    SELECT COUNT(*) AS count
    FROM memory_entries
    WHERE workspace_id = ?
      AND lifecycle_state = '${ACTIVE_STATE}'
  `;

const BOOTSTRAP_COUNT_CLAIMS_SQL = `
    SELECT COUNT(*) AS count
    FROM claim_forms
    WHERE workspace_id = ?
      AND lifecycle_state = '${ACTIVE_STATE}'
  `;

const BOOTSTRAP_DRAFT_CANDIDATES_SQL = `
    SELECT candidate_id, object_kind
    FROM (
      SELECT c.object_id AS candidate_id, 'claim_form' AS object_kind
      FROM claim_forms c
      WHERE c.workspace_id = ?
        AND c.lifecycle_state = '${ACTIVE_STATE}'
        AND c.claim_status = 'draft'
      UNION ALL
      SELECT m.object_id AS candidate_id, 'memory_entry' AS object_kind
      FROM memory_entries m
      WHERE m.workspace_id = ?
        AND m.lifecycle_state = '${ACTIVE_STATE}'
    )
    ORDER BY candidate_id ASC
    LIMIT ${DRAFT_CANDIDATE_LIMIT}
  `;

const BOOTSTRAP_PATTERNS_SQL = `
    WITH raw_patterns AS (
      SELECT 'claim:' || json_extract(c.governance_subject, '$.canonical_key') AS pattern_key
      FROM claim_forms c
      WHERE c.workspace_id = ?
        AND c.lifecycle_state = '${ACTIVE_STATE}'
      UNION ALL
      SELECT 'memory:' || lower(trim(substr(m.content, 1, 64))) AS pattern_key
      FROM memory_entries m
      WHERE m.workspace_id = ?
        AND m.lifecycle_state = '${ACTIVE_STATE}'
    )
    SELECT pattern_key, COUNT(*) AS frequency
    FROM raw_patterns
    WHERE pattern_key IS NOT NULL
      AND pattern_key <> 'claim:'
      AND pattern_key <> 'memory:'
    GROUP BY pattern_key
    HAVING COUNT(*) >= ?
    ORDER BY frequency DESC, pattern_key ASC
    LIMIT ${PATTERN_LIMIT}
  `;

const BOOTSTRAP_HAS_PENDING_SQL = `
    SELECT 1
    FROM proposals
    WHERE workspace_id = ?
      AND resolution_state = 'pending'
      AND derived_from = ?
    LIMIT 1
  `;

export function preparePointerHealthStatements(database: StorageDatabase): PointerHealthStatements {
  return {
    memoryEvidenceQuery: database.connection.prepare(POINTER_MEMORY_EVIDENCE_SQL),
    synthesisEvidenceQuery: database.connection.prepare(POINTER_SYNTHESIS_EVIDENCE_SQL),
    synthesisMemoryQuery: database.connection.prepare(POINTER_SYNTHESIS_MEMORY_SQL),
    claimEvidenceQuery: database.connection.prepare(POINTER_CLAIM_EVIDENCE_SQL),
    claimSourceObjectQuery: database.connection.prepare(POINTER_CLAIM_SOURCE_SQL)
  };
}

export function prepareGreenMaintenanceStatements(database: StorageDatabase): GreenMaintenanceStatements {
  return {
    expiringStatusesStatement: database.connection.prepare(EXPIRING_GREEN_SQL),
    renewPassiveStableStatement: database.connection.prepare(GREEN_RENEW_SQL),
    requestActiveVerificationStatement: database.connection.prepare(GREEN_REQUEST_ACTIVE_SQL),
    revokeStatement: database.connection.prepare(GREEN_REVOKE_SQL),
    readMemoryEvidenceRefsStatement: database.connection.prepare(READ_MEMORY_EVIDENCE_REFS_SQL)
  };
}

export function prepareBootstrappingStatements(database: StorageDatabase): BootstrappingStatements {
  return {
    countMemoriesStatement: database.connection.prepare(BOOTSTRAP_COUNT_MEMORIES_SQL),
    countClaimsStatement: database.connection.prepare(BOOTSTRAP_COUNT_CLAIMS_SQL),
    draftCandidatesStatement: database.connection.prepare(BOOTSTRAP_DRAFT_CANDIDATES_SQL),
    patternStatement: database.connection.prepare(BOOTSTRAP_PATTERNS_SQL),
    hasPendingStatement: database.connection.prepare(BOOTSTRAP_HAS_PENDING_SQL)
  };
}
