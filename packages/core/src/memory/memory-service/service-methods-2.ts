import { randomUUID } from "node:crypto";

import {
  MemoryDimension,
  MemoryGovernanceEventType,
  RevokeReason,
  SoulMemoryArchivedPayloadSchema,
  SoulMemoryCreatedPayloadSchema,
  SoulMemoryStateChangedPayloadSchema,
  SoulMemoryUpdatedPayloadSchema,
  StorageTier,
  type EventLogEntry,
  type FactualPolicyCondition,
  type MemoryEntry,
  type ScopeClass,
  type TransitionCausedBy
} from "@do-soul/alaya-protocol";

import { CoreError } from "../../shared/errors.js";

import { classifyMemoryImportance, isMemoryExplicitlyProtected } from "../../manifestation/importance-gate.js";

import { scheduleAuditedAsyncSideEffect } from "../../runtime/async-side-effect-auditor.js";

import { parseNonEmptyString, parseObjectId } from "../../shared/validators.js";

import type {
  MemoryEntryInput,
  MemoryEntryRepoUpdateFields,
  MemoryEntryUpdateFields,
  MemoryListPageOptions,
  MemoryServiceDependencies
} from "./types.js";

import {
  ensureAllowedLifecycleTransition,
  isPromiseLike,
  isRepoGuardRefusal,
  parseFactualPolicyCondition,
  parseLifecycleState,
  parseMemoryEntry,
  parseReason,
  parseStorageTier,
  parseTransitionCausedBy,
  parseUpdateFields,
  shouldRevokeGreenForEvidenceRewrite,
  toUpdatedFieldNames
} from "./validators.js";
type MemoryServiceMethodOwner = {
  generateObjectId: () => string;
  now: () => string;
  dependencies: MemoryServiceDependencies;
  [key: string]: any;
};


const MEMORY_SERVICE_SCAN_PAGE_LIMIT = 500;

async function collectMemoryPages(
  readPage: (page: MemoryListPageOptions) => Promise<readonly Readonly<MemoryEntry>[]>
): Promise<readonly Readonly<MemoryEntry>[]> {
  const rows: Readonly<MemoryEntry>[] = [];
  for (let offset = 0; ; offset += MEMORY_SERVICE_SCAN_PAGE_LIMIT) {
    const pageRows = await readPage({
      limit: MEMORY_SERVICE_SCAN_PAGE_LIMIT,
      offset
    });
    rows.push(...pageRows);
    if (pageRows.length < MEMORY_SERVICE_SCAN_PAGE_LIMIT) {
      break;
    }
  }
  return Object.freeze(rows);
}

