import { CanonicalizationAliasResolvedPayloadSchema, CanonicalizationAppliedPayloadSchema,
  SoulSlotCreatedPayloadSchema, type EventLogEntry } from "@do-soul/alaya-protocol";
import type { SqliteConnection, StorageDatabase } from "../../sqlite/db.js";
import { StorageError } from "../../shared/errors.js";

type PrivacyObjectKind = "memory_entry" | "memory_hq_observation" | "memory_hq_projection" | "synthesis_capsule" | "claim_form" | "slot" | "conflict_matrix_edge";

/** Unknown dependency provenance is not an erase receipt or evidence of absence. */
function isPrivacyObjectAvailable(
  database: StorageDatabase, workspaceId: string, kind: PrivacyObjectKind, objectId: string
): boolean {
  return database.connection.prepare(`SELECT 1 FROM privacy_current_quarantine
    WHERE workspace_id = ? AND object_kind = ? AND object_id = ? LIMIT 1`)
    .get(workspaceId, kind, objectId) === undefined;
}

export function isClaimAvailable(database: StorageDatabase, workspaceId: string, claimId: string): boolean {
  return isPrivacyObjectAvailable(database, workspaceId, "claim_form", claimId);
}

export function requirePrivacyObjectAvailable(
  database: StorageDatabase, workspaceId: string, kind: PrivacyObjectKind, objectId: string
): void {
  if (!isPrivacyObjectAvailable(database, workspaceId, kind, objectId)) {
    throw new StorageError("CONFLICT", "Object is unavailable because a dependency has unknown provenance.");
  }
}

export function requirePrivacyRowsAvailable(
  database: StorageDatabase, kind: PrivacyObjectKind,
  rows: readonly Readonly<{ workspace_id: string; object_id: string }>[]
): void {
  for (const row of rows) requirePrivacyObjectAvailable(database, row.workspace_id, kind, row.object_id);
}

export function requirePrivacyWorkspaceAvailable(
  database: StorageDatabase, workspaceId: string, kinds: readonly PrivacyObjectKind[]
): void {
  if (database.connection.prepare(`SELECT 1 FROM privacy_current_quarantine
    WHERE workspace_id = ? AND object_kind IN (SELECT value FROM json_each(?)) LIMIT 1`)
    .get(workspaceId, JSON.stringify(kinds)) !== undefined) {
    throw new StorageError("CONFLICT", "Results are incomplete because dependency provenance is unavailable.");
  }
}

export function requirePrivacyKindAvailable(database: StorageDatabase, kind: PrivacyObjectKind): void {
  if (database.connection.prepare(`SELECT 1 FROM privacy_current_quarantine WHERE object_kind = ? LIMIT 1`)
    .get(kind) !== undefined) {
    throw new StorageError("CONFLICT", "Results are incomplete because dependency provenance is unavailable.");
  }
}

export function requirePrivacyRunMemoriesAvailable(database: StorageDatabase, runId: string): void {
  if (database.connection.prepare(`SELECT 1 FROM memory_entries m JOIN privacy_current_quarantine q
    ON q.workspace_id = m.workspace_id AND q.object_kind = 'memory_entry' AND q.object_id = m.object_id
    WHERE m.run_id = ? LIMIT 1`).get(runId) !== undefined) {
    throw new StorageError("CONFLICT", "Results are incomplete because dependency provenance is unavailable.");
  }
}

/** Only event payloads that copy a quarantined subject are withheld. */
export function requirePrivacyEventsAvailable(database: StorageDatabase, events: readonly EventLogEntry[]): void {
  for (const event of events) {
    if (event.entity_type === "claim_form" &&
        (event.event_type === "canonicalization.applied" || event.event_type === "canonicalization.alias_resolved")) {
      const parsed = event.event_type === "canonicalization.applied"
        ? CanonicalizationAppliedPayloadSchema.safeParse(event.payload_json)
        : CanonicalizationAliasResolvedPayloadSchema.safeParse(event.payload_json);
      const redacted = parsed.success && "redaction" in parsed.data && parsed.data.redaction.kind === "source_erase";
      if (!redacted) requireNoQuarantineRecord(database.connection, event.workspace_id, "claim_form", event.entity_id);
    } else if (event.entity_type === "slot" && event.event_type === "soul.slot.created") {
      const parsed = SoulSlotCreatedPayloadSchema.safeParse(event.payload_json);
      const redacted = parsed.success && "redaction" in parsed.data && parsed.data.redaction.kind === "source_erase";
      if (!redacted) requireNoQuarantineRecord(database.connection, event.workspace_id, "slot", event.entity_id);
    }
  }
}

export function requireNoQuarantineRecord(connection: SqliteConnection, workspaceId: string, kind: PrivacyObjectKind, objectId: string): void {
  if (connection.prepare(`SELECT 1 FROM privacy_dependency_quarantine
    WHERE workspace_id = ? AND object_kind = ? AND object_id = ? LIMIT 1`).get(workspaceId, kind, objectId) !== undefined) {
    throw new StorageError("CONFLICT", "Payload is unavailable because its dependency provenance is unknown.");
  }
}

export function hasQuarantinedSemanticArtifact(connection: SqliteConnection, workspaceId: string, key: string): boolean {
  return connection.prepare(`SELECT 1 FROM privacy_dependency_quarantine q
    WHERE q.workspace_id = ? AND q.object_kind = 'memory_entry' AND (
      EXISTS (SELECT 1 FROM garden_semantic_bindings b WHERE b.workspace_id = q.workspace_id
        AND b.object_id = q.object_id AND b.artifact_key = ?)
      OR EXISTS (SELECT 1 FROM garden_semantic_work_claims c JOIN garden_tasks t
        ON t.workspace_id = c.workspace_id AND t.id = c.task_id
        WHERE c.workspace_id = q.workspace_id AND c.artifact_key = ?
          AND CASE WHEN json_valid(t.payload_json) THEN json_extract(t.payload_json, '$.source_object_id') END = q.object_id)
    ) LIMIT 1`).get(workspaceId, key, key) !== undefined;
}
