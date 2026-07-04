import {
  GreenGovernanceEventType,
  MemoryGovernanceEventType,
  RevokeReason,
  SoulGreenPiercedPayloadSchema,
  SoulMemoryUpdatedPayloadSchema,
  type EventLogEntry,
  type MemoryEntry
} from "@do-soul/alaya-protocol";
import { StorageError } from "../../shared/errors.js";
import { syncMemoryEntryEvidenceRefIndex } from "../memory-entry/evidence-ref-index.js";
import { parseMemoryEntryRow, type MemoryEntryRow } from "../memory-entry/row-mapper.js";
import { insertEventLogEntry } from "../shared/event-log-writer.js";
import {
  parseAcceptedMemoryUpdateInput,
  shouldRevokeGreenForEvidenceRewrite,
  toUpdatedFieldNames
} from "./acceptance.js";
import type { RevokableGreenStatusRow } from "./rows.js";
import type { SqliteProposalWorkflowContext } from "./accept-workflows.js";

type ParsedAcceptedMemoryUpdate = ReturnType<typeof parseAcceptedMemoryUpdateInput>;

export function loadMemoryForAcceptedUpdate(
  ctx: SqliteProposalWorkflowContext,
  memoryUpdate: ParsedAcceptedMemoryUpdate
): Readonly<MemoryEntry> {
  const existingMemory = loadMemoryById(ctx, memoryUpdate.target_object_id);
  assertMemoryWorkspace(existingMemory, memoryUpdate.target_object_id, memoryUpdate.workspace_id);
  if (existingMemory.lifecycle_state === "archived") {
    throw new StorageError(
      "VALIDATION_FAILED",
      `Memory entry ${memoryUpdate.target_object_id} is archived and cannot be updated.`
    );
  }
  return existingMemory;
}

export function assertBaselineFresh(
  existingMemory: Readonly<MemoryEntry>,
  memoryUpdate: ParsedAcceptedMemoryUpdate
): void {
  if (
    memoryUpdate.expected_baseline_updated_at !== null &&
    existingMemory.updated_at !== memoryUpdate.expected_baseline_updated_at
  ) {
    throw new StorageError(
      "CONFLICT",
      `Memory entry ${memoryUpdate.target_object_id}: proposal was made against a stale snapshot; re-review required.`
    );
  }
}

export function applyAcceptedMemoryUpdate(
  ctx: SqliteProposalWorkflowContext,
  updatedAt: string,
  existingMemory: Readonly<MemoryEntry>,
  memoryUpdate: ParsedAcceptedMemoryUpdate
): Readonly<{
  readonly memory: Readonly<MemoryEntry>;
  readonly events: readonly EventLogEntry[];
}> {
  const memoryEvent = insertMemoryUpdatedEvent(ctx, existingMemory, memoryUpdate);
  const revokableGreenStatus = findGreenRevocationTarget(ctx, existingMemory, memoryUpdate);

  applyMemoryUpdate(ctx, memoryUpdate);
  const greenEvent =
    revokableGreenStatus === undefined
      ? undefined
      : insertAndApplyGreenRevocation(ctx, updatedAt, existingMemory, memoryUpdate, revokableGreenStatus);
  const updatedMemory = loadUpdatedMemory(ctx, memoryUpdate.target_object_id);
  if (memoryUpdate.proposed_changes.evidence_refs !== undefined) {
    syncMemoryEntryEvidenceRefIndex(ctx, updatedMemory);
  }

  return {
    memory: updatedMemory,
    events: greenEvent === undefined ? [memoryEvent] : [memoryEvent, greenEvent]
  };
}

export function assertMemoryExistsInWorkspace(
  ctx: SqliteProposalWorkflowContext,
  memoryId: string,
  workspaceId: string
): void {
  const memory = loadMemoryById(ctx, memoryId);
  assertMemoryWorkspace(memory, memoryId, workspaceId);
}

function insertMemoryUpdatedEvent(
  ctx: SqliteProposalWorkflowContext,
  existingMemory: Readonly<MemoryEntry>,
  memoryUpdate: ParsedAcceptedMemoryUpdate
): EventLogEntry {
  return insertEventLogEntry(ctx.eventLogWriter, {
    event_type: MemoryGovernanceEventType.SOUL_MEMORY_UPDATED,
    entity_type: "memory_entry",
    entity_id: existingMemory.object_id,
    workspace_id: existingMemory.workspace_id,
    run_id: existingMemory.run_id,
    caused_by: memoryUpdate.caused_by,
    payload_json: SoulMemoryUpdatedPayloadSchema.parse({
      object_id: existingMemory.object_id,
      object_kind: existingMemory.object_kind,
      workspace_id: existingMemory.workspace_id,
      run_id: existingMemory.run_id,
      updated_fields: toUpdatedFieldNames(memoryUpdate.proposed_changes)
    })
  });
}