export async function memoryServiceAutonomousTombstone(owner: MemoryServiceMethodOwner, objectId: string, disposition: NonNullable<MemoryEntry["forget_disposition"]>, dispositionRef: string | null, reason: string, causedBy: TransitionCausedBy): Promise<Readonly<MemoryEntry>> {
    const parsedObjectId = parseObjectId(objectId);
    const parsedReason = parseReason(reason);
    const parsedCausedBy = parseTransitionCausedBy(causedBy);

    if (disposition === "compressed" && (dispositionRef === null || dispositionRef.trim().length === 0)) {
      throw new CoreError("VALIDATION", "compressed disposition requires a live synthesis-capsule ref");
    }
    if (disposition === "judged_useless" && dispositionRef !== null) {
      throw new CoreError("VALIDATION", "judged_useless disposition must not carry a disposition ref");
    }

    const existing = await owner.dependencies.memoryEntryRepo.findById(parsedObjectId);
    if (existing === null) {
      throw new CoreError("NOT_FOUND", "Memory entry not found");
    }
    if (existing.lifecycle_state !== "dormant") {
      throw new CoreError(
        "VALIDATION",
        "Only a dormant memory may be autonomously tombstoned"
      );
    }

    // invariant: explicitly-protected rows remain recoverable even when a
    // caller bypasses computeForgetDisposition.
    // see also: packages/core/src/manifestation/importance-gate.ts:isMemoryExplicitlyProtected.
    if (isMemoryExplicitlyProtected(existing)) {
      throw new CoreError(
        "VALIDATION",
        "Autonomous tombstone refused: memory is explicitly protected (pinned/hazard/canon/consolidated)"
      );
    }

    const autonomousTombstone = owner.dependencies.memoryEntryRepo.autonomousTombstone;
    if (autonomousTombstone === undefined) {
      throw new CoreError("CONFLICT", "Autonomous tombstone port is not available");
    }

    const occurredAt = owner.now();
    const eventInput: Omit<EventLogEntry, "event_id" | "created_at" | "revision"> = {
      event_type: MemoryGovernanceEventType.SOUL_MEMORY_STATE_CHANGED,
      entity_type: "memory_entry",
      entity_id: existing.object_id,
      workspace_id: existing.workspace_id,
      run_id: existing.run_id,
      caused_by: parsedCausedBy,
      payload_json: SoulMemoryStateChangedPayloadSchema.parse({
        object_id: existing.object_id,
        object_kind: existing.object_kind,
        workspace_id: existing.workspace_id,
        run_id: existing.run_id,
        from_state: existing.lifecycle_state,
        to_state: "tombstone",
        reason_code: `forget_disposition=${disposition}: ${parsedReason}`,
        caused_by: parsedCausedBy,
        evidence_refs: dispositionRef === null ? null : [dispositionRef],
        occurred_at: occurredAt
      })
    };
    let event: EventLogEntry | undefined;

    let updated: Readonly<MemoryEntry>;
    try {
      updated = await autonomousTombstone(
        {
          objectId: parsedObjectId,
          disposition,
          dispositionRef,
          updatedAt: occurredAt
        },
        {
          onTransition: () => {
            event = owner.appendAuditEventSynchronously(eventInput);
          }
        }
      );
    } catch (error) {
      const benignRace = await owner.classifyAutonomousTombstoneRepoRefusal(parsedObjectId, error);
      if (benignRace !== null) {
        throw benignRace;
      }
      throw error;
    }
    if (event === undefined) {
      throw new CoreError("CONFLICT", "Autonomous tombstone transaction did not append its audit event.");
    }
    await owner.dependencies.runtimeNotifier.notifyEntry(event);
    return updated;
  }

export async function memoryServiceClassifyAutonomousTombstoneRepoRefusal(owner: MemoryServiceMethodOwner, objectId: string, error: unknown): Promise<CoreError | null> {
    if (!isRepoGuardRefusal(error)) {
      return null;
    }

    const current = await owner.dependencies.memoryEntryRepo.findById(objectId);
    if (current === null || current.lifecycle_state !== "dormant") {
      return new CoreError(
        "VALIDATION",
        "Only a dormant memory may be autonomously tombstoned",
        { cause: error }
      );
    }
    if (isMemoryExplicitlyProtected(current)) {
      return new CoreError(
        "VALIDATION",
        "Autonomous tombstone refused: memory is explicitly protected (pinned/hazard/canon/consolidated)",
        { cause: error }
      );
    }
    return null;
  }

