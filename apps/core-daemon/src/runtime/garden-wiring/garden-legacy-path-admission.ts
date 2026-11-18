import { createHash } from "node:crypto";
import {
  EventAnchorSchema,
  RelationFormationSourceKind,
  canonicalJson,
  compareUtcInstants,
  getPathAnchorBackingObjectId
} from "@do-soul/alaya-protocol";
import type {
  PathCandidateSink,
  RelationAssertionAdmissionRequest,
  RelationAssertionService
} from "@do-soul/alaya-core";
import type { StorageDatabase } from "@do-soul/alaya-storage";
import type { EdgeProposalReconcilePort } from "../../garden/runtime/runtime-types.js";

type Warn = (message: string, meta: Record<string, unknown>) => void;

type WorkspaceListPort = Readonly<{
  list(): Promise<readonly Readonly<{ readonly workspace_id: string; readonly workspace_state?: string }>[]>
}>;

type GroundedEventRow = Readonly<{
  readonly event_id: string;
  readonly event_type: string;
  readonly entity_type: string;
  readonly entity_id: string;
  readonly workspace_id: string;
  readonly run_id: string | null;
  readonly caused_by: string | null;
  readonly revision: number;
  readonly payload_json: string;
  readonly created_at: string;
}>;

type VerifiedAnchorEvidence = Readonly<{
  readonly objectId: string;
  readonly validFrom: string | null;
  readonly receipts: readonly Readonly<{
    readonly evidence_id: string;
    readonly source_event_anchor: Readonly<{
      readonly event_type: string;
      readonly event_id: string;
      readonly occurred_at: string;
    }>;
  }>[];
  readonly events: readonly GroundedEventRow[];
}>;

const PROVENANCE_OPERATOR_ID = "garden_provenance_relation_v1";
const PROVENANCE_OPERATOR_SHA256 = sha256Hex(PROVENANCE_OPERATOR_ID);

export function createGardenLegacyPathCandidateRejectionPort(warn: Warn): PathCandidateSink {
  const sink: PathCandidateSink = {
    submitCandidate: async (candidateInput) => {
      warn("garden legacy path candidate rejected without temporal assertion evidence", {
        workspace_id: candidateInput.workspaceId,
        relation_kind: candidateInput.relationKind
      });
      return "rejected";
    }
  };
  return Object.freeze(sink);
}

/**
 * Verifies both anchors resolve to active, non-tombstoned, un-quarantined memories
 * backed by anchored Evidence capsules or non-erased source records, then admits the
 * relation through RelationAssertionService. Ungrounded candidates remain rejected.
 */
export function createProvenanceVerifiedPathCandidatePort(input: Readonly<{
  readonly database: StorageDatabase;
  readonly assertionService: Pick<RelationAssertionService, "admit">;
  readonly warn: Warn;
}>): PathCandidateSink {
  const sink: PathCandidateSink = {
    submitCandidate: async (candidateInput) => {
      const request = buildVerifiedCandidateRequest(input.database.connection, candidateInput);
      if (request === null) {
        input.warn("garden legacy path candidate rejected without temporal assertion evidence", {
          workspace_id: candidateInput.workspaceId,
          relation_kind: candidateInput.relationKind
        });
        return "rejected";
      }
      try {
        const outcome = await input.assertionService.admit(request);
        return outcome.status === "admitted" ? "applied" : "already_present";
      } catch (error) {
        input.warn("garden legacy path candidate rejected without temporal assertion evidence", {
          workspace_id: candidateInput.workspaceId,
          relation_kind: candidateInput.relationKind,
          error: error instanceof Error ? error.message : String(error)
        });
        return "rejected";
      }
    }
  };
  return Object.freeze(sink);
}

function buildVerifiedCandidateRequest(
  connection: StorageDatabase["connection"],
  candidateInput: Parameters<PathCandidateSink["submitCandidate"]>[0]
): RelationAssertionAdmissionRequest | null {
  const sourceObjectId = getPathAnchorBackingObjectId(candidateInput.sourceAnchor);
  const targetObjectId = getPathAnchorBackingObjectId(candidateInput.targetAnchor);
  if (sourceObjectId.length === 0 || targetObjectId.length === 0) return null;
  const sourceAnchorEvidence = verifyMemoryAnchorEvidence(connection, candidateInput.workspaceId, sourceObjectId);
  const targetAnchorEvidence = verifyMemoryAnchorEvidence(connection, candidateInput.workspaceId, targetObjectId);
  if (sourceAnchorEvidence === null || targetAnchorEvidence === null) return null;
  const receipts = deduplicateCandidateReceipts([...sourceAnchorEvidence.receipts, ...targetAnchorEvidence.receipts]);
  const observations = deduplicateCandidateObservations([...sourceAnchorEvidence.events, ...targetAnchorEvidence.events]);
  if (receipts.length === 0 || observations.length === 0) return null;
  const validFrom = resolveCandidateValidFrom([sourceAnchorEvidence, targetAnchorEvidence], receipts);
  if (validFrom === null) return null;
  const parameters = {
    relation_kind: candidateInput.relationKind,
    governance_class: candidateInput.governanceClass,
    initial_strength: candidateInput.initialStrength,
    recall_bias_sign: candidateInput.recallBiasSign
  };
  const decision = {
    relation_kind: candidateInput.relationKind,
    source_anchor: candidateInput.sourceAnchor,
    target_anchor: candidateInput.targetAnchor
  };
  return {
    workspaceId: candidateInput.workspaceId,
    runId: candidateInput.runId ?? null,
    causedBy: "garden_provenance_admission",
    evidenceReceipts: receipts,
    formationReceipt: {
      operator_id: PROVENANCE_OPERATOR_ID,
      operator_sha256: PROVENANCE_OPERATOR_SHA256,
      parameters,
      parameter_sha256: sha256Hex(canonicalJson(parameters)),
      source_observations: observations,
      decision,
      decision_sha256: sha256Hex(canonicalJson(decision))
    },
    anchors: { source_anchor: candidateInput.sourceAnchor, target_anchor: candidateInput.targetAnchor },
    relationKind: candidateInput.relationKind,
    validity: { kind: "open", valid_from: validFrom }
  };
}

