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

export async function memoryServiceCreate(owner: MemoryServiceMethodOwner, input: MemoryEntryInput): Promise<Readonly<MemoryEntry>> {
    const { enqueueEnrichment, ...memoryEntryInput } = input;
    const timestamp = owner.now();
    const dynamics =
      owner.dependencies.dynamicsService?.assignInitialDynamics({
        dimension: memoryEntryInput.dimension,
        formation_kind: memoryEntryInput.formation_kind,
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
      ...memoryEntryInput,
      object_id: owner.generateObjectId(),
      object_kind: "memory_entry",
      schema_version: 1,
      lifecycle_state: "active",
      created_at: timestamp,
      updated_at: timestamp,
      storage_tier: parseStorageTier(memoryEntryInput.storage_tier ?? StorageTier.HOT),
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

    await owner.validateEvidenceRefs(memoryEntry.evidence_refs);
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

    const { created, event } = await owner.createRowMaybeAtomicallyEnqueued(
      memoryEntry,
      enqueueEnrichment,
      eventInput
    );
    await owner.dependencies.runtimeNotifier.notifyEntry(event);

    if (
      created.evidence_refs.length > 0 &&
      (created.dimension === MemoryDimension.PREFERENCE || created.dimension === MemoryDimension.EPISODE)
    ) {
      scheduleAuditedAsyncSideEffect(
        owner.dependencies.greenService?.reevaluate({
          targetObjectId: created.object_id,
          workspaceId: created.workspace_id
        }),
        {
          source: "MemoryService",
          operation: "green_reevaluate_after_memory_create",
          subjectType: "memory_entry",
          subjectId: created.object_id,
          workspaceId: created.workspace_id,
          runId: created.run_id,
          causedBy: created.created_by,
          committedEventId: event.event_id,
          warningCode: "ALAYA_MEMORY_GREEN_REEVALUATE_FAILED",
          warningMessage: "[MemoryService] greenService.reevaluate rejected (fire-and-forget)",
          eventLogRepo: owner.dependencies.eventLogRepo,
          runtimeNotifier: owner.dependencies.runtimeNotifier,
          now: owner.now
        }
      );
    }

    return created;
  }

export async function memoryServiceCreateRowMaybeAtomicallyEnqueued(owner: MemoryServiceMethodOwner, memoryEntry: Readonly<MemoryEntry>, enqueueEnrichment: MemoryEntryInput["enqueueEnrichment"], createdEventInput: Omit<EventLogEntry, "event_id" | "created_at" | "revision">): Promise<{
    readonly created: Readonly<MemoryEntry>;
    readonly event: EventLogEntry;
  }> {
    const createWithinTransaction = owner.dependencies.memoryEntryRepo.createWithinTransaction;
    if (createWithinTransaction === undefined) {
      throw new CoreError("CONFLICT", "Memory create transaction port is not available");
    }

    const enrichPendingWriter = owner.dependencies.enrichPendingWriter;
    if (enqueueEnrichment !== undefined && enrichPendingWriter === undefined) {
      throw new CoreError(
        "CONFLICT",
        "Atomic enrich_pending enqueue requested but the enrich-pending writer is not wired."
      );
    }

    let event: EventLogEntry | undefined;
    const created = createWithinTransaction.call(owner.dependencies.memoryEntryRepo, memoryEntry, {
      beforeCreate: () => {
        event = owner.appendCreatedEventSynchronously(createdEventInput);
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

export function memoryServiceAppendCreatedEventSynchronously(owner: MemoryServiceMethodOwner, eventInput: Omit<EventLogEntry, "event_id" | "created_at" | "revision">): EventLogEntry {
    const event = owner.dependencies.eventLogRepo.append(eventInput);
    if (isPromiseLike(event)) {
      throw new CoreError(
        "CONFLICT",
        "Memory create transaction requires a synchronous EventLog append port."
      );
    }
    return event;
  }

export async function memoryServiceUpdate(owner: MemoryServiceMethodOwner, objectId: string, fields: MemoryEntryUpdateFields, reason: string): Promise<Readonly<MemoryEntry>> {
    return await owner.updateInternal({ objectId, fields, reason });
  }

export async function memoryServiceUpdateScoped(owner: MemoryServiceMethodOwner, objectId: string, workspaceId: string, fields: MemoryEntryUpdateFields, reason: string): Promise<Readonly<MemoryEntry>> {
    return await owner.updateInternal({ objectId, workspaceId, fields, reason });
  }

export async function memoryServiceValidateUpdate(owner: MemoryServiceMethodOwner, objectId: string, fields: MemoryEntryUpdateFields): Promise<void> {
    const parsedObjectId = parseObjectId(objectId);
    const parsedFields = parseUpdateFields(fields);

    if (parsedFields.evidence_refs !== undefined) {
      await owner.validateEvidenceRefs(parsedFields.evidence_refs);
    }

    const existing = await owner.dependencies.memoryEntryRepo.findById(parsedObjectId);
    if (existing === null) {
      throw new CoreError("NOT_FOUND", "Memory entry not found");
    }

    if (existing.lifecycle_state === "archived") {
      throw new CoreError("VALIDATION", "Memory entry is archived and cannot be updated");
    }
  }

export async function memoryServiceArchive(owner: MemoryServiceMethodOwner, objectId: string, reason: string, causedBy: TransitionCausedBy): Promise<Readonly<MemoryEntry>> {
    const parsedObjectId = parseObjectId(objectId);
    const parsedReason = parseReason(reason);
    const parsedCausedBy = parseTransitionCausedBy(causedBy);
    const existing = await owner.dependencies.memoryEntryRepo.findById(parsedObjectId);

    if (existing === null) {
      throw new CoreError("NOT_FOUND", "Memory entry not found");
    }

    if (existing.lifecycle_state === "archived") {
      throw new CoreError("VALIDATION", "Memory entry is already archived");
    }

    const occurredAt = owner.now();
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
    const archived = await owner.dependencies.memoryEntryRepo.archive(parsedObjectId, occurredAt, () => {
      archivedEvent = owner.appendAuditEventSynchronously(archivedEventInput);
      stateChangedEvent = owner.appendAuditEventSynchronously(stateChangedEventInput);
    });

    if (archivedEvent === undefined || stateChangedEvent === undefined) {
      throw new CoreError("CONFLICT", "Memory archive transaction did not append its audit events.");
    }
    await owner.dependencies.runtimeNotifier.notifyEntry(archivedEvent);
    await owner.dependencies.runtimeNotifier.notifyEntry(stateChangedEvent);
    return archived;
  }

export async function memoryServiceTransitionLifecycle(owner: MemoryServiceMethodOwner, objectId: string, nextState: MemoryEntry["lifecycle_state"], reason: string, causedBy: TransitionCausedBy): Promise<Readonly<MemoryEntry>> {
    const parsedObjectId = parseObjectId(objectId);
    const parsedNextState = parseLifecycleState(nextState);
    const parsedReason = parseReason(reason);
    const parsedCausedBy = parseTransitionCausedBy(causedBy);
    const existing = await owner.dependencies.memoryEntryRepo.findById(parsedObjectId);

    if (existing === null) {
      throw new CoreError("NOT_FOUND", "Memory entry not found");
    }

    ensureAllowedLifecycleTransition(existing.lifecycle_state, parsedNextState);

    if (parsedNextState === "archived") {
      return await owner.archive(parsedObjectId, parsedReason, parsedCausedBy);
    }

    const transitionLifecycle = owner.dependencies.memoryEntryRepo.transitionLifecycle;
    if (transitionLifecycle === undefined) {
      throw new CoreError("CONFLICT", "Memory lifecycle transition port is not available");
    }

    const occurredAt = owner.now();
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
      event = owner.appendAuditEventSynchronously(eventInput);
    });
    if (event === undefined) {
      throw new CoreError("CONFLICT", "Memory lifecycle transition transaction did not append its audit event.");
    }
    await owner.dependencies.runtimeNotifier.notifyEntry(event);
    return updated;
  }

export async function memoryServiceDemoteActiveToDormantIfActive(owner: MemoryServiceMethodOwner, objectId: string, reason: string, causedBy: TransitionCausedBy): Promise<{ readonly status: "demoted"; readonly entry: Readonly<MemoryEntry> } | { readonly status: "skipped" }> {
    const parsedObjectId = parseObjectId(objectId);
    const parsedReason = parseReason(reason);
    const parsedCausedBy = parseTransitionCausedBy(causedBy);

    const transitionToDormantIfActive = owner.dependencies.memoryEntryRepo.transitionToDormantIfActive;
    if (transitionToDormantIfActive === undefined) {
      throw new CoreError("CONFLICT", "Guarded active->dormant demotion port is not available");
    }

    const existing = await owner.dependencies.memoryEntryRepo.findById(parsedObjectId);
    if (existing === null) {
      return { status: "skipped" };
    }
    if (existing.lifecycle_state !== "active") {
      return { status: "skipped" };
    }

    const occurredAt = owner.now();
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
      event = owner.appendAuditEventSynchronously(eventInput);
    });
    if (demoted === null) {
      return { status: "skipped" };
    }
    if (event === undefined) {
      throw new CoreError("CONFLICT", "Active->dormant demotion transaction did not append its audit event.");
    }
    await owner.dependencies.runtimeNotifier.notifyEntry(event);
    return { status: "demoted", entry: demoted };
  }

export async function memoryServiceHardDeleteTombstoned(owner: MemoryServiceMethodOwner, objectId: string, reason: string, causedBy: TransitionCausedBy): Promise<void> {
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

    const hardDeleteTombstoned = owner.dependencies.memoryEntryRepo.hardDeleteTombstoned;
    if (hardDeleteTombstoned === undefined) {
      throw new CoreError("CONFLICT", "Memory tombstone delete port is not available");
    }

    const occurredAt = owner.now();
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
      event = owner.appendAuditEventSynchronously(eventInput);
    });
    if (event === undefined) {
      throw new CoreError("CONFLICT", "Memory tombstone delete transaction did not append its audit event.");
    }
    await owner.dependencies.runtimeNotifier.notifyEntry(event);
  }