function findGreenRevocationTarget(
  ctx: SqliteProposalWorkflowContext,
  existingMemory: Readonly<MemoryEntry>,
  memoryUpdate: ParsedAcceptedMemoryUpdate
): RevokableGreenStatusRow | undefined {
  const parsedFields = memoryUpdate.proposed_changes;
  if (
    parsedFields.evidence_refs === undefined ||
    !shouldRevokeGreenForEvidenceRewrite(existingMemory.evidence_refs, parsedFields.evidence_refs)
  ) {
    return undefined;
  }

  return ctx.findRevokableGreenStatusStatement.get(
    existingMemory.object_id,
    existingMemory.workspace_id
  ) as RevokableGreenStatusRow | undefined;
}

function applyMemoryUpdate(
  ctx: SqliteProposalWorkflowContext,
  memoryUpdate: ParsedAcceptedMemoryUpdate
): void {
  const parsedFields = memoryUpdate.proposed_changes;
  const memoryResult = ctx.updateMemoryEntryStatement.run(
    parsedFields.content ?? null,
    parsedFields.domain_tags === undefined ? null : JSON.stringify(parsedFields.domain_tags),
    parsedFields.evidence_refs === undefined ? null : JSON.stringify(parsedFields.evidence_refs),
    parsedFields.storage_tier ?? null,
    parsedFields.confidence ?? null,
    parsedFields.retention_state ?? null,
    parsedFields.updated_at,
    memoryUpdate.target_object_id
  );
  if (memoryResult.changes === 0) {
    throw new StorageError(
      "NOT_FOUND",
      `Memory entry ${memoryUpdate.target_object_id} was not found during update.`
    );
  }
}

function insertAndApplyGreenRevocation(
  ctx: SqliteProposalWorkflowContext,
  updatedAt: string,
  existingMemory: Readonly<MemoryEntry>,
  memoryUpdate: ParsedAcceptedMemoryUpdate,
  revokableGreenStatus: RevokableGreenStatusRow
): EventLogEntry {
  const greenEvent = insertGreenPiercedEvent(
    ctx,
    updatedAt,
    existingMemory,
    memoryUpdate,
    revokableGreenStatus
  );
  const greenResult = ctx.revokeGreenStatusStatement.run(
    RevokeReason.MAPPING_REVOKED,
    updatedAt,
    updatedAt,
    revokableGreenStatus.object_id,
    existingMemory.object_id,
    existingMemory.workspace_id
  );
  if (greenResult.changes === 0) {
    throw new StorageError(
      "CONFLICT",
      `Green status ${revokableGreenStatus.object_id} was not revokable during memory update.`
    );
  }
  return greenEvent;
}

function insertGreenPiercedEvent(
  ctx: SqliteProposalWorkflowContext,
  updatedAt: string,
  existingMemory: Readonly<MemoryEntry>,
  memoryUpdate: ParsedAcceptedMemoryUpdate,
  revokableGreenStatus: RevokableGreenStatusRow
): EventLogEntry {
  return insertEventLogEntry(ctx.eventLogWriter, {
    event_type: GreenGovernanceEventType.SOUL_GREEN_PIERCED,
    entity_type: "green_status",
    entity_id: revokableGreenStatus.object_id,
    workspace_id: existingMemory.workspace_id,
    run_id: existingMemory.run_id,
    caused_by: memoryUpdate.caused_by,
    payload_json: SoulGreenPiercedPayloadSchema.parse({
      object_id: revokableGreenStatus.object_id,
      target_object_id: existingMemory.object_id,
      revoke_reason: RevokeReason.MAPPING_REVOKED,
      workspace_id: existingMemory.workspace_id,
      occurred_at: updatedAt
    })
  });
}

function loadMemoryById(
  ctx: SqliteProposalWorkflowContext,
  memoryId: string
): Readonly<MemoryEntry> {
  const memoryRow = ctx.findMemoryEntryByIdStatement.get(memoryId) as MemoryEntryRow | undefined;
  if (memoryRow === undefined) {
    throw new StorageError("NOT_FOUND", `Memory entry ${memoryId} was not found.`);
  }
  return parseMemoryEntryRow(memoryRow);
}

function assertMemoryWorkspace(
  memory: Readonly<MemoryEntry>,
  memoryId: string,
  workspaceId: string
): void {
  if (memory.workspace_id !== workspaceId) {
    throw new StorageError(
      "NOT_FOUND",
      `Memory entry ${memoryId} was not found in workspace ${workspaceId}.`
    );
  }
}

function loadUpdatedMemory(
  ctx: SqliteProposalWorkflowContext,
  memoryId: string
): Readonly<MemoryEntry> {
  const updatedMemoryRow = ctx.findMemoryEntryByIdStatement.get(memoryId) as
    | MemoryEntryRow
    | undefined;
  if (updatedMemoryRow === undefined) {
    throw new StorageError("NOT_FOUND", `Memory entry ${memoryId} was not found after update.`);
  }
  return parseMemoryEntryRow(updatedMemoryRow);
}
