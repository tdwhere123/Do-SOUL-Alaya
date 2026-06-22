import {
  MemoryGovernanceEventType,
  SoulMemoryStateChangedPayloadSchema,
  type EventLogEntry,
  type MemoryEntry,
  type TransitionCausedBy
} from "@do-soul/alaya-protocol";
import { CoreError } from "../../shared/errors.js";
import { classifyMemoryImportance, isMemoryExplicitlyProtected } from "../../manifestation/importance-gate.js";
import { parseObjectId } from "../../shared/validators.js";
import type {
  MemoryEntryLifecyclePort,
  MemoryEntryReadPort,
  MemoryRuntimeNotifier,
  MemoryServiceEventLogRepoPort,
  MemoryServiceSynthesisCapsuleLookupPort
} from "./types.js";
import { isRepoGuardRefusal, parseReason, parseTransitionCausedBy } from "./validators.js";
import { appendAuditEventSynchronously } from "./memory-audit-append.js";

export interface MemoryAutonomousForgetDependencies {
  readonly memoryEntryRepo: MemoryEntryReadPort & MemoryEntryLifecyclePort;
  readonly eventLogRepo: MemoryServiceEventLogRepoPort;
  readonly runtimeNotifier: MemoryRuntimeNotifier;
  readonly synthesisCapsuleLookup?: MemoryServiceSynthesisCapsuleLookupPort;
  readonly now: () => string;
}

// invariant: autonomous forget terminalizes only dormant/tombstoned rows under a
// verified disposition; every refusal leaves the row recoverable (fail-closed).
export class MemoryAutonomousForget {
  private readonly memoryEntryRepo: MemoryEntryReadPort & MemoryEntryLifecyclePort;
  private readonly eventLogRepo: MemoryServiceEventLogRepoPort;
  private readonly runtimeNotifier: MemoryRuntimeNotifier;
  private readonly synthesisCapsuleLookup?: MemoryServiceSynthesisCapsuleLookupPort;
  private readonly now: () => string;

  public constructor(dependencies: MemoryAutonomousForgetDependencies) {
    this.memoryEntryRepo = dependencies.memoryEntryRepo;
    this.eventLogRepo = dependencies.eventLogRepo;
    this.runtimeNotifier = dependencies.runtimeNotifier;
    this.synthesisCapsuleLookup = dependencies.synthesisCapsuleLookup;
    this.now = dependencies.now;
  }

