import { StorageError } from "../../../../shared/errors.js";
import type { StorageDatabase } from "../../../../sqlite/db.js";
import type { FieldEraseBarrierRow } from "../../ports.js";
import { isClaimAvailable } from "../../privacy-availability.js";

export type EraseAuditRedactor = (eventType: string, payload: unknown, barrierId: string) => unknown;

type AuditRow = Readonly<{ event_id: string; entity_id: string; event_type: string; payload_json: string }>;
type SlotRow = Readonly<{
  object_id: string; winner_claim_id: string | null; initial_winner_id: string | null;
  subject_claim_id: string | null; subject_lifecycle: string | null;
  winner_subject: string | null; winner_lifecycle: string | null; winner_status: string | null;
  winner_kind: string | null; winner_scope: string | null; claim_kind: string; scope_class: string;
}>;

/** Called in the erase transaction before its source evidence and derived objects are scrubbed. */
export function scrubGovernancePrivacyClosure(
  database: StorageDatabase, barrier: FieldEraseBarrierRow, evidenceIds: readonly string[],
  sourceObjectIds: readonly string[], redact: EraseAuditRedactor | undefined
): void {
  const ids = findDependentClaims(database, barrier.workspace_id, evidenceIds, sourceObjectIds);
  if (ids.length === 0) return;
  const connection = database.connection;
  const idList = JSON.stringify(ids);
  const audits = connection.prepare(`
    SELECT event_id, entity_id, event_type, payload_json FROM event_log
    WHERE workspace_id = ? AND (
      (entity_type = 'claim_form' AND entity_id IN (SELECT value FROM json_each(?))
        AND event_type IN ('canonicalization.applied', 'canonicalization.alias_resolved'))
      OR (entity_type = 'slot' AND event_type = 'soul.slot.created'
        AND json_extract(payload_json, '$.winner_claim_id') IN (SELECT value FROM json_each(?)))
    ) ORDER BY event_id
  `).all(barrier.workspace_id, idList, idList) as AuditRow[];
  if (audits.length > 0 && redact === undefined) {
    throw new StorageError("VALIDATION_FAILED", "Source erasure audit redaction owner is unavailable");
  }
  const slots = findAffectedSlots(database, barrier.workspace_id, idList);
  const updateAudit = connection.prepare("UPDATE event_log SET payload_json = ? WHERE workspace_id = ? AND event_id = ?");
  for (const event of audits) {
    const payload = redact!(event.event_type, JSON.parse(event.payload_json), barrier.barrier_id);
    updateAudit.run(JSON.stringify(payload), barrier.workspace_id, event.event_id);
    if (event.event_type === "soul.slot.created") {
      connection.prepare(`DELETE FROM privacy_dependency_quarantine WHERE workspace_id = ?
        AND object_kind = 'slot' AND object_id = ? AND NOT EXISTS (
          SELECT 1 FROM slots WHERE workspace_id = ? AND object_id = ?
        )`).run(barrier.workspace_id, event.entity_id, barrier.workspace_id, event.entity_id);
    }
  }
  repairSlots(database, barrier, slots, new Set(ids));
  connection.prepare(`DELETE FROM conflict_matrix_edges WHERE workspace_id = ? AND (
    source_claim_id IN (SELECT value FROM json_each(?)) OR target_claim_id IN (SELECT value FROM json_each(?))
  )`).run(barrier.workspace_id, idList, idList);
  connection.prepare(`UPDATE claim_forms SET lifecycle_state = 'tombstone', claim_status = 'archived',
    proposition_digest = 'erased', governance_subject = ?, updated_at = ?
    WHERE workspace_id = ? AND object_id IN (SELECT value FROM json_each(?))`)
    .run(JSON.stringify({ subject_domain: "erased", subject_qualifiers: {}, canonical_key: "erased" }),
      barrier.erased_at, barrier.workspace_id, idList);
}

function findDependentClaims(database: StorageDatabase, workspaceId: string, evidenceIds: readonly string[],
  sourceObjectIds: readonly string[]): string[] {
  if (evidenceIds.length === 0 && sourceObjectIds.length === 0) return [];
  const evidenceSeed = JSON.stringify(evidenceIds);
  const sourceSeed = JSON.stringify(sourceObjectIds);
  const rows = database.connection.prepare(`
    WITH RECURSIVE affected(object_id) AS (
      SELECT claim.object_id FROM claim_forms claim WHERE claim.workspace_id = ? AND (
        EXISTS (SELECT 1 FROM json_each(claim.evidence_refs) ref JOIN json_each(?) seed ON seed.value = ref.value)
        OR EXISTS (SELECT 1 FROM json_each(claim.source_object_refs) ref JOIN json_each(?) seed ON seed.value = ref.value)
      )
      UNION
      SELECT claim.object_id FROM claim_forms claim JOIN json_each(claim.source_object_refs) ref
        JOIN affected parent ON parent.object_id = ref.value WHERE claim.workspace_id = ?
    ) SELECT object_id FROM affected ORDER BY object_id
  `).all(workspaceId, evidenceSeed, sourceSeed, workspaceId) as { object_id: string }[];
  return rows.map(row => row.object_id);
}

