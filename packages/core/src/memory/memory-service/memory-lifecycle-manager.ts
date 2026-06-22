import {
  MemoryGovernanceEventType,
  SoulMemoryArchivedPayloadSchema,
  SoulMemoryStateChangedPayloadSchema,
  type EventLogEntry,
  type MemoryEntry,
  type TransitionCausedBy
} from "@do-soul/alaya-protocol";
import { CoreError } from "../../shared/errors.js";
import { parseObjectId } from "../../shared/validators.js";
import type {
  MemoryEntryLifecyclePort,
  MemoryEntryReadPort,
  MemoryRuntimeNotifier,
  MemoryServiceEventLogRepoPort
} from "./types.js";
import {
  ensureAllowedLifecycleTransition,
  parseLifecycleState,
  parseReason,
  parseTransitionCausedBy
} from "./validators.js";
import { appendAuditEventSynchronously } from "./memory-audit-append.js";

export interface MemoryLifecycleManagerDependencies {
  readonly memoryEntryRepo: MemoryEntryReadPort & MemoryEntryLifecyclePort;
  readonly eventLogRepo: MemoryServiceEventLogRepoPort;
  readonly runtimeNotifier: MemoryRuntimeNotifier;
  readonly now: () => string;
}

// invariant: lifecycle transitions append audit inside the guarded repo
// transaction so storage never commits without atomic audit.
export class MemoryLifecycleManager {
  private readonly memoryEntryRepo: MemoryEntryReadPort & MemoryEntryLifecyclePort;
  private readonly eventLogRepo: MemoryServiceEventLogRepoPort;
  private readonly runtimeNotifier: MemoryRuntimeNotifier;
  private readonly now: () => string;

  public constructor(dependencies: MemoryLifecycleManagerDependencies) {
    this.memoryEntryRepo = dependencies.memoryEntryRepo;
    this.eventLogRepo = dependencies.eventLogRepo;
    this.runtimeNotifier = dependencies.runtimeNotifier;
    this.now = dependencies.now;
  }

  public async archive(
    objectId: string,
    reason: string,
    causedBy: TransitionCausedBy
  ): Promise<Readonly<MemoryEntry>> {
    const parsedObjectId = parseObjectId(objectId);
    const parsedReason = parseReason(reason);
    const parsedCausedBy = parseTransitionCausedBy(causedBy);
    const existing = await this.memoryEntryRepo.findById(parsedObjectId);

    if (existing === null) {
      throw new CoreError("NOT_FOUND", "Memory entry not found");
    }

    if (existing.lifecycle_state === "archived") {
      throw new CoreError("VALIDATION", "Memory entry is already archived");
    }

    const occurredAt = this.now();
    const transitionPayload = {
      object_id: existing.object_id,
      object_kind: existing.object_kind,
      workspace_id: existing.workspace_id,
      run_id: existing.run_id,
      from_state: existing.lifecycle_state,
      to_state: "archived",
      reason_code: parsedReason,
      caused_by: parsedCausedBy,
      evidence_refs: null,
      occurred_at: occurredAt
    } as const;
    const archivedEventInput = {
      event_type: MemoryGovernanceEventType.SOUL_MEMORY_ARCHIVED,
      entity_type: "memory_entry",
      entity_id: existing.object_id,
      workspace_id: existing.workspace_id,
      run_id: existing.run_id,
      caused_by: parsedCausedBy,
      payload_json: SoulMemoryArchivedPayloadSchema.parse(transitionPayload)
    } satisfies Omit<EventLogEntry, "event_id" | "created_at" | "revision">;

    const stateChangedEventInput = {
      event_type: MemoryGovernanceEventType.SOUL_MEMORY_STATE_CHANGED,
      entity_type: "memory_entry",
      entity_id: existing.object_id,
      workspace_id: existing.workspace_id,
      run_id: existing.run_id,
      caused_by: parsedCausedBy,
      payload_json: SoulMemoryStateChangedPayloadSchema.parse(transitionPayload)
    } satisfies Omit<EventLogEntry, "event_id" | "created_at" | "revision">;

    let archivedEvent: EventLogEntry | undefined;
    let stateChangedEvent: EventLogEntry | undefined;
    const archived = await this.memoryEntryRepo.archive(parsedObjectId, occurredAt, () => {
      archivedEvent = appendAuditEventSynchronously(this.eventLogRepo, archivedEventInput);
      stateChangedEvent = appendAuditEventSynchronously(this.eventLogRepo, stateChangedEventInput);
    });

    if (archivedEvent === undefined || stateChangedEvent === undefined) {
      throw new CoreError("CONFLICT", "Memory archive transaction did not append its audit events.");
    }
    await this.runtimeNotifier.notifyEntry(archivedEvent);
    await this.runtimeNotifier.notifyEntry(stateChangedEvent);
    return archived;
  }

