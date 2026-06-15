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

export class MemoryService {
  private readonly generateObjectId: () => string;
  private readonly now: () => string;

  public constructor(private readonly dependencies: MemoryServiceDependencies) {
    this.generateObjectId = dependencies.generateObjectId ?? (() => randomUUID());
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  public async create(input: MemoryEntryInput): Promise<Readonly<MemoryEntry>> {
    const timestamp = this.now();
    const dynamics =
      this.dependencies.dynamicsService?.assignInitialDynamics({
        dimension: input.dimension,
        formation_kind: input.formation_kind,
        created_at: timestamp
      }) ?? {
        activation_score: null,
        retention_score: null,
        manifestation_state: null,
        retention_state: null,
        decay_profile: null,
        confidence: null,
        reinforcement_count: null,
        contradiction_count: null
      };
    const memoryEntry = parseMemoryEntry({
      ...input,
      object_id: this.generateObjectId(),
      object_kind: "memory_entry",
      schema_version: 1,
      lifecycle_state: "active",
      created_at: timestamp,
      updated_at: timestamp,
      storage_tier: parseStorageTier(input.storage_tier ?? StorageTier.HOT),
      activation_score: dynamics.activation_score,
      retention_score: dynamics.retention_score,
      manifestation_state: dynamics.manifestation_state,
      retention_state: dynamics.retention_state,
      decay_profile: dynamics.decay_profile,
      confidence: dynamics.confidence,
      last_used_at: null,
      last_hit_at: null,
      reinforcement_count: dynamics.reinforcement_count,
      contradiction_count: dynamics.contradiction_count,
      superseded_by: null
    });

    await this.validateEvidenceRefs(memoryEntry.evidence_refs);
    const eventInput = {
      event_type: MemoryGovernanceEventType.SOUL_MEMORY_CREATED,
      entity_type: "memory_entry",
      entity_id: memoryEntry.object_id,
      workspace_id: memoryEntry.workspace_id,
      run_id: memoryEntry.run_id,
      caused_by: memoryEntry.created_by,
      payload_json: SoulMemoryCreatedPayloadSchema.parse({
        object_id: memoryEntry.object_id,
        object_kind: memoryEntry.object_kind,
        workspace_id: memoryEntry.workspace_id,
        run_id: memoryEntry.run_id
      })
    } satisfies Omit<EventLogEntry, "event_id" | "created_at" | "revision">;

    const { created, event } = await this.createRowMaybeAtomicallyEnqueued(
      memoryEntry,
      input.enqueueEnrichment,
      eventInput
    );
    await this.dependencies.runtimeNotifier.notifyEntry(event);

    if (
      created.evidence_refs.length > 0 &&
      (created.dimension === MemoryDimension.PREFERENCE || created.dimension === MemoryDimension.EPISODE)
    ) {
      void this.dependencies.greenService
        ?.reevaluate({
          targetObjectId: created.object_id,
          workspaceId: created.workspace_id
        })
        .catch(() => undefined);
    }

    return created;
  }

  // invariant: production create commits audit + memory row + optional
  // enrich_pending marker in one transaction, EventLog-first.
  // see also: packages/soul/src/garden/materialization-router/router.ts:enqueueEnrichment.
  // see also: packages/core/src/memory/signal-service.ts:SignalService.
  private async createRowMaybeAtomicallyEnqueued(
    memoryEntry: Readonly<MemoryEntry>,
    enqueueEnrichment: MemoryEntryInput["enqueueEnrichment"],
    createdEventInput: Omit<EventLogEntry, "event_id" | "created_at" | "revision">
  ): Promise<{
    readonly created: Readonly<MemoryEntry>;
    readonly event: EventLogEntry;
  }> {
    const createWithinTransaction = this.dependencies.memoryEntryRepo.createWithinTransaction;
    if (createWithinTransaction === undefined) {
      throw new CoreError("CONFLICT", "Memory create transaction port is not available");
    }

    const enrichPendingWriter = this.dependencies.enrichPendingWriter;
    if (enqueueEnrichment !== undefined && enrichPendingWriter === undefined) {
      throw new CoreError(
        "CONFLICT",
        "Atomic enrich_pending enqueue requested but the enrich-pending writer is not wired."
      );
    }

    let event: EventLogEntry | undefined;
    const created = createWithinTransaction.call(this.dependencies.memoryEntryRepo, memoryEntry, {
      beforeCreate: () => {
        event = this.appendCreatedEventSynchronously(createdEventInput);
      },
      afterCreate: () => {
        if (enqueueEnrichment !== undefined) {
          enrichPendingWriter?.enqueue({
            workspaceId: memoryEntry.workspace_id,
            memoryId: memoryEntry.object_id,
            runId: enqueueEnrichment.runId,
            sourceSignalId: enqueueEnrichment.sourceSignalId
          });
        }
      }
    });

    if (event === undefined) {
      throw new CoreError("CONFLICT", "Memory create transaction did not append its audit event.");
    }

    return { created, event };
  }

  private appendCreatedEventSynchronously(
    eventInput: Omit<EventLogEntry, "event_id" | "created_at" | "revision">
  ): EventLogEntry {
    const event = this.dependencies.eventLogRepo.append(eventInput);
    if (isPromiseLike(event)) {
      throw new CoreError(
        "CONFLICT",
        "Memory create transaction requires a synchronous EventLog append port."
      );
    }
    return event;
  }

  public async update(
    objectId: string,
    fields: MemoryEntryUpdateFields,
    reason: string
  ): Promise<Readonly<MemoryEntry>> {
    return await this.updateInternal({ objectId, fields, reason });
  }

  public async updateScoped(
    objectId: string,
    workspaceId: string,
    fields: MemoryEntryUpdateFields,
    reason: string
  ): Promise<Readonly<MemoryEntry>> {
    return await this.updateInternal({ objectId, workspaceId, fields, reason });
  }

  public async validateUpdate(
    objectId: string,
    fields: MemoryEntryUpdateFields
  ): Promise<void> {
    const parsedObjectId = parseObjectId(objectId);
    const parsedFields = parseUpdateFields(fields);

    if (parsedFields.evidence_refs !== undefined) {
      await this.validateEvidenceRefs(parsedFields.evidence_refs);
    }

    const existing = await this.dependencies.memoryEntryRepo.findById(parsedObjectId);
    if (existing === null) {
      throw new CoreError("NOT_FOUND", "Memory entry not found");
    }

    if (existing.lifecycle_state === "archived") {
      throw new CoreError("VALIDATION", "Memory entry is archived and cannot be updated");
    }
  }

  public async archive(
    objectId: string,
    reason: string,
    causedBy: TransitionCausedBy
  ): Promise<Readonly<MemoryEntry>> {
    const parsedObjectId = parseObjectId(objectId);
    const parsedReason = parseReason(reason);
    const parsedCausedBy = parseTransitionCausedBy(causedBy);
    const existing = await this.dependencies.memoryEntryRepo.findById(parsedObjectId);

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
    const archived = await this.dependencies.memoryEntryRepo.archive(parsedObjectId, occurredAt, () => {
      archivedEvent = this.appendAuditEventSynchronously(archivedEventInput);
      stateChangedEvent = this.appendAuditEventSynchronously(stateChangedEventInput);
    });

    if (archivedEvent === undefined || stateChangedEvent === undefined) {
      throw new CoreError("CONFLICT", "Memory archive transaction did not append its audit events.");
    }
    await this.dependencies.runtimeNotifier.notifyEntry(archivedEvent);
    await this.dependencies.runtimeNotifier.notifyEntry(stateChangedEvent);
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
    const existing = await this.dependencies.memoryEntryRepo.findById(parsedObjectId);

    if (existing === null) {
      throw new CoreError("NOT_FOUND", "Memory entry not found");
    }

    ensureAllowedLifecycleTransition(existing.lifecycle_state, parsedNextState);

    if (parsedNextState === "archived") {
      return await this.archive(parsedObjectId, parsedReason, parsedCausedBy);
    }

    const transitionLifecycle = this.dependencies.memoryEntryRepo.transitionLifecycle;
    if (transitionLifecycle === undefined) {
      throw new CoreError("CONFLICT", "Memory lifecycle transition port is not available");
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
      event = this.appendAuditEventSynchronously(eventInput);
    });
    if (event === undefined) {
      throw new CoreError("CONFLICT", "Memory lifecycle transition transaction did not append its audit event.");
    }
    await this.dependencies.runtimeNotifier.notifyEntry(event);
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

    const transitionToDormantIfActive = this.dependencies.memoryEntryRepo.transitionToDormantIfActive;
    if (transitionToDormantIfActive === undefined) {
      throw new CoreError("CONFLICT", "Guarded active->dormant demotion port is not available");
    }

    const existing = await this.dependencies.memoryEntryRepo.findById(parsedObjectId);
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
      event = this.appendAuditEventSynchronously(eventInput);
    });
    if (demoted === null) {
      return { status: "skipped" };
    }
    if (event === undefined) {
      throw new CoreError("CONFLICT", "Active->dormant demotion transaction did not append its audit event.");
    }
    await this.dependencies.runtimeNotifier.notifyEntry(event);
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
    const existing = await this.dependencies.memoryEntryRepo.findById(parsedObjectId);

    if (existing === null) {
      throw new CoreError("NOT_FOUND", "Memory entry not found");
    }

    if (existing.retention_state !== "tombstoned") {
      throw new CoreError("VALIDATION", "Only tombstoned memories can be hard-deleted");
    }

    const hardDeleteTombstoned = this.dependencies.memoryEntryRepo.hardDeleteTombstoned;
    if (hardDeleteTombstoned === undefined) {
      throw new CoreError("CONFLICT", "Memory tombstone delete port is not available");
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
      event = this.appendAuditEventSynchronously(eventInput);
    });
    if (event === undefined) {
      throw new CoreError("CONFLICT", "Memory tombstone delete transaction did not append its audit event.");
    }
    await this.dependencies.runtimeNotifier.notifyEntry(event);
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

    const existing = await this.dependencies.memoryEntryRepo.findById(parsedObjectId);
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

    const autonomousTombstone = this.dependencies.memoryEntryRepo.autonomousTombstone;
    if (autonomousTombstone === undefined) {
      throw new CoreError("CONFLICT", "Autonomous tombstone port is not available");
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
            event = this.appendAuditEventSynchronously(eventInput);
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
    await this.dependencies.runtimeNotifier.notifyEntry(event);
    return updated;
  }

  private async classifyAutonomousTombstoneRepoRefusal(
    objectId: string,
    error: unknown
  ): Promise<CoreError | null> {
    if (!isRepoGuardRefusal(error)) {
      return null;
    }

    const current = await this.dependencies.memoryEntryRepo.findById(objectId);
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
    const existing = await this.dependencies.memoryEntryRepo.findById(parsedObjectId);

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

    const hardDeleteWithDisposition = this.dependencies.memoryEntryRepo.hardDeleteTombstonedWithDisposition;
    if (hardDeleteWithDisposition === undefined) {
      throw new CoreError("CONFLICT", "Disposition-gated tombstone delete port is not available");
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
          deletedEvent = this.appendAuditEventSynchronously(deleteEventInput);
        }
      });
      if (!deleted) {
        await this.emitPreservationRevoked(existing, parsedReason, parsedCausedBy);
        return false;
      }
      if (deletedEvent === undefined) {
        throw new CoreError("CONFLICT", "Compressed tombstone delete transaction did not append its audit event.");
      }
      await this.dependencies.runtimeNotifier.notifyEntry(deletedEvent);
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
        deletedEvent = this.appendAuditEventSynchronously(deleteEventInput);
      }
    });
    if (!deleted) {
      await this.emitVerdictRevoked(existing, parsedReason, parsedCausedBy);
      return false;
    }
    if (deletedEvent === undefined) {
      throw new CoreError("CONFLICT", "Judged-useless tombstone delete transaction did not append its audit event.");
    }
    await this.dependencies.runtimeNotifier.notifyEntry(deletedEvent);
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

  // invariant: audit-inside-transaction seams require a synchronous EventLog
  // append port, otherwise storage mutation could commit without atomic audit.
  private appendAuditEventSynchronously(
    eventInput: Omit<EventLogEntry, "event_id" | "created_at" | "revision">
  ): EventLogEntry {
    const event = this.dependencies.eventLogRepo.append(eventInput);
    if (isPromiseLike(event)) {
      throw new CoreError(
        "CONFLICT",
        "Autonomous audit-inside-transaction requires a synchronous EventLog append port."
      );
    }
    return event;
  }

  // invariant: preservation_revoked leaves compressed rows tombstoned and
  // recoverable when capsule preservation no longer holds.
  private async emitPreservationRevoked(
    existing: Readonly<MemoryEntry>,
    parsedReason: string,
    parsedCausedBy: TransitionCausedBy
  ): Promise<void> {
    const skipEvent = await this.dependencies.eventLogRepo.append({
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
        occurred_at: this.now()
      })
    });
    await this.dependencies.runtimeNotifier.notifyEntry(skipEvent);
  }

  // invariant: verdict_revoked leaves judged_useless rows tombstoned and
  // recoverable when the delete-time importance verdict no longer holds.
  private async emitVerdictRevoked(
    existing: Readonly<MemoryEntry>,
    parsedReason: string,
    parsedCausedBy: TransitionCausedBy
  ): Promise<void> {
    const skipEvent = await this.dependencies.eventLogRepo.append({
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
    await this.dependencies.runtimeNotifier.notifyEntry(skipEvent);
  }

  // invariant: compressed physical delete requires a live preserving capsule at
  // delete time; missing or stale preservation returns false.
  private async compressedPreservationStillValid(
    existing: Readonly<MemoryEntry>
  ): Promise<boolean> {
    const ref = existing.forget_disposition_ref;
    if (ref === null || ref === undefined) {
      return false;
    }
    const capsuleLookup = this.dependencies.synthesisCapsuleLookup;
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

  public findById(objectId: string): Promise<Readonly<MemoryEntry> | null> {
    return this.dependencies.memoryEntryRepo.findById(objectId);
  }

  // invariant: scoped lookup returns null for cross-workspace rows so handlers
  // cannot distinguish them from missing objects.
  public async findByIdScoped(
    objectId: string,
    workspaceId: string
  ): Promise<Readonly<MemoryEntry> | null> {
    const entry = await this.dependencies.memoryEntryRepo.findById(objectId);
    if (entry === null || entry.workspace_id !== workspaceId) {
      return null;
    }
    return entry;
  }

  // invariant: scoped batch lookup hides cross-workspace rows the same way the
  // single-id scoped lookup does, so callers cannot distinguish hidden rows
  // from missing ones.
  public async findByIdsScoped(
    objectIds: readonly string[],
    workspaceId: string
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    const findByIds = this.dependencies.memoryEntryRepo.findByIds;
    if (findByIds === undefined) {
      const entries = await Promise.all(
        objectIds.map(async (objectId) => await this.findByIdScoped(objectId, workspaceId))
      );
      return entries.filter((entry): entry is Readonly<MemoryEntry> => entry !== null);
    }

    const entries = await findByIds.call(this.dependencies.memoryEntryRepo, objectIds);
    return entries.filter((entry) => entry.workspace_id === workspaceId);
  }

  public findByWorkspaceId(
    workspaceId: string,
    page?: MemoryListPageOptions
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    return this.dependencies.memoryEntryRepo.findByWorkspaceId(workspaceId, undefined, page);
  }

  public async countByWorkspaceId(workspaceId: string): Promise<number> {
    const countByWorkspaceId = this.dependencies.memoryEntryRepo.countByWorkspaceId;
    if (countByWorkspaceId !== undefined) {
      return await countByWorkspaceId.call(this.dependencies.memoryEntryRepo, workspaceId);
    }
    return (await this.findByWorkspaceId(workspaceId)).length;
  }

  public findByRunId(
    runId: string,
    page?: MemoryListPageOptions
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    return this.dependencies.memoryEntryRepo.findByRunId(runId, page);
  }

  public async countByRunId(runId: string): Promise<number> {
    const countByRunId = this.dependencies.memoryEntryRepo.countByRunId;
    if (countByRunId !== undefined) {
      return await countByRunId.call(this.dependencies.memoryEntryRepo, runId);
    }
    return (await this.findByRunId(runId)).length;
  }

  public findByDimension(
    workspaceId: string,
    dimension: MemoryEntry["dimension"],
    page?: MemoryListPageOptions
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    return this.dependencies.memoryEntryRepo.findByDimension(workspaceId, dimension, page);
  }

  public async countByDimension(
    workspaceId: string,
    dimension: MemoryEntry["dimension"]
  ): Promise<number> {
    const countByDimension = this.dependencies.memoryEntryRepo.countByDimension;
    if (countByDimension !== undefined) {
      return await countByDimension.call(this.dependencies.memoryEntryRepo, workspaceId, dimension);
    }
    return (await this.findByDimension(workspaceId, dimension)).length;
  }

  public findByScopeClass(
    workspaceId: string,
    scopeClass: ScopeClass
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    return this.dependencies.memoryEntryRepo.findByScopeClass(workspaceId, scopeClass);
  }

  public validateFactualPolicyBoundary(entry: MemoryEntry, condition: FactualPolicyCondition): boolean {
    const parsedEntry = parseMemoryEntry(entry);
    const parsedCondition = parseFactualPolicyCondition(condition);

    if (parsedEntry.dimension !== MemoryDimension.FACT) {
      return false;
    }

    return (
      parsedCondition.affects_execution_paths ||
      parsedCondition.affects_tool_choices ||
      parsedCondition.affects_write_permissions ||
      parsedCondition.affects_governance_decisions
    );
  }

  private async updateInternal(input: {
    readonly objectId: string;
    readonly workspaceId?: string;
    readonly fields: MemoryEntryUpdateFields;
    readonly reason: string;
  }): Promise<Readonly<MemoryEntry>> {
    const parsedObjectId = parseObjectId(input.objectId);
    const parsedWorkspaceId =
      input.workspaceId === undefined ? undefined : parseNonEmptyString(input.workspaceId, "workspaceId");
    const parsedReason = parseReason(input.reason);
    const parsedFields = parseUpdateFields(input.fields);

    if (parsedFields.evidence_refs !== undefined) {
      await this.validateEvidenceRefs(parsedFields.evidence_refs);
    }

    const existing = await this.dependencies.memoryEntryRepo.findById(parsedObjectId);

    if (existing === null || (parsedWorkspaceId !== undefined && existing.workspace_id !== parsedWorkspaceId)) {
      throw new CoreError("NOT_FOUND", "Memory entry not found");
    }

    if (existing.lifecycle_state === "archived") {
      throw new CoreError("VALIDATION", "Memory entry is archived and cannot be updated");
    }

    const updatedFields = toUpdatedFieldNames(parsedFields);
    const occurredAt = this.now();

    // invariant: append SOUL_MEMORY_UPDATED only after repo write succeeds.
    const repoFields = {
      ...parsedFields,
      updated_at: occurredAt
    };
    const updated =
      parsedWorkspaceId === undefined
        ? await this.dependencies.memoryEntryRepo.update(parsedObjectId, repoFields)
        : await this.updateRepoScoped(parsedObjectId, parsedWorkspaceId, repoFields);

    const event = await this.dependencies.eventLogRepo.append({
      event_type: MemoryGovernanceEventType.SOUL_MEMORY_UPDATED,
      entity_type: "memory_entry",
      entity_id: existing.object_id,
      workspace_id: existing.workspace_id,
      run_id: existing.run_id,
      caused_by: parsedReason,
      payload_json: SoulMemoryUpdatedPayloadSchema.parse({
        object_id: existing.object_id,
        object_kind: existing.object_kind,
        workspace_id: existing.workspace_id,
        run_id: existing.run_id,
        updated_fields: updatedFields
      })
    });

    await this.dependencies.runtimeNotifier.notifyEntry(event);
    if (
      parsedFields.evidence_refs !== undefined &&
      shouldRevokeGreenForEvidenceRewrite(existing.evidence_refs, parsedFields.evidence_refs)
    ) {
      await this.dependencies.greenService?.pierce?.({
        targetObjectId: existing.object_id,
        workspaceId: existing.workspace_id,
        reason: RevokeReason.MAPPING_REVOKED,
        runId: existing.run_id
      });
    }
    return updated;
  }

  private async updateRepoScoped(
    objectId: string,
    workspaceId: string,
    fields: MemoryEntryRepoUpdateFields
  ): Promise<Readonly<MemoryEntry>> {
    if (this.dependencies.memoryEntryRepo.updateScoped === undefined) {
      throw new CoreError("VALIDATION", "Scoped memory update is not available");
    }

    return await this.dependencies.memoryEntryRepo.updateScoped(objectId, workspaceId, fields);
  }

  private async validateEvidenceRefs(evidenceRefs: readonly string[]): Promise<void> {
    const results = await Promise.all(
      evidenceRefs.map(async (evidenceRef) => ({
        evidenceRef,
        evidence: await this.dependencies.evidenceService.findById(evidenceRef)
      }))
    );

    const firstMissing = results.find((result) => result.evidence === null);

    if (firstMissing !== undefined) {
      throw new CoreError("VALIDATION", `Evidence reference not found: ${firstMissing.evidenceRef}`);
    }
  }
}
