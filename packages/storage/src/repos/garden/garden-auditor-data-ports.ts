import {
  ACTIVE_VERIFICATION_GRACE_MS,
  BOOTSTRAP_CLAIM_THRESHOLD,
  BOOTSTRAP_MEMORY_THRESHOLD,
  POINTER_RESULT_LIMIT,
  STALE_EVIDENCE_LIMIT
} from "./garden-background-port-constants.js";
import type {
  BrokenPointerRecord,
  ExpiringGreenStatus
} from "@do-soul/alaya-protocol";
import type {
  GardenAuditorBootstrappingPort,
  GardenAuditorEvidenceCheckPort,
  GardenAuditorGreenMaintenancePort,
  GardenAuditorPointerHealthPort
} from "./garden-background-port-types.js";
import {
  ACTIVE_STATE,
  addMilliseconds,
  buildDerivedKey,
  createPendingCandidateProposal,
  type GardenDataPortFactoryContext
} from "./garden-data-port-shared.js";
import {
  prepareBootstrappingStatements,
  prepareGreenMaintenanceStatements,
  preparePointerHealthStatements,
  type BootstrappingStatements,
  type GreenMaintenanceStatements
} from "./garden-auditor-statements.js";

interface PatternRow {
  readonly pattern_key: string;
  readonly frequency: number;
}