export async function memoryServiceAutonomousHardDeleteTombstoned(owner: MemoryServiceMethodOwner, objectId: string, reason: string, causedBy: TransitionCausedBy): Promise<boolean> {
    const parsedObjectId = parseObjectId(objectId);
    const parsedReason = parseReason(reason);
    const parsedCausedBy = parseTransitionCausedBy(causedBy);
    const existing = await owner.dependencies.memoryEntryRepo.findById(parsedObjectId);

    if (existing === null) {
      throw new CoreError("NOT_FOUND", "Memory entry not found");
    }
    if (existing.retention_state !== "tombstoned") {
      throw new CoreError("VALIDATION", "Only tombstoned memories can be hard-deleted");
    }
    if (existing.forget_disposition === null || existing.forget_disposition === undefined) {
      throw new CoreError(
        "VALIDATION",
        "Autonomous hard-delete refused: tombstoned row carries no forget disposition"
      );
    }

    const isCompressed = existing.forget_disposition === "compressed";

    // invariant: compressed deletes re-verify live capsule preservation both
    // before and inside the guarded DELETE.
    // see also: apps/core-daemon/src/forget-disposition-ports.ts:isCapsuleLive.
    if (isCompressed) {
      const preserved = await owner.compressedPreservationStillValid(existing);
      if (!preserved) {
        await owner.emitPreservationRevoked(existing, parsedReason, parsedCausedBy);
        return false;
      }
    }

    const hardDeleteWithDisposition = owner.dependencies.memoryEntryRepo.hardDeleteTombstonedWithDisposition;
    if (hardDeleteWithDisposition === undefined) {
      throw new CoreError("CONFLICT", "Disposition-gated tombstone delete port is not available");
    }

    // invariant: compressed DELETE runs before the deleted audit and returns
    // false when capsule preservation is revoked by a race.
    if (isCompressed) {
      // invariant: onDeleted appends the to_state=deleted audit inside the
      // guarded DELETE transaction.
      const deleteEventInput = owner.buildAutonomousDeleteEventInput(existing, parsedReason, parsedCausedBy);
      let deletedEvent: EventLogEntry | undefined;
      const deleted = await hardDeleteWithDisposition(parsedObjectId, {
        requireLiveCapsuleRef: true,
        onDeleted: () => {
          deletedEvent = owner.appendAuditEventSynchronously(deleteEventInput);
        }
      });
      if (!deleted) {
        await owner.emitPreservationRevoked(existing, parsedReason, parsedCausedBy);
        return false;
      }
      if (deletedEvent === undefined) {
        throw new CoreError("CONFLICT", "Compressed tombstone delete transaction did not append its audit event.");
      }
      await owner.dependencies.runtimeNotifier.notifyEntry(deletedEvent);
      return true;
    }

    // invariant: judged_useless deletes re-check the importance verdict at
    // delete time and fail closed if evidence/reinforcement/protection changed.
    // see also: packages/core/src/manifestation/importance-gate.ts:classifyMemoryImportance.
    if (classifyMemoryImportance(existing).disposition !== "judged_useless") {
      await owner.emitVerdictRevoked(existing, parsedReason, parsedCausedBy);
      return false;
    }

    const deleteEventInput = owner.buildAutonomousDeleteEventInput(existing, parsedReason, parsedCausedBy);
    let deletedEvent: EventLogEntry | undefined;
    const deleted = await hardDeleteWithDisposition(parsedObjectId, {
      requireJudgedUselessVerdict: true,
      onDeleted: () => {
        deletedEvent = owner.appendAuditEventSynchronously(deleteEventInput);
      }
    });
    if (!deleted) {
      await owner.emitVerdictRevoked(existing, parsedReason, parsedCausedBy);
      return false;
    }
    if (deletedEvent === undefined) {
      throw new CoreError("CONFLICT", "Judged-useless tombstone delete transaction did not append its audit event.");
    }
    await owner.dependencies.runtimeNotifier.notifyEntry(deletedEvent);
    return true;
  }

export function memoryServiceBuildAutonomousDeleteEventInput(owner: MemoryServiceMethodOwner, existing: Readonly<MemoryEntry>, parsedReason: string, parsedCausedBy: TransitionCausedBy): Omit<EventLogEntry, "event_id" | "created_at" | "revision"> {
    return {
      event_type: MemoryGovernanceEventType.SOUL_MEMORY_STATE_CHANGED,
      entity_type: "memory_entry",
      entity_id: existing.object_id,
      workspace_id: existing.workspace_id,
      run_id: existing.run_id,
      caused_by: parsedCausedBy,
      payload_json: SoulMemoryStateChangedPayloadSchema.parse({
        object_id: existing.object_id,
        object_kind: existing.object_kind,
        workspace_id: existing.workspace_id,
        run_id: existing.run_id,
        from_state: existing.lifecycle_state,
        to_state: "deleted",
        reason_code: `forget_disposition=${existing.forget_disposition}: ${parsedReason}`,
        caused_by: parsedCausedBy,
        evidence_refs: null,
        occurred_at: owner.now()
      })
    };
  }