function verifyMemoryAnchorEvidence(
  connection: StorageDatabase["connection"],
  workspaceId: string,
  objectId: string
): VerifiedAnchorEvidence | null {
  const memory = connection.prepare(`
    SELECT object_id, evidence_refs, valid_from
    FROM memory_entries
    WHERE workspace_id = ?
      AND object_id = ?
      AND lifecycle_state = 'active'
      AND NOT EXISTS (
        SELECT 1 FROM privacy_current_quarantine q
        WHERE q.workspace_id = memory_entries.workspace_id
          AND q.object_kind = 'memory_entry'
          AND q.object_id = memory_entries.object_id
      )
    LIMIT 1
  `).get(workspaceId, objectId) as
    | { readonly object_id: string; readonly evidence_refs: string; readonly valid_from: string | null }
    | undefined;
  if (memory === undefined) return null;
  const receipts: Array<VerifiedAnchorEvidence["receipts"][number]> = [];
  const events: GroundedEventRow[] = [];
  collectCapsuleReceipts(connection, workspaceId, memory.evidence_refs, receipts, events);
  collectStatementSourceReceipts(connection, workspaceId, objectId, receipts, events);
  if (receipts.length === 0) return null;
  return { objectId, validFrom: memory.valid_from, receipts, events };
}

function collectCapsuleReceipts(
  connection: StorageDatabase["connection"],
  workspaceId: string,
  evidenceRefsJson: string,
  receipts: Array<VerifiedAnchorEvidence["receipts"][number]>,
  events: GroundedEventRow[]
): void {
  const capsuleRows = connection.prepare(`
    SELECT ec.object_id, ec.event_anchor
    FROM json_each(?) AS ref
    JOIN evidence_capsules ec
      ON ec.object_id = ref.value
     AND ec.workspace_id = ?
     AND ec.lifecycle_state = 'active'
     AND ec.event_anchor IS NOT NULL
  `).all(evidenceRefsJson, workspaceId) as Array<{ readonly object_id: string; readonly event_anchor: string }>;
  const findEvent = connection.prepare(`
    SELECT event_id, event_type, entity_type, entity_id, workspace_id, run_id,
           caused_by, revision, payload_json, created_at
    FROM event_log
    WHERE workspace_id = ? AND event_type = ? AND event_id = ?
    LIMIT 1
  `);
  for (const row of capsuleRows) {
    const parsed = EventAnchorSchema.safeParse(JSON.parse(row.event_anchor));
    if (!parsed.success || parsed.data.event_id === null) continue;
    const ev = findEvent.get(workspaceId, parsed.data.event_type, parsed.data.event_id) as GroundedEventRow | undefined;
    if (ev === undefined) continue;
    receipts.push({
      evidence_id: row.object_id,
      source_event_anchor: {
        event_type: parsed.data.event_type,
        event_id: parsed.data.event_id,
        occurred_at: parsed.data.occurred_at
      }
    });
    events.push(ev);
  }
}

