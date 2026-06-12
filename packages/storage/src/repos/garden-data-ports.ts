import { randomUUID } from "node:crypto";
import {
  DYNAMICS_CONSTANTS,
  type BrokenPointerRecord,
  type ColdStartAssessment,
  type DraftCandidate,
  type ExpiringGreenStatus,
  type HighFrequencyPattern,
  type StaleMemoryEntry
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../sqlite/db.js";
import {
  ACTIVE_STATE,
  addMilliseconds,
  buildDerivedKey,
  createPendingCandidateProposal,
  type GardenDataPortFactoryContext
} from "./garden-data-port-shared.js";
import {
  createCompressionPort,
  createMergePort,
  createNeighborPort,
  createSynthesisPort
} from "./garden-librarian-data-ports.js";

const STALE_EVIDENCE_LIMIT = 120;
const POINTER_QUERY_LIMIT = 120;
const POINTER_RESULT_LIMIT = 240;
const EXPIRING_GREEN_LIMIT = 120;
const DRAFT_CANDIDATE_LIMIT = 120;
const PATTERN_LIMIT = 120;
const HOT_DEMOTION_LIMIT = 120;
const ACTIVE_VERIFICATION_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

const BOOTSTRAP_MEMORY_THRESHOLD = 10;
const BOOTSTRAP_CLAIM_THRESHOLD = 5;

const BOUNDARY_COLD_TIER = "cold";

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
  // gate-6-delta I4: sync so the Janitor wraps it in
  // EventPublisher.appendManyWithMutation alongside the
  // SOUL_MEMORY_TIER_CHANGED event row.
  demoteToWarm(workspaceId: string, memoryEntryIds: readonly string[]): void;
}

export interface GardenLowActivityMemoryRecord {
  readonly memory_id: string;
}

// invariant: dormancy is REVERSIBLE. setLifecycleDormant only flips
// lifecycle_state active -> dormant; it never tombstones or deletes. A fresh
// reuse_gain revives the row (DynamicsService.processKarmaEvent dormant ->
// active). The demotion criterion mirrors the path-side dormancy posture: a
// memory whose decayed activation has fallen at/below the silent band
// (manifestation_thresholds.hint_max = 0.3) AND that has been idle long
// enough drops out of recall but stays restorable.
// see also: packages/soul/src/garden/janitor.ts executeDormantDemotion.
// invariant: setLifecycleDormant resolves "skipped" (not a throw) when the row
// is not active anymore (guarded UPDATE matched 0 rows), so the Janitor sweep
// continues past a benign race and counts only actually-demoted rows. The
// production wiring overrides this port with an audited core transition (the raw
// UPDATE here is unaudited); this storage port stays guard-consistent.
export type GardenDormantDemotionOutcome = "demoted" | "skipped";

export interface GardenJanitorDormantDemotionPort {
  findLowActivityActiveMemories(workspaceId: string): Promise<readonly GardenLowActivityMemoryRecord[]>;
  setLifecycleDormant(memoryId: string, taskId: string): Promise<GardenDormantDemotionOutcome>;
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
  // invariant: sync to allow Auditor to wrap each call inside an
  // EventPublisher.appendManyWithMutation transaction along with the
  // corresponding SOUL_GREEN_* EventLog row.
  renewGreenPassiveStable(greenStatusId: string, taskId: string): void;
  requestActiveVerification(greenStatusId: string, taskId: string): void;
  // invariant: workspaceId is required and the UPDATE filters revokable
  // states only, so revokes against missing or already-revoked rows return
  // affected = 0. The Auditor MUST treat affected = 0 as a no-op (no
  // SOUL_GREEN_REVOKED EventLog row, log a green_revoke_noop health entry
  // instead).
  revokeGreen(
    memoryEntryId: string,
    reason: "verification_fail",
    taskId: string,
    workspaceId: string
  ): { readonly affected: number };
  // invariant: writes revoke_reason='mapping_revoked' when the supplied
  // newEvidenceRefs share zero overlap with the memory row's stored
  // evidence_refs. see also: green-status.ts RevokeReason.MAPPING_REVOKED.
  revokeGreenOnEvidenceRewrite(input: {
    readonly memoryEntryId: string;
    readonly workspaceId: string;
    readonly newEvidenceRefs: readonly string[];
  }): { readonly affected: number };
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
  readonly dormantDemotionPort: GardenJanitorDormantDemotionPort;
  readonly evidenceCheckPort: GardenAuditorEvidenceCheckPort;
  readonly pointerHealthPort: GardenAuditorPointerHealthPort;
  readonly greenMaintenancePort: GardenAuditorGreenMaintenancePort;
  readonly bootstrappingPort: GardenAuditorBootstrappingPort;
  readonly mergePort: GardenLibrarianMergeDetectionPort;
  readonly neighborPort: GardenLibrarianNeighborDetectionPort;
  readonly compressionPort: GardenLibrarianPathCompressionPort;
  readonly synthesisPort: GardenLibrarianSynthesisThrottlePort;
}


interface PatternRow {
  readonly pattern_key: string;
  readonly frequency: number;
}