export function memoryServiceAppendAuditEventSynchronously(owner: MemoryServiceMethodOwner, eventInput: Omit<EventLogEntry, "event_id" | "created_at" | "revision">): EventLogEntry {
    const event = owner.dependencies.eventLogRepo.append(eventInput);
    if (isPromiseLike(event)) {
      throw new CoreError(
        "CONFLICT",
        "Autonomous audit-inside-transaction requires a synchronous EventLog append port."
      );
    }
    return event;
  }

export async function memoryServiceEmitPreservationRevoked(owner: MemoryServiceMethodOwner, existing: Readonly<MemoryEntry>, parsedReason: string, parsedCausedBy: TransitionCausedBy): Promise<void> {
    const skipEvent = await owner.dependencies.eventLogRepo.append({
      event_type: MemoryGovernanceEventType.SOUL_MEMORY_STATE_CHANGED,
      entity_type: "memory_entry",
      entity_id: existing.object_id,
      workspace_id: existing.workspace_id,
      run_id: existing.run_id,
      caused_by: parsedCausedBy,
      payload_json: SoulMemoryStateChangedPayloadSchema.parse({
        object_id: existing.object_id,
        object_kind: existing.object_kind,
        workspace_id: existing.workspace_id,
        run_id: existing.run_id,
        // invariant: preservation_revoked records tombstone -> tombstone, not delete.
        from_state: existing.lifecycle_state,
        to_state: existing.lifecycle_state,
        reason_code: `preservation_revoked: compressed capsule ${
          existing.forget_disposition_ref ?? "<null>"
        } no longer preserves this member; physical delete refused: ${parsedReason}`,
        caused_by: parsedCausedBy,
        evidence_refs:
          existing.forget_disposition_ref === null ||
          existing.forget_disposition_ref === undefined
            ? null
            : [existing.forget_disposition_ref],
        occurred_at: owner.now()
      })
    });
    await owner.dependencies.runtimeNotifier.notifyEntry(skipEvent);
  }

export async function memoryServiceEmitVerdictRevoked(owner: MemoryServiceMethodOwner, existing: Readonly<MemoryEntry>, parsedReason: string, parsedCausedBy: TransitionCausedBy): Promise<void> {
    const skipEvent = await owner.dependencies.eventLogRepo.append({
      event_type: MemoryGovernanceEventType.SOUL_MEMORY_STATE_CHANGED,
      entity_type: "memory_entry",
      entity_id: existing.object_id,
      workspace_id: existing.workspace_id,
      run_id: existing.run_id,
      caused_by: parsedCausedBy,
      payload_json: SoulMemoryStateChangedPayloadSchema.parse({
        object_id: existing.object_id,
        object_kind: existing.object_kind,
        workspace_id: existing.workspace_id,
        run_id: existing.run_id,
        // invariant: verdict_revoked records tombstone -> tombstone, not delete.
        from_state: existing.lifecycle_state,
        to_state: existing.lifecycle_state,
        reason_code: `verdict_revoked: judged_useless no longer holds (gained evidence/reinforcement/protection); physical delete refused: ${parsedReason}`,
        caused_by: parsedCausedBy,
        evidence_refs: existing.evidence_refs.length === 0 ? null : [...existing.evidence_refs],
        occurred_at: owner.now()
      })
    });
    await owner.dependencies.runtimeNotifier.notifyEntry(skipEvent);
  }

export async function memoryServiceCompressedPreservationStillValid(owner: MemoryServiceMethodOwner, existing: Readonly<MemoryEntry>): Promise<boolean> {
    const ref = existing.forget_disposition_ref;
    if (ref === null || ref === undefined) {
      return false;
    }
    const capsuleLookup = owner.dependencies.synthesisCapsuleLookup;
    if (capsuleLookup === undefined) {
      return false;
    }
    const capsule = await capsuleLookup.findById(ref);
    if (capsule === null) {
      return false;
    }
    const isLive =
      capsule.lifecycle_state !== "tombstone" && capsule.synthesis_status !== "archived";
    if (!isLive) {
      return false;
    }
    return capsule.source_memory_refs.includes(existing.object_id);
  }

export function memoryServiceFindById(owner: MemoryServiceMethodOwner, objectId: string): Promise<Readonly<MemoryEntry> | null> {
    return owner.dependencies.memoryEntryRepo.findById(objectId);
  }