function collectStatementSourceReceipts(
  connection: StorageDatabase["connection"],
  workspaceId: string,
  memoryId: string,
  receipts: Array<VerifiedAnchorEvidence["receipts"][number]>,
  events: GroundedEventRow[]
): void {
  const rows = connection.prepare(`
    SELECT sr.record_id,
           COALESCE(sr.event_time, sr.recorded_at) AS occurred_at,
           el.event_id, el.event_type, el.entity_type, el.entity_id,
           el.workspace_id, el.run_id, el.caused_by, el.revision, el.payload_json, el.created_at
    FROM source_statement_memory_bindings ssmb
    JOIN source_statement_artifacts ssa
      ON ssa.workspace_id = ssmb.workspace_id
     AND ssa.artifact_id = ssmb.artifact_id
    JOIN source_records sr
      ON sr.workspace_id = ssa.workspace_id
     AND sr.record_id = ssa.record_id
    JOIN evidence_capsules ec
      ON ec.object_id = ssa.artifact_id
     AND ec.workspace_id = ssa.workspace_id
     AND ec.lifecycle_state = 'active'
    JOIN event_log el
      ON el.workspace_id = sr.workspace_id
     AND el.event_type = 'soul.field.source_record.admitted'
     AND el.entity_type = 'source_record'
     AND el.entity_id = sr.record_id
    WHERE ssmb.workspace_id = ?
      AND ssmb.memory_id = ?
      AND NOT EXISTS (
        SELECT 1 FROM projection_erase_barriers b
        WHERE b.workspace_id = sr.workspace_id
          AND b.subject_kind = 'source_record'
          AND b.subject_id = sr.record_id
      )
  `).all(workspaceId, memoryId) as Array<GroundedEventRow & { readonly record_id: string; readonly occurred_at: string }>;
  for (const row of rows) {
    receipts.push({
      evidence_id: row.record_id,
      source_event_anchor: {
        event_type: row.event_type,
        event_id: row.event_id,
        occurred_at: row.occurred_at
      }
    });
    events.push(row);
  }
}

function deduplicateCandidateReceipts(list: readonly VerifiedAnchorEvidence["receipts"][number][]) {
  const byId = new Map<string, VerifiedAnchorEvidence["receipts"][number]>();
  for (const item of list) byId.set(item.evidence_id, item);
  return [...byId.values()].sort((a, b) => a.evidence_id.localeCompare(b.evidence_id));
}

function deduplicateCandidateObservations(events: readonly GroundedEventRow[]) {
  const byId = new Map<string, GroundedEventRow>();
  for (const event of events) byId.set(event.event_id, event);
  return [...byId.values()]
    .sort((a, b) => a.event_id.localeCompare(b.event_id))
    .map((event) => ({
      source_kind: RelationFormationSourceKind.EVENT_LOG_ENTRY,
      source_id: event.event_id,
      source_sha256: sha256Hex(canonicalJson({
        event_id: event.event_id,
        event_type: event.event_type,
        entity_type: event.entity_type,
        entity_id: event.entity_id,
        workspace_id: event.workspace_id,
        run_id: event.run_id,
        caused_by: event.caused_by,
        revision: event.revision,
        payload_json: JSON.parse(event.payload_json),
        created_at: event.created_at
      }))
    }));
}

function resolveCandidateValidFrom(
  anchors: readonly VerifiedAnchorEvidence[],
  receipts: readonly VerifiedAnchorEvidence["receipts"][number][]
): string | null {
  const candidates: string[] = [];
  for (const anchor of anchors) {
    if (anchor.validFrom !== null) candidates.push(anchor.validFrom);
  }
  for (const receipt of receipts) candidates.push(receipt.source_event_anchor.occurred_at);
  let latest: string | null = null;
  for (const candidate of candidates) {
    const valid = compareUtcInstants(candidate, candidate);
    if (valid === undefined) continue;
    if (latest === null || compareUtcInstants(candidate, latest) === 1) latest = candidate;
  }
  return latest;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// invariant: accepted legacy proposals carry neither assertion evidence nor a
// source EventLog anchor. Garden must defer their recovery until a temporal
// remapping path can establish both, never replay the legacy mint.
export function createGardenEdgeProposalReconcileDeferralPort(
  edgeProposalService: Pick<EdgeProposalReconcilePort, "sweepExpired">,
  warn: Warn
): EdgeProposalReconcilePort {
  const port: EdgeProposalReconcilePort = {
    reconcileStuckAccepts: async (input) => {
      warn("garden edge proposal accept-to-mint reconciliation deferred without temporal assertion provenance", {
        workspace_id: input.workspaceId,
        limit: input.limit
      });
      return Object.freeze({
        scanned: 0,
        reminted: 0,
        already_present: 0,
        rejected: 0,
        transient_failed: 0
      });
    },
    sweepExpired: async (input) => await edgeProposalService.sweepExpired(input)
  };
  return Object.freeze(port);
}

// invariant: bootstrap edges lack assertion evidence and a source EventLog
// anchor, so temporal clean-break leaves them deferred at daemon startup.
export async function deferGardenBootstrapPathReconciliation(
  workspaceRepo: WorkspaceListPort,
  warn: Warn
): Promise<void> {
  let workspaces: readonly Readonly<{ readonly workspace_id: string; readonly workspace_state?: string }>[];
  try {
    workspaces = await workspaceRepo.list();
  } catch (error) {
    warn("garden bootstrap path reconciliation deferral enumeration failed", {
      error: error instanceof Error ? error.message : String(error)
    });
    return;
  }
  for (const workspace of workspaces) {
    if (workspace.workspace_state === "active" || workspace.workspace_state === undefined) {
      warn("garden bootstrap path reconciliation deferred without temporal assertion provenance", {
        workspace_id: workspace.workspace_id
      });
    }
  }
}