  // invariant: autonomous tombstone requires a verified forget_disposition and
  // only terminalizes dormant, unprotected rows through the guarded repo port.
  public async autonomousTombstone(
    objectId: string,
    disposition: NonNullable<MemoryEntry["forget_disposition"]>,
    dispositionRef: string | null,
    reason: string,
    causedBy: TransitionCausedBy
  ): Promise<Readonly<MemoryEntry>> {
    const parsedObjectId = parseObjectId(objectId);
    const parsedReason = parseReason(reason);
    const parsedCausedBy = parseTransitionCausedBy(causedBy);

    if (disposition === "compressed" && (dispositionRef === null || dispositionRef.trim().length === 0)) {
      throw new CoreError("VALIDATION", "compressed disposition requires a live synthesis-capsule ref");
    }
    if (disposition === "judged_useless" && dispositionRef !== null) {
      throw new CoreError("VALIDATION", "judged_useless disposition must not carry a disposition ref");
    }

    const existing = await this.memoryEntryRepo.findById(parsedObjectId);
    if (existing === null) {
      throw new CoreError("NOT_FOUND", "Memory entry not found");
    }
    if (existing.lifecycle_state !== "dormant") {
      throw new CoreError("VALIDATION", "Only a dormant memory may be autonomously tombstoned");
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

    const autonomousTombstone = this.memoryEntryRepo.autonomousTombstone;
    if (autonomousTombstone === undefined) {
      throw new CoreError("CONFLICT", "Autonomous tombstone port is not available", {
        subCode: "PORT_UNAVAILABLE"
      });
    }

    const occurredAt = this.now();
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
            event = appendAuditEventSynchronously(this.eventLogRepo, eventInput);
          }
        }
      );
    } catch (error) {
      const benignRace = await this.classifyAutonomousTombstoneRepoRefusal(parsedObjectId, error);
      if (benignRace !== null) {
        throw benignRace;
      }
      throw error;
    }
    if (event === undefined) {
      throw new CoreError("CONFLICT", "Autonomous tombstone transaction did not append its audit event.");
    }
    await this.runtimeNotifier.notifyEntry(event);
    return updated;
  }

  private async classifyAutonomousTombstoneRepoRefusal(
    objectId: string,
    error: unknown
  ): Promise<CoreError | null> {
    if (!isRepoGuardRefusal(error)) {
      return null;
    }

    const current = await this.memoryEntryRepo.findById(objectId);
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

  // invariant: autonomous physical delete removes only disposition-marked
  // tombstones; false means fail-closed and the row stays recoverable.
  public async autonomousHardDeleteTombstoned(
    objectId: string,
    reason: string,
    causedBy: TransitionCausedBy
  ): Promise<boolean> {
    const parsedObjectId = parseObjectId(objectId);
    const parsedReason = parseReason(reason);
    const parsedCausedBy = parseTransitionCausedBy(causedBy);
    const existing = await this.memoryEntryRepo.findById(parsedObjectId);

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
      const preserved = await this.compressedPreservationStillValid(existing);
      if (!preserved) {
        await this.emitPreservationRevoked(existing, parsedReason, parsedCausedBy);
        return false;
      }
    }

    const hardDeleteWithDisposition = this.memoryEntryRepo.hardDeleteTombstonedWithDisposition;
    if (hardDeleteWithDisposition === undefined) {
      throw new CoreError("CONFLICT", "Disposition-gated tombstone delete port is not available", {
        subCode: "PORT_UNAVAILABLE"
      });
    }

    // invariant: compressed DELETE runs before the deleted audit and returns
    // false when capsule preservation is revoked by a race.
    if (isCompressed) {
      // invariant: onDeleted appends the to_state=deleted audit inside the
      // guarded DELETE transaction.
      const deleteEventInput = this.buildAutonomousDeleteEventInput(existing, parsedReason, parsedCausedBy);
      let deletedEvent: EventLogEntry | undefined;
      const deleted = await hardDeleteWithDisposition(parsedObjectId, {
        requireLiveCapsuleRef: true,
        onDeleted: () => {
          deletedEvent = appendAuditEventSynchronously(this.eventLogRepo, deleteEventInput);
        }
      });
      if (!deleted) {
        await this.emitPreservationRevoked(existing, parsedReason, parsedCausedBy);
        return false;
      }
      if (deletedEvent === undefined) {
        throw new CoreError("CONFLICT", "Compressed tombstone delete transaction did not append its audit event.");
      }
      await this.runtimeNotifier.notifyEntry(deletedEvent);
      return true;
    }

    // invariant: judged_useless deletes re-check the importance verdict at
    // delete time and fail closed if evidence/reinforcement/protection changed.
    // see also: packages/core/src/manifestation/importance-gate.ts:classifyMemoryImportance.
    if (classifyMemoryImportance(existing).disposition !== "judged_useless") {
      await this.emitVerdictRevoked(existing, parsedReason, parsedCausedBy);
      return false;
    }

    const deleteEventInput = this.buildAutonomousDeleteEventInput(existing, parsedReason, parsedCausedBy);
    let deletedEvent: EventLogEntry | undefined;
    const deleted = await hardDeleteWithDisposition(parsedObjectId, {
      requireJudgedUselessVerdict: true,
      onDeleted: () => {
        deletedEvent = appendAuditEventSynchronously(this.eventLogRepo, deleteEventInput);
      }
    });
    if (!deleted) {
      await this.emitVerdictRevoked(existing, parsedReason, parsedCausedBy);
      return false;
    }
    if (deletedEvent === undefined) {
      throw new CoreError("CONFLICT", "Judged-useless tombstone delete transaction did not append its audit event.");
    }
    await this.runtimeNotifier.notifyEntry(deletedEvent);
    return true;
  }

  // invariant: deleted audits carry disposition + caller rationale in reason_code.
  private buildAutonomousDeleteEventInput(
    existing: Readonly<MemoryEntry>,
    parsedReason: string,
    parsedCausedBy: TransitionCausedBy
  ): Omit<EventLogEntry, "event_id" | "created_at" | "revision"> {
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
        occurred_at: this.now()
      })
    };
  }

  // invariant: preservation_revoked leaves compressed rows tombstoned and
  // recoverable when capsule preservation no longer holds.
  private async emitPreservationRevoked(
    existing: Readonly<MemoryEntry>,
    parsedReason: string,
    parsedCausedBy: TransitionCausedBy
  ): Promise<void> {
    const skipEvent = await this.eventLogRepo.append({
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
          existing.forget_disposition_ref === null || existing.forget_disposition_ref === undefined
            ? null
            : [existing.forget_disposition_ref],
        occurred_at: this.now()
      })
    });
    await this.runtimeNotifier.notifyEntry(skipEvent);
  }

  // invariant: verdict_revoked leaves judged_useless rows tombstoned and
  // recoverable when the delete-time importance verdict no longer holds.
  private async emitVerdictRevoked(
    existing: Readonly<MemoryEntry>,
    parsedReason: string,
    parsedCausedBy: TransitionCausedBy
  ): Promise<void> {
    const skipEvent = await this.eventLogRepo.append({
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
        occurred_at: this.now()
      })
    });
    await this.runtimeNotifier.notifyEntry(skipEvent);
  }

  // invariant: compressed physical delete requires a live preserving capsule at
  // delete time; missing or stale preservation returns false.
  private async compressedPreservationStillValid(existing: Readonly<MemoryEntry>): Promise<boolean> {
    const ref = existing.forget_disposition_ref;
    if (ref === null || ref === undefined) {
      return false;
    }
    const capsuleLookup = this.synthesisCapsuleLookup;
    if (capsuleLookup === undefined) {
      return false;
    }
    const capsule = await capsuleLookup.findById(ref);
    if (capsule === null) {
      return false;
    }
    const isLive = capsule.lifecycle_state !== "tombstone" && capsule.synthesis_status !== "archived";
    if (!isLive) {
      return false;
    }
    return capsule.source_memory_refs.includes(existing.object_id);
  }
}