export async function memoryServiceFindByIdScoped(owner: MemoryServiceMethodOwner, objectId: string, workspaceId: string): Promise<Readonly<MemoryEntry> | null> {
    const entry = await owner.dependencies.memoryEntryRepo.findById(objectId);
    if (entry === null || entry.workspace_id !== workspaceId) {
      return null;
    }
    return entry;
  }

export async function memoryServiceFindByIdsScoped(owner: MemoryServiceMethodOwner, objectIds: readonly string[], workspaceId: string): Promise<readonly Readonly<MemoryEntry>[]> {
    const findByIds = owner.dependencies.memoryEntryRepo.findByIds;
    if (findByIds === undefined) {
      const entries = await Promise.all(
        objectIds.map(async (objectId) => await owner.findByIdScoped(objectId, workspaceId))
      );
      return entries.filter((entry): entry is Readonly<MemoryEntry> => entry !== null);
    }

    const entries = await findByIds.call(owner.dependencies.memoryEntryRepo, objectIds);
    return entries.filter((entry) => entry.workspace_id === workspaceId);
  }

export function memoryServiceFindByWorkspaceId(owner: MemoryServiceMethodOwner, workspaceId: string, page?: MemoryListPageOptions): Promise<readonly Readonly<MemoryEntry>[]> {
    return owner.dependencies.memoryEntryRepo.findByWorkspaceId(workspaceId, undefined, page);
  }

export async function memoryServiceFindByWorkspaceIdAll(owner: MemoryServiceMethodOwner, workspaceId: string): Promise<readonly Readonly<MemoryEntry>[]> {
    const findByWorkspaceIdAll = owner.dependencies.memoryEntryRepo.findByWorkspaceIdAll;
    if (findByWorkspaceIdAll !== undefined) {
      return await findByWorkspaceIdAll.call(owner.dependencies.memoryEntryRepo, workspaceId);
    }

    return await collectMemoryPages((page) =>
      owner.dependencies.memoryEntryRepo.findByWorkspaceId(workspaceId, undefined, page)
    );
  }

export async function memoryServiceCountByWorkspaceId(owner: MemoryServiceMethodOwner, workspaceId: string): Promise<number> {
    const countByWorkspaceId = owner.dependencies.memoryEntryRepo.countByWorkspaceId;
    if (countByWorkspaceId !== undefined) {
      return await countByWorkspaceId.call(owner.dependencies.memoryEntryRepo, workspaceId);
    }
    return (await owner.findByWorkspaceIdAll(workspaceId)).length;
  }

export function memoryServiceFindByRunId(owner: MemoryServiceMethodOwner, runId: string, page?: MemoryListPageOptions): Promise<readonly Readonly<MemoryEntry>[]> {
    return owner.dependencies.memoryEntryRepo.findByRunId(runId, page);
  }

export async function memoryServiceFindByRunIdAll(owner: MemoryServiceMethodOwner, runId: string): Promise<readonly Readonly<MemoryEntry>[]> {
    const findByRunIdAll = owner.dependencies.memoryEntryRepo.findByRunIdAll;
    if (findByRunIdAll !== undefined) {
      return await findByRunIdAll.call(owner.dependencies.memoryEntryRepo, runId);
    }

    return await collectMemoryPages((page) =>
      owner.dependencies.memoryEntryRepo.findByRunId(runId, page)
    );
  }

export async function memoryServiceCountByRunId(owner: MemoryServiceMethodOwner, runId: string): Promise<number> {
    const countByRunId = owner.dependencies.memoryEntryRepo.countByRunId;
    if (countByRunId !== undefined) {
      return await countByRunId.call(owner.dependencies.memoryEntryRepo, runId);
    }
    return (await owner.findByRunIdAll(runId)).length;
  }

export function memoryServiceFindByDimension(owner: MemoryServiceMethodOwner, workspaceId: string, dimension: MemoryEntry["dimension"], page?: MemoryListPageOptions): Promise<readonly Readonly<MemoryEntry>[]> {
    return owner.dependencies.memoryEntryRepo.findByDimension(workspaceId, dimension, page);
  }