export function createEvidenceCheckPort(
  context: GardenDataPortFactoryContext
): GardenAuditorEvidenceCheckPort {
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

export function createPointerHealthPort(
  context: GardenDataPortFactoryContext
): GardenAuditorPointerHealthPort {
  const statements = preparePointerHealthStatements(context.database);

  return {
    findBrokenPointers: async (workspaceId) => {
      const rows = [
        ...(statements.memoryEvidenceQuery.all(workspaceId) as readonly BrokenPointerRecord[]),
        ...(statements.synthesisEvidenceQuery.all(workspaceId) as readonly BrokenPointerRecord[]),
        ...(statements.synthesisMemoryQuery.all(workspaceId) as readonly BrokenPointerRecord[]),
        ...(statements.claimEvidenceQuery.all(workspaceId) as readonly BrokenPointerRecord[]),
        ...(statements.claimSourceObjectQuery.all(workspaceId) as readonly BrokenPointerRecord[])
      ];
      return normalizeBrokenPointerRows(rows);
    }
  };
}

function normalizeBrokenPointerRows(
  rows: readonly BrokenPointerRecord[]
): readonly BrokenPointerRecord[] {
  const deduped = Array.from(
    new Map(rows.map((row) => [`${row.source_object_id}|${row.broken_ref}|${row.ref_kind}`, row])).values()
  );

  deduped.sort(compareBrokenPointerRecords);
  return deduped.slice(0, POINTER_RESULT_LIMIT);
}

function compareBrokenPointerRecords(
  left: BrokenPointerRecord,
  right: BrokenPointerRecord
): number {
  return (
    left.source_object_kind.localeCompare(right.source_object_kind) ||
    left.source_object_id.localeCompare(right.source_object_id) ||
    left.broken_ref.localeCompare(right.broken_ref) ||
    left.ref_kind.localeCompare(right.ref_kind)
  );
}

export function createGreenMaintenancePort(
  context: GardenDataPortFactoryContext
): GardenAuditorGreenMaintenancePort {
  const statements = prepareGreenMaintenanceStatements(context.database);

  return {
    findExpiringGreenStatuses: async (workspaceId, lookaheadMs) =>
      findExpiringGreenStatuses(statements, context, workspaceId, lookaheadMs),
    renewGreenPassiveStable: (greenStatusId) => {
      const nowIso = context.now();
      statements.renewPassiveStableStatement.run(nowIso, nowIso, nowIso, greenStatusId);
    },
    requestActiveVerification: (greenStatusId) =>
      requestActiveVerification(statements, context, greenStatusId),
    revokeGreen: (memoryEntryId, reason, _taskId, workspaceId) =>
      revokeGreen(statements, context, memoryEntryId, workspaceId, reason),
    revokeGreenOnEvidenceRewrite: (query) =>
      revokeGreenOnEvidenceRewrite(statements, context, query)
  };
}

function findExpiringGreenStatuses(
  statements: GreenMaintenanceStatements,
  context: GardenDataPortFactoryContext,
  workspaceId: string,
  lookaheadMs: number
): readonly ExpiringGreenStatus[] {
  const cutoffIso = addMilliseconds(context.now(), Math.max(0, lookaheadMs));
  return statements.expiringStatusesStatement.all(
    workspaceId,
    cutoffIso
  ) as readonly ExpiringGreenStatus[];
}

function requestActiveVerification(
  statements: GreenMaintenanceStatements,
  context: GardenDataPortFactoryContext,
  greenStatusId: string
): void {
  const nowIso = context.now();
  const graceUntil = addMilliseconds(nowIso, ACTIVE_VERIFICATION_GRACE_MS);
  statements.requestActiveVerificationStatement.run(
    nowIso,
    nowIso,
    graceUntil,
    nowIso,
    nowIso,
    greenStatusId
  );
}

function revokeGreen(
  statements: GreenMaintenanceStatements,
  context: GardenDataPortFactoryContext,
  memoryEntryId: string,
  workspaceId: string,
  reason: string
): Readonly<{ readonly affected: number }> {
  const nowIso = context.now();
  const result = statements.revokeStatement.run(reason, nowIso, nowIso, memoryEntryId, workspaceId);
  return { affected: result.changes };
}

function revokeGreenOnEvidenceRewrite(
  statements: GreenMaintenanceStatements,
  context: GardenDataPortFactoryContext,
  query: Readonly<{
    readonly memoryEntryId: string;
    readonly workspaceId: string;
    readonly newEvidenceRefs: readonly string[];
  }>
): Readonly<{ readonly affected: number }> {
  const row = statements.readMemoryEvidenceRefsStatement.get(
    query.memoryEntryId,
    query.workspaceId
  ) as { readonly evidence_refs: string } | undefined;
  if (!shouldRevokeGreenForEvidenceRewrite(row, query.newEvidenceRefs)) {
    return { affected: 0 };
  }
  return revokeGreen(statements, context, query.memoryEntryId, query.workspaceId, "mapping_revoked");
}

function shouldRevokeGreenForEvidenceRewrite(
  row: { readonly evidence_refs: string } | undefined,
  newEvidenceRefs: readonly string[]
): boolean {
  if (row === undefined) {
    return false;
  }
  const previousRefs = parseEvidenceRefs(row.evidence_refs);
  if (previousRefs === null) {
    return true;
  }
  if (previousRefs.length === 0) {
    return false;
  }
  const nextSet = new Set(newEvidenceRefs);
  return !previousRefs.some((ref) => nextSet.has(ref));
}

export function createBootstrappingPort(
  context: GardenDataPortFactoryContext
): GardenAuditorBootstrappingPort {
  const statements = prepareBootstrappingStatements(context.database);

  return {
    assessColdStart: async (workspaceId) => assessColdStart(statements, workspaceId),
    generateDraftCandidates: async (workspaceId) =>
      generateDraftCandidates(statements, workspaceId),
    findHighFrequencyPatterns: async (workspaceId, minFrequency) => {
      const rows = statements.patternStatement.all(
        workspaceId,
        workspaceId,
        Math.max(1, minFrequency)
      ) as readonly PatternRow[];
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
      const row = statements.hasPendingStatement.get(
        workspaceId,
        buildDerivedKey("bootstrapping", patternKey)
      );
      return row !== undefined;
    }
  };
}

function assessColdStart(
  statements: BootstrappingStatements,
  workspaceId: string
): Readonly<{ readonly is_cold_start: boolean; readonly memory_count: number; readonly claim_count: number }> {
  const memoryCount = readCount(statements.countMemoriesStatement.get(workspaceId));
  const claimCount = readCount(statements.countClaimsStatement.get(workspaceId));
  return {
    is_cold_start:
      memoryCount < BOOTSTRAP_MEMORY_THRESHOLD && claimCount < BOOTSTRAP_CLAIM_THRESHOLD,
    memory_count: memoryCount,
    claim_count: claimCount
  };
}

function generateDraftCandidates(
  statements: BootstrappingStatements,
  workspaceId: string
): readonly {
  readonly candidate_id: string;
  readonly object_kind: string;
  readonly lifecycle_state: "candidate";
  readonly requires_review: true;
  readonly workspace_id: string;
}[] {
  const rows = statements.draftCandidatesStatement.all(workspaceId, workspaceId) as readonly {
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
}

function readCount(row: unknown): number {
  return (row as { readonly count: number } | undefined)?.count ?? 0;
}

function parseEvidenceRefs(value: string): readonly string[] | null {
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every((ref) => typeof ref === "string")) {
      return parsed;
    }
    emitEvidenceRefsParseWarning("memory evidence_refs is not a string array");
    return null;
  } catch (error) {
    emitEvidenceRefsParseWarning(error instanceof Error ? error.message : String(error));
    return null;
  }
}

function emitEvidenceRefsParseWarning(error: string): void {
  process.emitWarning(
    "[GardenAuditor] failed to parse memory evidence_refs JSON; revoking Green mapping",
    {
      code: "ALAYA_STORAGE_EVIDENCE_REFS_PARSE_FAILURE",
      detail: JSON.stringify({
        layer: "storage",
        error
      })
    }
  );
}