  public async transitionLifecycle(
    objectId: string,
    nextState: MemoryEntry["lifecycle_state"],
    reason: string,
    causedBy: TransitionCausedBy
  ): Promise<Readonly<MemoryEntry>> {
    const parsedObjectId = parseObjectId(objectId);
    const parsedNextState = parseLifecycleState(nextState);
    const parsedReason = parseReason(reason);
    const parsedCausedBy = parseTransitionCausedBy(causedBy);
    const existing = await this.memoryEntryRepo.findById(parsedObjectId);

    if (existing === null) {
      throw new CoreError("NOT_FOUND", "Memory entry not found");
    }

    ensureAllowedLifecycleTransition(existing.lifecycle_state, parsedNextState);

    if (parsedNextState === "archived") {
      return await this.archive(parsedObjectId, parsedReason, parsedCausedBy);
    }

    const transitionLifecycle = this.memoryEntryRepo.transitionLifecycle;
    if (transitionLifecycle === undefined) {
      throw new CoreError("CONFLICT", "Memory lifecycle transition port is not available", {
        subCode: "PORT_UNAVAILABLE"
      });
    }

    const occurredAt = this.now();
    const eventInput = {
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
        to_state: parsedNextState,
        reason_code: parsedReason,
        caused_by: parsedCausedBy,
        evidence_refs: null,
        occurred_at: occurredAt
      })
    } satisfies Omit<EventLogEntry, "event_id" | "created_at" | "revision">;

    let event: EventLogEntry | undefined;
    const updated = await transitionLifecycle(parsedObjectId, parsedNextState, occurredAt, () => {
      event = appendAuditEventSynchronously(this.eventLogRepo, eventInput);
    });
    if (event === undefined) {
      throw new CoreError("CONFLICT", "Memory lifecycle transition transaction did not append its audit event.");
    }
    await this.runtimeNotifier.notifyEntry(event);
    return updated;
  }

  // invariant: autonomous active -> dormant demotion is race-tolerant and
  // appends its audit inside the guarded UPDATE transaction.
  // see also: apps/core-daemon/src/index.ts:auditedDormantDemotionPort.
  // see also: packages/soul/src/garden/janitor.ts:executeDormantDemotion.
  public async demoteActiveToDormantIfActive(
    objectId: string,
    reason: string,
    causedBy: TransitionCausedBy
  ): Promise<{ readonly status: "demoted"; readonly entry: Readonly<MemoryEntry> } | { readonly status: "skipped" }> {
    const parsedObjectId = parseObjectId(objectId);
    const parsedReason = parseReason(reason);
    const parsedCausedBy = parseTransitionCausedBy(causedBy);

    const transitionToDormantIfActive = this.memoryEntryRepo.transitionToDormantIfActive;
    if (transitionToDormantIfActive === undefined) {
      throw new CoreError("CONFLICT", "Guarded active->dormant demotion port is not available", {
        subCode: "PORT_UNAVAILABLE"
      });
    }

    const existing = await this.memoryEntryRepo.findById(parsedObjectId);
    if (existing === null) {
      return { status: "skipped" };
    }
    if (existing.lifecycle_state !== "active") {
      return { status: "skipped" };
    }

    const occurredAt = this.now();
    const eventInput = {
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
        from_state: "active",
        to_state: "dormant",
        reason_code: parsedReason,
        caused_by: parsedCausedBy,
        evidence_refs: null,
        occurred_at: occurredAt
      })
    } satisfies Omit<EventLogEntry, "event_id" | "created_at" | "revision">;

    // invariant: onTransition is the audit append, so 0-row guarded UPDATEs
    // write no spurious audit and successful demotions are atomic.
    let event: EventLogEntry | undefined;
    const demoted = await transitionToDormantIfActive(parsedObjectId, occurredAt, () => {
      event = appendAuditEventSynchronously(this.eventLogRepo, eventInput);
    });
    if (demoted === null) {
      return { status: "skipped" };
    }
    if (event === undefined) {
      throw new CoreError("CONFLICT", "Active->dormant demotion transaction did not append its audit event.");
    }
    await this.runtimeNotifier.notifyEntry(event);
    return { status: "demoted", entry: demoted };
  }

  public async hardDeleteTombstoned(
    objectId: string,
    reason: string,
    causedBy: TransitionCausedBy
  ): Promise<void> {
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

    const hardDeleteTombstoned = this.memoryEntryRepo.hardDeleteTombstoned;
    if (hardDeleteTombstoned === undefined) {
      throw new CoreError("CONFLICT", "Memory tombstone delete port is not available", {
        subCode: "PORT_UNAVAILABLE"
      });
    }

    const occurredAt = this.now();
    const eventInput = {
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
        reason_code: parsedReason,
        caused_by: parsedCausedBy,
        evidence_refs: null,
        occurred_at: occurredAt
      })
    } satisfies Omit<EventLogEntry, "event_id" | "created_at" | "revision">;

    let event: EventLogEntry | undefined;
    await hardDeleteTombstoned(parsedObjectId, () => {
      event = appendAuditEventSynchronously(this.eventLogRepo, eventInput);
    });
    if (event === undefined) {
      throw new CoreError("CONFLICT", "Memory tombstone delete transaction did not append its audit event.");
    }
    await this.runtimeNotifier.notifyEntry(event);
  }
}
