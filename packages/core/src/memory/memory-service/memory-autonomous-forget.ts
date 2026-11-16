import {
  MemoryGovernanceEventType,
  SoulMemoryStateChangedPayloadSchema,
  createHistoricalMemoryCapture,
  canonicalJson,
  type HistoricalMemoryCapture,
  type AutonomousTombstoneArguments,
  type EventLogEntry,
  type MemoryEntry,
  type TransitionCausedBy
} from "@do-soul/alaya-protocol";
import { CoreError } from "../../shared/errors.js";
import { fieldContractSha256 } from "../../shared/field-hash.js";
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
    const preservation = disposition === "compressed"
      ? await this.capturePreservation(existing, dispositionRef!, occurredAt) : undefined;
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
        occurred_at: occurredAt,
        ...(preservation === undefined ? {} : { preservation: {
          schema_version: 1, capture_id: preservation.capture_id, capsule_id: preservation.capsule_id
        } })
      })
    };
    let event: EventLogEntry | undefined;

    let updated: Readonly<MemoryEntry>;
    try {
      const onTransition = (): EventLogEntry => {
        event = appendAuditEventSynchronously(this.eventLogRepo, eventInput);
        return event;
      };
      const base = { objectId: parsedObjectId, updatedAt: occurredAt };
      const args: AutonomousTombstoneArguments = preservation === undefined
        ? [{ ...base, disposition: "judged_useless", dispositionRef: null }, { onTransition }]
        : [{ ...base, disposition: "compressed", dispositionRef: preservation.capsule_id, preservation }, { onTransition }];
      updated = await autonomousTombstone.call(this.memoryEntryRepo, ...args);
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

  private async capturePreservation(existing: Readonly<MemoryEntry>, capsuleId: string,
    occurredAt: string): Promise<HistoricalMemoryCapture> {
    const read = this.memoryEntryRepo.readHistoricalCaptureCandidate;
    const nomination = read === undefined ? null : await read.call(this.memoryEntryRepo,
      existing.workspace_id, existing.object_id, capsuleId);
    const capture = nomination?.status === "ready" && canonicalJson(nomination.candidate.member) === canonicalJson(existing)
      ? createHistoricalMemoryCapture(nomination.candidate, occurredAt, fieldContractSha256) : null;
    if (capture === null) {
      throw new CoreError("VALIDATION", "Compressed preservation requires a complete current historical capture", {
        subCode: "PRESERVATION_INELIGIBLE"
      });
    }
    return capture;
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

    // invariant: compressed deletes re-verify independently retained history both
    // before and inside the guarded DELETE; capsule membership gates adoption only.
    // see also: packages/storage/src/repos/preservation/historical-memory-capture.ts:readHistoricalMember.
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
    // false when historical preservation is revoked by a race.
    if (isCompressed) {
      // invariant: onDeleted appends the to_state=deleted audit inside the
      // guarded DELETE transaction.
      const deleteEventInput = this.buildAutonomousDeleteEventInput(existing, parsedReason, parsedCausedBy);
      let deletedEvent: EventLogEntry | undefined;
      const deleted = await hardDeleteWithDisposition.call(this.memoryEntryRepo, parsedObjectId, {
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
    const deleted = await hardDeleteWithDisposition.call(this.memoryEntryRepo, parsedObjectId, {
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
  // recoverable when independent historical preservation no longer holds.
  private async emitPreservationRevoked(
    existing: Readonly<MemoryEntry>,
    parsedReason: string,
    parsedCausedBy: TransitionCausedBy
  ): Promise<void> {
    await this.deferGc(existing, {
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
  }

  // invariant: verdict_revoked leaves judged_useless rows tombstoned and
  // recoverable when the delete-time importance verdict no longer holds.
  private async emitVerdictRevoked(
    existing: Readonly<MemoryEntry>,
    parsedReason: string,
    parsedCausedBy: TransitionCausedBy
  ): Promise<void> {
    await this.deferGc(existing, {
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
  }

  // Persist one audited refusal for the inspected revision before notification.
  private async deferGc(existing: MemoryEntry,
    input: Omit<EventLogEntry, "event_id" | "created_at" | "revision">): Promise<void> {
    const defer = this.memoryEntryRepo.deferAutonomousGc;
    if (defer === undefined) throw new CoreError("CONFLICT", "Audited GC deferral port is unavailable", { subCode: "PORT_UNAVAILABLE" });
    const event = await defer.call(this.memoryEntryRepo, existing,
      () => appendAuditEventSynchronously(this.eventLogRepo, input));
    if (event !== null) await this.runtimeNotifier.notifyEntry(event);
  }

  // Compressed GC needs ready independent history; missing capability or proof fails closed.
  private async compressedPreservationStillValid(existing: Readonly<MemoryEntry>): Promise<boolean> {
    const ref = existing.forget_disposition_ref;
    if (ref === null || ref === undefined) {
      return false;
    }
    const capsuleLookup = this.synthesisCapsuleLookup;
    if (capsuleLookup?.readHistoricalMember === undefined) {
      return false;
    }
    const retained = await capsuleLookup.readHistoricalMember(existing.workspace_id, ref, existing.object_id);
    // Membership and capsule revision were adoption gates. A mutable organizer
    // cannot revoke this member's independently audited, source-bound history.
    return retained.status === "ready";
  }
}