function findAffectedSlots(database: StorageDatabase, workspaceId: string, claims: string): SlotRow[] {
  return database.connection.prepare(`
    SELECT slot.object_id, slot.winner_claim_id, slot.subject_claim_id, slot.claim_kind, slot.scope_class,
      json_extract(created.payload_json, '$.winner_claim_id') AS initial_winner_id,
      winner.governance_subject AS winner_subject, winner.lifecycle_state AS winner_lifecycle,
      winner.claim_status AS winner_status, winner.claim_kind AS winner_kind, winner.scope_class AS winner_scope,
      origin.lifecycle_state AS subject_lifecycle
    FROM slots slot LEFT JOIN event_log created ON created.workspace_id = slot.workspace_id
      AND created.entity_type = 'slot' AND created.entity_id = slot.object_id AND created.event_type = 'soul.slot.created'
    LEFT JOIN claim_forms winner ON winner.workspace_id = slot.workspace_id AND winner.object_id = slot.winner_claim_id
    LEFT JOIN claim_forms origin ON origin.workspace_id = slot.workspace_id AND origin.object_id = slot.subject_claim_id
    WHERE slot.workspace_id = ? AND (slot.winner_claim_id IN (SELECT value FROM json_each(?))
      OR slot.subject_claim_id IN (SELECT value FROM json_each(?))
      OR json_extract(created.payload_json, '$.winner_claim_id') IN (SELECT value FROM json_each(?)))
    ORDER BY slot.object_id
  `).all(workspaceId, claims, claims, claims) as SlotRow[];
}

function repairSlots(database: StorageDatabase, barrier: FieldEraseBarrierRow, slots: SlotRow[], claims: Set<string>): void {
  const remove = database.connection.prepare("DELETE FROM slots WHERE workspace_id = ? AND object_id = ?");
  const clear = database.connection.prepare(`UPDATE slots SET winner_claim_id = NULL, incumbent_since = NULL,
    updated_at = ? WHERE workspace_id = ? AND object_id = ?`);
  const rebuild = database.connection.prepare(`UPDATE slots SET governance_subject = ?, subject_claim_id = ?, updated_at = ?
    WHERE workspace_id = ? AND object_id = ?`);
  const release = database.connection.prepare(`DELETE FROM privacy_dependency_quarantine
    WHERE workspace_id = ? AND object_kind = 'slot' AND object_id = ?`);
  const quarantine = database.connection.prepare(`INSERT OR IGNORE INTO privacy_dependency_quarantine
    (workspace_id, object_kind, object_id) VALUES (?, 'slot', ?)`);
  const seen = new Set<string>();
  for (const slot of slots) {
    if (seen.has(slot.object_id)) {
      throw new StorageError("VALIDATION_FAILED", "Slot creation provenance is ambiguous during source erasure");
    }
    seen.add(slot.object_id);
    const subjectErased = slot.subject_claim_id !== null && claims.has(slot.subject_claim_id);
    const initialErased = slot.initial_winner_id !== null && claims.has(slot.initial_winner_id);
    const winnerErased = slot.winner_claim_id !== null && claims.has(slot.winner_claim_id);
    if (!subjectErased && winnerErased) {
      const independentlySupported = slot.subject_claim_id !== null && slot.subject_lifecycle === "active"
        && isClaimAvailable(database, barrier.workspace_id, slot.subject_claim_id);
      release.run(barrier.workspace_id, slot.object_id);
      clear.run(barrier.erased_at, barrier.workspace_id, slot.object_id);
      if (!independentlySupported) quarantine.run(barrier.workspace_id, slot.object_id);
    } else if (subjectErased && !winnerErased && slot.winner_subject !== null
      && slot.winner_lifecycle === "active" && (slot.winner_status === "active" || slot.winner_status === "winner")
      && slot.winner_kind === slot.claim_kind && slot.winner_scope === slot.scope_class
      && slot.winner_claim_id !== null && isClaimAvailable(database, barrier.workspace_id, slot.winner_claim_id)) {
      release.run(barrier.workspace_id, slot.object_id);
      rebuild.run(slot.winner_subject, slot.winner_claim_id, barrier.erased_at, barrier.workspace_id, slot.object_id);
    } else if (subjectErased) {
      remove.run(barrier.workspace_id, slot.object_id);
      release.run(barrier.workspace_id, slot.object_id);
    } else if (initialErased && slot.subject_claim_id === null) {
      quarantine.run(barrier.workspace_id, slot.object_id);
    }
  }
}
