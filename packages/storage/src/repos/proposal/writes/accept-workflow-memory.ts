import {
  RevokeReason,
  type EventLogEntry,
  type MemoryEntry
} from "@do-soul/alaya-protocol";
import { StorageError } from "../../../shared/errors.js";
import { syncMemoryEntryEvidenceRefIndex } from "../../memory-entry/writes/evidence-ref-index.js";
import { parseMemoryEntryRow, type MemoryEntryRow } from "../../memory-entry/mappers/row-mapper.js";
import { insertEventLogEntry } from "../../runtime/writes/event-log-writer.js";
import {
  parseAcceptedMemoryUpdateInput,
  shouldRevokeGreenForEvidenceRewrite
} from "../mappers/acceptance.js";
import type { RevokableGreenStatusRow } from "../mappers/rows.js";
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
  const revokableGreenStatus = findGreenRevocationTarget(ctx, existingMemory, memoryUpdate);
  const events = [insertEventLogEntry(ctx.eventLogWriter, memoryUpdate.buildMemoryEvent(existingMemory))];

  applyMemoryUpdate(ctx, memoryUpdate);
  if (revokableGreenStatus !== undefined) {
    events.push(insertEventLogEntry(ctx.eventLogWriter,
      memoryUpdate.buildGreenRevocationEvent(existingMemory, revokableGreenStatus.object_id)));
    applyGreenRevocation(ctx, updatedAt, existingMemory, revokableGreenStatus);
  }
  const updatedMemory = loadUpdatedMemory(ctx, memoryUpdate.target_object_id);
  if (memoryUpdate.proposed_changes.evidence_refs !== undefined) {
    syncMemoryEntryEvidenceRefIndex(ctx, updatedMemory);
  }

  return { memory: updatedMemory, events };
}

export function assertMemoryExistsInWorkspace(
  ctx: SqliteProposalWorkflowContext,
  memoryId: string,
  workspaceId: string
): void {
  const memory = loadMemoryById(ctx, memoryId);
  assertMemoryWorkspace(memory, memoryId, workspaceId);
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

function applyGreenRevocation(
  ctx: SqliteProposalWorkflowContext,
  updatedAt: string,
  existingMemory: Readonly<MemoryEntry>,
  revokableGreenStatus: RevokableGreenStatusRow
): void {
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
