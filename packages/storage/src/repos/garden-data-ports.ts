import { randomUUID } from "node:crypto";
import {
  ControlPlaneObjectKind,
  ProposalOptionKind,
  ProposalResolutionState,
  RetentionPolicy,
  type BrokenPointerRecord,
  type ColdStartAssessment,
  type DraftCandidate,
  type ExpiringGreenStatus,
  type HighFrequencyPattern,
  type StaleMemoryEntry
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../db.js";

const STALE_EVIDENCE_LIMIT = 120;
const POINTER_QUERY_LIMIT = 120;
const POINTER_RESULT_LIMIT = 240;
const EXPIRING_GREEN_LIMIT = 120;
const DRAFT_CANDIDATE_LIMIT = 120;
const PATTERN_LIMIT = 120;
const HOT_DEMOTION_LIMIT = 120;
const MERGE_GROUP_LIMIT = 60;
const MERGE_ROW_LIMIT = 600;
const TEMPLATE_GROUP_LIMIT = 60;
const TEMPLATE_ROW_LIMIT = 600;
const NEIGHBOR_GROUP_LIMIT = 120;
const NEIGHBOR_ROW_LIMIT = 1000;
const COMPRESSION_CHAIN_LIMIT = 300;
const SYNTHESIS_CLUSTER_LIMIT = 80;
const SYNTHESIS_CLUSTER_ROW_LIMIT = 800;
const ACTIVE_VERIFICATION_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

const BOOTSTRAP_MEMORY_THRESHOLD = 10;
const BOOTSTRAP_CLAIM_THRESHOLD = 5;

const BOUNDARY_COLD_TIER = "cold";
const ACTIVE_STATE = "active";

export interface GardenDataPortFactoryOptions {
  readonly now?: () => string;
  readonly generateId?: () => string;
}

export interface GardenHotDemotionCandidate {
  readonly memory_entry_id: string;
  readonly last_access_at: string | null;
  readonly activation_score: number;
}

export interface GardenJanitorHotDemotionCriteria {
  readonly maxLastHitAgeMs: number;
  readonly minActivationScore: number;
}

export interface GardenJanitorMemoryTieringPort {
  findHotDemotionCandidates(
    workspaceId: string,
    criteria: GardenJanitorHotDemotionCriteria
  ): Promise<readonly GardenHotDemotionCandidate[]>;
  demoteToWarm(workspaceId: string, memoryEntryIds: readonly string[]): Promise<void>;
}

export interface GardenMergeCandidate {
  readonly primary_id: string;
  readonly duplicate_ids: readonly string[];
  readonly object_kind: string;
  readonly similarity_score: number;
}

export interface GardenTemplateCluster {
  readonly representative_id: string;
  readonly member_ids: readonly string[];
  readonly pattern_description: string;
}

export interface GardenNeighborGroup {
  readonly subject: string;
  readonly object_ids: readonly string[];
  readonly overlap_basis: string;
}

export interface GardenCompressionCandidate {
  readonly chain_start: string;
  readonly chain_end: string;
  readonly intermediate_ids: readonly string[];
}

export interface GardenSynthesisCandidateCluster {
  readonly subject: string;
  readonly evidence_ids: readonly string[];
}

export interface GardenLibrarianMergeDetectionPort {
  findMergeCandidates(workspaceId: string): Promise<readonly GardenMergeCandidate[]>;
  hasPendingMergeProposal(primaryId: string): Promise<boolean>;
  createMergeProposal(
    workspaceId: string,
    candidate: GardenMergeCandidate
  ): Promise<{ readonly proposal_id: string }>;
  findTemplateClusters(workspaceId: string, minClusterSize: number): Promise<readonly GardenTemplateCluster[]>;
  hasPendingTemplateProposal(representativeId: string): Promise<boolean>;
  createTemplateCandidate(
    workspaceId: string,
    cluster: GardenTemplateCluster
  ): Promise<{ readonly candidate_id: string }>;
}

export interface GardenLibrarianNeighborDetectionPort {
  findSubjectNeighbors(workspaceId: string): Promise<readonly GardenNeighborGroup[]>;
}

export interface GardenLibrarianPathCompressionPort {
  findCompressiblePaths(workspaceId: string): Promise<readonly GardenCompressionCandidate[]>;
  createCompressionCandidate(
    workspaceId: string,
    candidate: GardenCompressionCandidate
  ): Promise<{ readonly candidate_id: string }>;
}

export interface GardenLibrarianSynthesisThrottlePort {
  findSynthesisCandidateClusters(workspaceId: string): Promise<readonly GardenSynthesisCandidateCluster[]>;
  hasPendingSynthesisForSubject(workspaceId: string, subject: string): Promise<boolean>;
  createSynthesisReviewCandidate(
    workspaceId: string,
    subject: string,
    evidenceIds: readonly string[]
  ): Promise<{ readonly candidate_id: string }>;
}

export interface GardenAuditorEvidenceCheckPort {
  findMemoriesWithStaleEvidence(workspaceId: string): Promise<readonly StaleMemoryEntry[]>;
}

export interface GardenAuditorPointerHealthPort {
  findBrokenPointers(workspaceId: string): Promise<readonly BrokenPointerRecord[]>;
}

export interface GardenAuditorGreenMaintenancePort {
  findExpiringGreenStatuses(workspaceId: string, lookaheadMs: number): Promise<readonly ExpiringGreenStatus[]>;
  renewGreenPassiveStable(greenStatusId: string, taskId: string): Promise<void>;
  requestActiveVerification(greenStatusId: string, taskId: string): Promise<void>;
  revokeGreen(memoryEntryId: string, reason: "verification_fail", taskId: string): Promise<void>;
}

export interface GardenAuditorBootstrappingPort {
  assessColdStart(workspaceId: string): Promise<ColdStartAssessment>;
  generateDraftCandidates(workspaceId: string): Promise<readonly DraftCandidate[]>;
  findHighFrequencyPatterns(workspaceId: string, minFrequency: number): Promise<readonly HighFrequencyPattern[]>;
  createSynthesisCandidate(workspaceId: string, patternKey: string): Promise<{ readonly candidate_id: string }>;
  hasPendingSynthesisCandidate(workspaceId: string, patternKey: string): Promise<boolean>;
}

export interface GardenBackgroundDataPorts {
  readonly tieringPort: GardenJanitorMemoryTieringPort;
  readonly evidenceCheckPort: GardenAuditorEvidenceCheckPort;
  readonly pointerHealthPort: GardenAuditorPointerHealthPort;
  readonly greenMaintenancePort: GardenAuditorGreenMaintenancePort;
  readonly bootstrappingPort: GardenAuditorBootstrappingPort;
  readonly mergePort: GardenLibrarianMergeDetectionPort;
  readonly neighborPort: GardenLibrarianNeighborDetectionPort;
  readonly compressionPort: GardenLibrarianPathCompressionPort;
  readonly synthesisPort: GardenLibrarianSynthesisThrottlePort;
}

interface CandidateProposalInput {
  readonly workspaceId: string;
  readonly derivedFrom: string;
  readonly dossierRef: string;
  readonly droppedCandidates?: readonly string[];
  readonly unresolvedAfterApply?: readonly string[];
}

interface SubjectRow {
  readonly subject_key: string;
  readonly object_id: string;
  readonly object_kind: string;
}

interface PatternRow {
  readonly pattern_key: string;
  readonly frequency: number;
}

interface ChainRow {
  readonly chain_start: string;
  readonly chain_end: string;
  readonly intermediate_id: string;
}

interface SynthesisRow {
  readonly subject: string;
  readonly evidence_id: string;
}

interface BaseFactoryContext {
  readonly database: StorageDatabase;
  readonly now: () => string;
  readonly generateId: () => string;
}

export function createGardenBackgroundDataPorts(
  database: StorageDatabase,
  options: GardenDataPortFactoryOptions = {}
): GardenBackgroundDataPorts {
  const context: BaseFactoryContext = {
    database,
    now: options.now ?? (() => new Date().toISOString()),
    generateId: options.generateId ?? (() => randomUUID())
  };

  return {
    tieringPort: createTieringPort(context),
    evidenceCheckPort: createEvidenceCheckPort(context),
    pointerHealthPort: createPointerHealthPort(context),
    greenMaintenancePort: createGreenMaintenancePort(context),
    bootstrappingPort: createBootstrappingPort(context),
    mergePort: createMergePort(context),
    neighborPort: createNeighborPort(context),
    compressionPort: createCompressionPort(context),
    synthesisPort: createSynthesisPort(context)
  };
}

function createTieringPort(context: BaseFactoryContext): GardenJanitorMemoryTieringPort {
  const findHotDemotionCandidatesStatement = context.database.connection.prepare(`
    SELECT
      object_id AS memory_entry_id,
      COALESCE(last_hit_at, last_used_at) AS last_access_at,
      activation_score
    FROM memory_entries
    WHERE workspace_id = ?
      AND lifecycle_state = '${ACTIVE_STATE}'
      AND storage_tier = 'hot'
      AND activation_score IS NOT NULL
      AND activation_score < ?
      AND COALESCE(last_hit_at, last_used_at, created_at) <= ?
    ORDER BY activation_score ASC, COALESCE(last_hit_at, last_used_at, created_at) ASC, object_id ASC
    LIMIT ${HOT_DEMOTION_LIMIT}
  `);

  return {
    findHotDemotionCandidates: async (workspaceId, criteria) => {
      const staleBefore = addMilliseconds(context.now(), -Math.max(0, criteria.maxLastHitAgeMs));
      const rows = findHotDemotionCandidatesStatement.all(
        workspaceId,
        criteria.minActivationScore,
        staleBefore
      ) as readonly GardenHotDemotionCandidate[];
      return rows;
    },
    demoteToWarm: async (workspaceId, memoryEntryIds) => {
      const uniqueIds = Array.from(new Set(memoryEntryIds.filter((entryId) => entryId.length > 0)));
      if (uniqueIds.length === 0) {
        return;
      }

      const placeholders = uniqueIds.map(() => "?").join(", ");
      context.database.connection
        .prepare(
          `UPDATE memory_entries
           SET storage_tier = '${BOUNDARY_COLD_TIER}', updated_at = ?
           WHERE workspace_id = ?
             AND object_id IN (${placeholders})
             AND lifecycle_state = '${ACTIVE_STATE}'`
        )
        .run(context.now(), workspaceId, ...uniqueIds);
    }
  };
}

function createEvidenceCheckPort(context: BaseFactoryContext): GardenAuditorEvidenceCheckPort {
  const staleEvidenceStatement = context.database.connection.prepare(`
    SELECT
      m.object_id AS memory_entry_id,
      json_group_array(ref.value) AS stale_evidence_refs_json
    FROM memory_entries m
    JOIN json_each(m.evidence_refs) ref
    LEFT JOIN evidence_capsules e
      ON e.object_id = ref.value
     AND e.workspace_id = m.workspace_id
    WHERE m.workspace_id = ?
      AND m.lifecycle_state = '${ACTIVE_STATE}'
      AND (e.object_id IS NULL OR e.evidence_health_state <> 'verified')
    GROUP BY m.object_id, m.updated_at
    ORDER BY m.updated_at ASC, m.object_id ASC
    LIMIT ${STALE_EVIDENCE_LIMIT}
  `);

  return {
    findMemoriesWithStaleEvidence: async (workspaceId) => {
      const rows = staleEvidenceStatement.all(workspaceId) as readonly {
        readonly memory_entry_id: string;
        readonly stale_evidence_refs_json: string;
      }[];

      return rows.map((row) => {
        const staleEvidenceRefs = JSON.parse(row.stale_evidence_refs_json) as string[];
        return {
          memory_entry_id: row.memory_entry_id,
          stale_evidence_refs: staleEvidenceRefs
        };
      });
    }
  };
}

function createPointerHealthPort(context: BaseFactoryContext): GardenAuditorPointerHealthPort {
  const memoryEvidenceQuery = context.database.connection.prepare(`
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
  `);

  const synthesisEvidenceQuery = context.database.connection.prepare(`
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
  `);

  const synthesisMemoryQuery = context.database.connection.prepare(`
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
  `);

  const claimEvidenceQuery = context.database.connection.prepare(`
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
  `);

  const claimSourceObjectQuery = context.database.connection.prepare(`
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
  `);

  return {
    findBrokenPointers: async (workspaceId) => {
      const rows = [
        ...(memoryEvidenceQuery.all(workspaceId) as readonly BrokenPointerRecord[]),
        ...(synthesisEvidenceQuery.all(workspaceId) as readonly BrokenPointerRecord[]),
        ...(synthesisMemoryQuery.all(workspaceId) as readonly BrokenPointerRecord[]),
        ...(claimEvidenceQuery.all(workspaceId) as readonly BrokenPointerRecord[]),
        ...(claimSourceObjectQuery.all(workspaceId) as readonly BrokenPointerRecord[])
      ];

      const deduped = Array.from(
        new Map(rows.map((row) => [`${row.source_object_id}|${row.broken_ref}|${row.ref_kind}`, row])).values()
      );

      deduped.sort((left, right) => {
        return (
          left.source_object_kind.localeCompare(right.source_object_kind) ||
          left.source_object_id.localeCompare(right.source_object_id) ||
          left.broken_ref.localeCompare(right.broken_ref) ||
          left.ref_kind.localeCompare(right.ref_kind)
        );
      });

      return deduped.slice(0, POINTER_RESULT_LIMIT);
    }
  };
}

function createGreenMaintenancePort(context: BaseFactoryContext): GardenAuditorGreenMaintenancePort {
  const expiringStatusesStatement = context.database.connection.prepare(`
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
  `);

  const renewPassiveStableStatement = context.database.connection.prepare(`
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
  `);

  const requestActiveVerificationStatement = context.database.connection.prepare(`
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
  `);

  const revokeStatement = context.database.connection.prepare(`
    UPDATE green_statuses
    SET green_state = 'revoked',
        revoke_reason = ?,
        updated_at = ?,
        last_transition_at = ?
    WHERE target_object_id = ?
  `);

  return {
    findExpiringGreenStatuses: async (workspaceId, lookaheadMs) => {
      const cutoffIso = addMilliseconds(context.now(), Math.max(0, lookaheadMs));
      return expiringStatusesStatement.all(workspaceId, cutoffIso) as readonly ExpiringGreenStatus[];
    },
    renewGreenPassiveStable: async (greenStatusId) => {
      const nowIso = context.now();
      renewPassiveStableStatement.run(nowIso, nowIso, nowIso, greenStatusId);
    },
    requestActiveVerification: async (greenStatusId) => {
      const nowIso = context.now();
      const graceUntil = addMilliseconds(nowIso, ACTIVE_VERIFICATION_GRACE_MS);
      requestActiveVerificationStatement.run(nowIso, nowIso, graceUntil, nowIso, nowIso, greenStatusId);
    },
    revokeGreen: async (memoryEntryId, reason) => {
      const nowIso = context.now();
      revokeStatement.run(reason, nowIso, nowIso, memoryEntryId);
    }
  };
}

function createBootstrappingPort(context: BaseFactoryContext): GardenAuditorBootstrappingPort {
  const countMemoriesStatement = context.database.connection.prepare(`
    SELECT COUNT(*) AS count
    FROM memory_entries
    WHERE workspace_id = ?
      AND lifecycle_state = '${ACTIVE_STATE}'
  `);

  const countClaimsStatement = context.database.connection.prepare(`
    SELECT COUNT(*) AS count
    FROM claim_forms
    WHERE workspace_id = ?
      AND lifecycle_state = '${ACTIVE_STATE}'
  `);

  const draftCandidatesStatement = context.database.connection.prepare(`
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
  `);

  const patternStatement = context.database.connection.prepare(`
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
  `);

  const hasPendingStatement = context.database.connection.prepare(`
    SELECT 1
    FROM proposals
    WHERE workspace_id = ?
      AND resolution_state = 'pending'
      AND derived_from = ?
    LIMIT 1
  `);

  return {
    assessColdStart: async (workspaceId) => {
      const memoryCountRow = countMemoriesStatement.get(workspaceId) as { readonly count: number } | undefined;
      const claimCountRow = countClaimsStatement.get(workspaceId) as { readonly count: number } | undefined;
      const memoryCount = memoryCountRow?.count ?? 0;
      const claimCount = claimCountRow?.count ?? 0;
      return {
        is_cold_start:
          memoryCount < BOOTSTRAP_MEMORY_THRESHOLD && claimCount < BOOTSTRAP_CLAIM_THRESHOLD,
        memory_count: memoryCount,
        claim_count: claimCount
      };
    },
    generateDraftCandidates: async (workspaceId) => {
      const rows = draftCandidatesStatement.all(workspaceId, workspaceId) as readonly {
        readonly candidate_id: string;
        readonly object_kind: string;
      }[];

      return rows.map((row) => ({
        candidate_id: row.candidate_id,
        object_kind: row.object_kind,
        lifecycle_state: "candidate",
        requires_review: true,
        workspace_id: workspaceId
      }));
    },
    findHighFrequencyPatterns: async (workspaceId, minFrequency) => {
      const rows = patternStatement.all(workspaceId, workspaceId, Math.max(1, minFrequency)) as readonly PatternRow[];
      return rows.map((row) => ({
        pattern_key: row.pattern_key,
        frequency: row.frequency
      }));
    },
    createSynthesisCandidate: async (workspaceId, patternKey) => {
      const candidateId = createPendingCandidateProposal(context, {
        workspaceId,
        derivedFrom: buildDerivedKey("bootstrapping", patternKey),
        dossierRef: "bootstrapping.synthesis_candidate"
      });
      return { candidate_id: candidateId };
    },
    hasPendingSynthesisCandidate: async (workspaceId, patternKey) => {
      const row = hasPendingStatement.get(workspaceId, buildDerivedKey("bootstrapping", patternKey));
      return row !== undefined;
    }
  };
}

function createMergePort(context: BaseFactoryContext): GardenLibrarianMergeDetectionPort {
  const mergeRowsStatement = context.database.connection.prepare(`
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
  `);

  const templateRowsStatement = context.database.connection.prepare(`
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
  `);

  const hasPendingStatement = context.database.connection.prepare(`
    SELECT 1
    FROM proposals
    WHERE resolution_state = 'pending'
      AND derived_from = ?
    LIMIT 1
  `);

  return {
    findMergeCandidates: async (workspaceId) => {
      const rows = mergeRowsStatement.all(workspaceId) as readonly SubjectRow[];
      const grouped = groupBySubject(rows);
      return grouped.map((group) => {
        const primary = group.objectIds[0];
        const duplicates = group.objectIds.slice(1);
        return {
          primary_id: primary,
          duplicate_ids: duplicates,
          object_kind: group.objectKind,
          similarity_score: Math.min(0.99, 0.8 + duplicates.length * 0.05)
        };
      });
    },
    hasPendingMergeProposal: async (primaryId) => {
      const row = hasPendingStatement.get(buildDerivedKey("merge-primary", primaryId));
      return row !== undefined;
    },
    createMergeProposal: async (workspaceId, candidate) => {
      const proposalId = createPendingCandidateProposal(context, {
        workspaceId,
        derivedFrom: buildDerivedKey("merge-primary", candidate.primary_id),
        dossierRef: "librarian.merge",
        droppedCandidates: candidate.duplicate_ids
      });
      return { proposal_id: proposalId };
    },
    findTemplateClusters: async (workspaceId, minClusterSize) => {
      const rows = templateRowsStatement.all(workspaceId, Math.max(2, minClusterSize)) as readonly {
        readonly pattern_description: string;
        readonly object_id: string;
      }[];
      const grouped = groupRows(rows, (row) => row.pattern_description, (row) => row.object_id);

      return grouped.map((group) => ({
        representative_id: group.objectIds[0],
        member_ids: group.objectIds,
        pattern_description: group.key
      }));
    },
    hasPendingTemplateProposal: async (representativeId) => {
      const row = hasPendingStatement.get(buildDerivedKey("template-representative", representativeId));
      return row !== undefined;
    },
    createTemplateCandidate: async (workspaceId, cluster) => {
      const candidateId = createPendingCandidateProposal(context, {
        workspaceId,
        derivedFrom: buildDerivedKey("template-representative", cluster.representative_id),
        dossierRef: "librarian.template",
        droppedCandidates: cluster.member_ids.slice(1)
      });
      return { candidate_id: candidateId };
    }
  };
}

function createNeighborPort(context: BaseFactoryContext): GardenLibrarianNeighborDetectionPort {
  const neighborRowsStatement = context.database.connection.prepare(`
    WITH keyed AS (
      SELECT
        object_id,
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
      LIMIT ${NEIGHBOR_GROUP_LIMIT}
    )
    SELECT k.subject_key, k.object_id
    FROM keyed k
    JOIN candidate_subjects s ON s.subject_key = k.subject_key
    ORDER BY k.subject_key ASC, k.object_id ASC
    LIMIT ${NEIGHBOR_ROW_LIMIT}
  `);

  return {
    findSubjectNeighbors: async (workspaceId) => {
      const rows = neighborRowsStatement.all(workspaceId) as readonly {
        readonly subject_key: string;
        readonly object_id: string;
      }[];
      const grouped = groupRows(rows, (row) => row.subject_key, (row) => row.object_id);
      return grouped.map((group) => ({
        subject: group.key,
        object_ids: group.objectIds,
        overlap_basis: "subject_key_overlap"
      }));
    }
  };
}

function createCompressionPort(context: BaseFactoryContext): GardenLibrarianPathCompressionPort {
  const chainStatement = context.database.connection.prepare(`
    SELECT
      e1.source_memory_id AS chain_start,
      e2.target_memory_id AS chain_end,
      e1.target_memory_id AS intermediate_id
    FROM memory_graph_edges e1
    JOIN memory_graph_edges e2
      ON e1.workspace_id = e2.workspace_id
     AND e1.target_memory_id = e2.source_memory_id
    WHERE e1.workspace_id = ?
      AND e1.edge_type = 'recalls'
      AND e2.edge_type = 'recalls'
      AND e1.source_memory_id <> e2.target_memory_id
    ORDER BY e1.source_memory_id ASC, e2.target_memory_id ASC, e1.target_memory_id ASC
    LIMIT ${COMPRESSION_CHAIN_LIMIT}
  `);

  return {
    findCompressiblePaths: async (workspaceId) => {
      const rows = chainStatement.all(workspaceId) as readonly ChainRow[];
      const grouped = groupChains(rows);
      return grouped.map((entry) => ({
        chain_start: entry.chainStart,
        chain_end: entry.chainEnd,
        intermediate_ids: entry.intermediateIds
      }));
    },
    createCompressionCandidate: async (workspaceId, candidate) => {
      const candidateId = createPendingCandidateProposal(context, {
        workspaceId,
        derivedFrom: buildDerivedKey("compression", `${candidate.chain_start}->${candidate.chain_end}`),
        dossierRef: "librarian.compression",
        droppedCandidates: candidate.intermediate_ids
      });
      return { candidate_id: candidateId };
    }
  };
}

function createSynthesisPort(context: BaseFactoryContext): GardenLibrarianSynthesisThrottlePort {
  const synthesisStatement = context.database.connection.prepare(`
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
  `);

  const hasPendingStatement = context.database.connection.prepare(`
    SELECT 1
    FROM proposals
    WHERE workspace_id = ?
      AND resolution_state = 'pending'
      AND derived_from = ?
    LIMIT 1
  `);

  return {
    findSynthesisCandidateClusters: async (workspaceId) => {
      const rows = synthesisStatement.all(workspaceId, workspaceId) as readonly SynthesisRow[];
      const grouped = groupRows(rows, (row) => row.subject, (row) => row.evidence_id);
      return grouped.map((group) => ({
        subject: group.key,
        evidence_ids: group.objectIds
      }));
    },
    hasPendingSynthesisForSubject: async (workspaceId, subject) => {
      const row = hasPendingStatement.get(workspaceId, buildDerivedKey("synthesis-subject", subject));
      return row !== undefined;
    },
    createSynthesisReviewCandidate: async (workspaceId, subject, evidenceIds) => {
      const candidateId = createPendingCandidateProposal(context, {
        workspaceId,
        derivedFrom: buildDerivedKey("synthesis-subject", subject),
        dossierRef: "librarian.synthesis",
        droppedCandidates: evidenceIds
      });
      return { candidate_id: candidateId };
    }
  };
}

function createPendingCandidateProposal(context: BaseFactoryContext, input: CandidateProposalInput): string {
  const proposalId = context.generateId();
  const runtimeId = context.generateId();
  const optionId = context.generateId();
  const nowIso = context.now();
  const proposalOptions = JSON.stringify([
    {
      option_id: optionId,
      option_kind: ProposalOptionKind.REQUEST_CONFIRMATION,
      preserves_protected_constraints: true,
      dropped_candidates: [...(input.droppedCandidates ?? [])],
      unresolved_after_apply: [...(input.unresolvedAfterApply ?? [])],
      requires_confirmation: true
    }
  ]);

  context.database.connection
    .prepare(
      `INSERT INTO proposals (
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
        run_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      runtimeId,
      ControlPlaneObjectKind.PROPOSAL,
      proposalId,
      null,
      input.derivedFrom,
      RetentionPolicy.RUN_SCOPED,
      input.dossierRef,
      optionId,
      proposalOptions,
      ProposalResolutionState.PENDING,
      null,
      nowIso,
      input.workspaceId,
      null
    );

  return proposalId;
}

function addMilliseconds(isoTimestamp: string, deltaMs: number): string {
  const base = Date.parse(isoTimestamp);
  if (Number.isNaN(base)) {
    return new Date(deltaMs).toISOString();
  }
  return new Date(base + deltaMs).toISOString();
}

function buildDerivedKey(prefix: string, value: string): string {
  return `${prefix}:${value}`;
}

function groupBySubject(rows: readonly SubjectRow[]): readonly {
  readonly subject: string;
  readonly objectIds: readonly string[];
  readonly objectKind: string;
}[] {
  const grouped = new Map<string, { objectIds: string[]; objectKind: string }>();

  for (const row of rows) {
    const existing = grouped.get(row.subject_key);
    if (existing === undefined) {
      grouped.set(row.subject_key, { objectIds: [row.object_id], objectKind: row.object_kind });
      continue;
    }
    existing.objectIds.push(row.object_id);
  }

  return Array.from(grouped, ([subject, value]) => ({
    subject,
    objectIds: value.objectIds,
    objectKind: value.objectKind
  }));
}

function groupRows<Row>(
  rows: readonly Row[],
  keySelector: (row: Row) => string,
  valueSelector: (row: Row) => string
): readonly { readonly key: string; readonly objectIds: readonly string[] }[] {
  const grouped = new Map<string, string[]>();

  for (const row of rows) {
    const key = keySelector(row);
    const value = valueSelector(row);
    const entries = grouped.get(key);
    if (entries === undefined) {
      grouped.set(key, [value]);
      continue;
    }
    if (!entries.includes(value)) {
      entries.push(value);
    }
  }

  return Array.from(grouped, ([key, objectIds]) => ({ key, objectIds }));
}

function groupChains(rows: readonly ChainRow[]): readonly {
  readonly chainStart: string;
  readonly chainEnd: string;
  readonly intermediateIds: readonly string[];
}[] {
  const grouped = new Map<string, string[]>();

  for (const row of rows) {
    const chainKey = `${row.chain_start}|${row.chain_end}`;
    const candidates = grouped.get(chainKey);
    if (candidates === undefined) {
      grouped.set(chainKey, [row.intermediate_id]);
      continue;
    }
    if (!candidates.includes(row.intermediate_id)) {
      candidates.push(row.intermediate_id);
    }
  }

  return Array.from(grouped, ([chainKey, intermediateIds]) => {
    const [chainStart, chainEnd] = chainKey.split("|");
    return {
      chainStart,
      chainEnd,
      intermediateIds
    };
  });
}