type BaseFactoryContext = GardenDataPortFactoryContext;

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
    dormantDemotionPort: createDormantDemotionPort(context),
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
    // gate-6-delta I4: sync so the Janitor can call this inside
     // EventPublisher.appendManyWithMutation alongside the
     // SOUL_MEMORY_TIER_CHANGED event rows.
    demoteToWarm: (workspaceId, memoryEntryIds) => {
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

function createDormantDemotionPort(context: BaseFactoryContext): GardenJanitorDormantDemotionPort {
  // invariant: dormancy criterion is REVERSIBLE silencing, never deletion —
  // active+hot memory whose decayed activation is at/below the silent band AND
  // idle past the inactivity window. Both bounds reuse existing
  // DYNAMICS_CONSTANTS (no new tuning constants):
  //   - manifestation_thresholds.hint_max: at/below this activation the memory
  //     already manifests only as hint/hidden, so demotion changes recall
  //     eligibility, not delivered visibility.
  //   - path_plasticity.retirement_inactivity_ms: same idle window the path
  //     plane uses before demoting a path to dormant.
  // COALESCE(last_hit_at, last_used_at, created_at): last_used_at is the
  // "last reinforced" proxy; created_at floors a never-hit memory at birth age.
  const SILENT_ACTIVATION_BAND = DYNAMICS_CONSTANTS.manifestation_thresholds.hint_max;
  const IDLE_WINDOW_MS = DYNAMICS_CONSTANTS.path_plasticity.retirement_inactivity_ms;
  const DORMANT_DEMOTION_LIMIT = 120;

  const findLowActivityStatement = context.database.connection.prepare(`
    SELECT object_id AS memory_id
    FROM memory_entries
    WHERE workspace_id = ?
      AND lifecycle_state = '${ACTIVE_STATE}'
      AND storage_tier = 'hot'
      AND COALESCE(activation_score, 0.0) <= ?
      AND COALESCE(last_hit_at, last_used_at, created_at) <= ?
    ORDER BY COALESCE(activation_score, 0.0) ASC,
             COALESCE(last_hit_at, last_used_at, created_at) ASC,
             object_id ASC
    LIMIT ${DORMANT_DEMOTION_LIMIT}
  `);

  // invariant: active -> dormant ONLY. No retention_state / tombstone write.
  // The WHERE lifecycle_state guard keeps the flip idempotent and refuses to
  // touch a row another transition already moved.
  const setDormantStatement = context.database.connection.prepare(`
    UPDATE memory_entries
    SET lifecycle_state = 'dormant', updated_at = ?
    WHERE object_id = ?
      AND lifecycle_state = '${ACTIVE_STATE}'
  `);

  return {
    findLowActivityActiveMemories: async (workspaceId) => {
      const idleBefore = addMilliseconds(context.now(), -Math.max(0, IDLE_WINDOW_MS));
      return findLowActivityStatement.all(
        workspaceId,
        SILENT_ACTIVATION_BAND,
        idleBefore
      ) as readonly GardenLowActivityMemoryRecord[];
    },
    setLifecycleDormant: async (memoryId) => {
      const result = setDormantStatement.run(context.now(), memoryId);
      return result.changes === 0 ? "skipped" : "demoted";
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
      AND workspace_id = ?
      AND green_state IN ('eligible', 'grace')
  `);

  const readMemoryEvidenceRefsStatement = context.database.connection.prepare(`
    SELECT evidence_refs
    FROM memory_entries
    WHERE object_id = ? AND workspace_id = ?
    LIMIT 1
  `);

  return {
    findExpiringGreenStatuses: async (workspaceId, lookaheadMs) => {
      const cutoffIso = addMilliseconds(context.now(), Math.max(0, lookaheadMs));
      return expiringStatusesStatement.all(workspaceId, cutoffIso) as readonly ExpiringGreenStatus[];
    },
    renewGreenPassiveStable: (greenStatusId) => {
      const nowIso = context.now();
      renewPassiveStableStatement.run(nowIso, nowIso, nowIso, greenStatusId);
    },
    requestActiveVerification: (greenStatusId) => {
      const nowIso = context.now();
      const graceUntil = addMilliseconds(nowIso, ACTIVE_VERIFICATION_GRACE_MS);
      requestActiveVerificationStatement.run(nowIso, nowIso, graceUntil, nowIso, nowIso, greenStatusId);
    },
    revokeGreen: (memoryEntryId, reason, _taskId, workspaceId) => {
      const nowIso = context.now();
      const result = revokeStatement.run(reason, nowIso, nowIso, memoryEntryId, workspaceId);
      return { affected: result.changes };
    },
    revokeGreenOnEvidenceRewrite: ({ memoryEntryId, workspaceId, newEvidenceRefs }) => {
      const row = readMemoryEvidenceRefsStatement.get(memoryEntryId, workspaceId) as
        | { readonly evidence_refs: string }
        | undefined;
      if (row === undefined) {
        return { affected: 0 };
      }
      let previousRefs: readonly string[];
      try {
        const parsed = JSON.parse(row.evidence_refs);
        previousRefs = Array.isArray(parsed) ? (parsed as readonly string[]) : [];
      } catch {
        previousRefs = [];
      }
      if (previousRefs.length === 0) {
        return { affected: 0 };
      }
      const nextSet = new Set(newEvidenceRefs);
      const stillOverlaps = previousRefs.some((ref) => nextSet.has(ref));
      if (stillOverlaps) {
        return { affected: 0 };
      }
      const nowIso = context.now();
      const result = revokeStatement.run(
        "mapping_revoked",
        nowIso,
        nowIso,
        memoryEntryId,
        workspaceId
      );
      return { affected: result.changes };
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
