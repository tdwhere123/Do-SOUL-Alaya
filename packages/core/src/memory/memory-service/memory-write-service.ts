import {
  MemoryDimension,
  MemoryGovernanceEventType,
  RevokeReason,
  SoulMemoryCreatedPayloadSchema,
  SoulMemoryUpdatedPayloadSchema,
  StorageTier,
  type EventLogEntry,
  type MemoryEntry
} from "@do-soul/alaya-protocol";
import { CoreError } from "../../shared/errors.js";
import { scheduleAuditedAsyncSideEffect } from "../../runtime/async-side-effect-auditor.js";
import { parseNonEmptyString, parseObjectId } from "../../shared/validators.js";
import type {
  MemoryEntryInput,
  MemoryEntryRepoUpdateFields,
  MemoryEntryUpdateFields,
  MemoryRuntimeNotifier,
  MemoryServiceDynamicsPort,
  MemoryServiceEnrichPendingWriterPort,
  MemoryServiceEventLogRepoPort,
  MemoryServiceEvidenceServicePort,
  MemoryServiceGreenPort,
  MemoryEntryReadPort,
  MemoryEntryWritePort
} from "./types.js";
import {
  isPromiseLike,
  parseMemoryEntry,
  parseReason,
  parseStorageTier,
  parseUpdateFields,
  shouldRevokeGreenForEvidenceRewrite,
  toUpdatedFieldNames
} from "./validators.js";

export interface MemoryWriteServiceDependencies {
  readonly memoryEntryRepo: MemoryEntryReadPort & MemoryEntryWritePort;
  readonly evidenceService: MemoryServiceEvidenceServicePort;
  readonly eventLogRepo: MemoryServiceEventLogRepoPort;
  readonly runtimeNotifier: MemoryRuntimeNotifier;
  readonly dynamicsService?: MemoryServiceDynamicsPort;
  readonly greenService?: MemoryServiceGreenPort;
  readonly enrichPendingWriter?: MemoryServiceEnrichPendingWriterPort;
  readonly generateObjectId: () => string;
  readonly now: () => string;
}

// invariant: write path is the create/update truth boundary; it appends
// EventLog audit (create EventLog-first, update repo-then-event) and validates
// evidence refs before mutation.
export class MemoryWriteService {
  private readonly dependencies: MemoryWriteServiceDependencies;
  private readonly generateObjectId: () => string;
  private readonly now: () => string;

  public constructor(dependencies: MemoryWriteServiceDependencies) {
    this.dependencies = dependencies;
    this.generateObjectId = dependencies.generateObjectId;
    this.now = dependencies.now;
  }

  public async create(input: MemoryEntryInput): Promise<Readonly<MemoryEntry>> {
    const { enqueueEnrichment, ...memoryEntryInput } = input;
    const timestamp = this.now();
    const dynamics =
      this.dependencies.dynamicsService?.assignInitialDynamics({
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
      object_id: this.generateObjectId(),
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
      enqueueEnrichment,
      eventInput
    );
    await this.dependencies.runtimeNotifier.notifyEntry(event);

    if (
      created.evidence_refs.length > 0 &&
      (created.dimension === MemoryDimension.PREFERENCE || created.dimension === MemoryDimension.EPISODE)
    ) {
      scheduleAuditedAsyncSideEffect(
        this.dependencies.greenService?.reevaluate({
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
          eventLogRepo: this.dependencies.eventLogRepo,
          runtimeNotifier: this.dependencies.runtimeNotifier,
          now: this.now
        }
      );
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
      throw new CoreError("CONFLICT", "Memory create transaction port is not available", {
        subCode: "PORT_UNAVAILABLE"
      });
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

  public async validateUpdate(objectId: string, fields: MemoryEntryUpdateFields): Promise<void> {
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
    if (evidenceRefs.length === 0) {
      return;
    }

    const distinctEvidenceRefs = [...new Set(evidenceRefs)];
    const findByIds = this.dependencies.evidenceService.findByIds;
    if (findByIds !== undefined) {
      const evidence = await findByIds.call(this.dependencies.evidenceService, distinctEvidenceRefs);
      const foundEvidenceRefs = new Set(evidence.map((entry) => entry.object_id));
      const firstMissing = distinctEvidenceRefs.find((evidenceRef) => !foundEvidenceRefs.has(evidenceRef));
      if (firstMissing !== undefined) {
        throw new CoreError("VALIDATION", `Evidence reference not found: ${firstMissing}`);
      }
      return;
    }

    const results = await Promise.all(
      distinctEvidenceRefs.map(async (evidenceRef) => ({
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
