import {
  MemoryDimension,
  MemoryGovernanceEventType,
  RevokeReason,
  SoulMemoryCreatedPayloadSchema,
  SoulMemoryUpdatedPayloadSchema,
  StorageTier,
  resolveMemoryDynamicsPolicy,
  type EventLogEntry,
  type MemoryEntry
} from "@do-soul/alaya-protocol";
import { CoreError } from "../../shared/errors.js";
import { scheduleAuditedAsyncSideEffect } from "../../runtime/async-side-effect-auditor.js";
import { bindEventPublisher, type EventPublisher } from "../../runtime/event-publisher.js";
import { parseNonEmptyString, parseObjectId } from "../../shared/validators.js";
import { appendMemoryEventLogSynchronously } from "./memory-audit-append.js";
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
import type { MemoryObjectKeyWriter } from "../object-keys/write-service.js";
import {
  SOURCE_ENRICHMENT_CONTRACT,
  admitSourceEnrichmentIntent,
  isSourceEnrichmentQueueBackpressure,
  type SourceWriteGardenIntentPort
} from "../source-write-garden-intent.js";
import {
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
  readonly gardenIntentPort?: SourceWriteGardenIntentPort;
  readonly objectKeyWriter?: MemoryObjectKeyWriter;
  readonly generateObjectId: () => string;
  readonly now: () => string;
}

// invariant: write path is the create/update truth boundary; it appends
// EventLog audit EventLog-first and validates
// evidence refs before mutation.
export class MemoryWriteService {
  private readonly dependencies: MemoryWriteServiceDependencies;
  private readonly now: () => string;
  private readonly eventPublisher: EventPublisher;

  public constructor(dependencies: MemoryWriteServiceDependencies) {
    this.dependencies = dependencies;
    this.now = dependencies.now;
    this.eventPublisher = bindEventPublisher({
      eventLogRepo: dependencies.eventLogRepo,
      runtimeNotifier: dependencies.runtimeNotifier,
      purpose: "MemoryService"
    });
  }

  public async create(input: MemoryEntryInput): Promise<Readonly<MemoryEntry>> {
    const {
      enqueueEnrichment: enrichmentIntent, object_id: reservedObjectId, assertSourceCurrent, persistSourceStatementDependency, ...memoryEntryInput
    } = input;
    const enqueueEnrichment = freezeEnrichmentIntent(enrichmentIntent);
    const memoryEntry = this.buildMemoryEntry(memoryEntryInput, reservedObjectId);
    await this.validateEvidenceRefs(memoryEntry.workspace_id, memoryEntry.evidence_refs);
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

    const { created, event } = this.createRowAtomically(
      memoryEntry, enqueueEnrichment, eventInput, assertSourceCurrent, persistSourceStatementDependency
    );
    await this.dependencies.runtimeNotifier.notifyEntry(event);
    this.scheduleGreenReevaluation(created, event);
    return created;
  }

  private buildMemoryEntry(memoryEntryInput: Omit<MemoryEntryInput,
    "enqueueEnrichment" | "object_id" | "assertSourceCurrent" | "persistSourceStatementDependency"
  >, reservedObjectId: string | undefined): MemoryEntry {
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
    return parseMemoryEntry({
      ...memoryEntryInput,
      object_id: reservedObjectId ?? this.dependencies.generateObjectId(),
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
  }

  private scheduleGreenReevaluation(created: Readonly<MemoryEntry>, event: EventLogEntry): void {
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
  }

  // invariant: production create commits audit + memory row + optional
  // Garden intent (and enrich_pending marker when still wired) in one
  // transaction, EventLog-first. Acknowledgment is durable source, not enriched.
  private createRowAtomically(
    memoryEntry: Readonly<MemoryEntry>,
    enqueueEnrichment: MemoryEntryInput["enqueueEnrichment"],
    createdEventInput: Omit<EventLogEntry, "event_id" | "created_at" | "revision">,
    assertSourceCurrent?: () => void,
    persistSourceStatementDependency?: () => void
  ): {
    readonly created: Readonly<MemoryEntry>;
    readonly event: EventLogEntry;
  } {
    const createWithinTransaction = this.dependencies.memoryEntryRepo.createWithinTransaction;
    if (createWithinTransaction === undefined) {
      throw new CoreError("CONFLICT", "Memory create transaction port is not available", {
        subCode: "PORT_UNAVAILABLE"
      });
    }

    this.requireEnrichmentPorts(enqueueEnrichment);

    let event: EventLogEntry | undefined;
    const created = createWithinTransaction.call(this.dependencies.memoryEntryRepo, memoryEntry, {
      beforeCreate: () => {
        assertSourceCurrent?.();
        event = appendMemoryEventLogSynchronously(
          this.dependencies.eventLogRepo, createdEventInput,
          "Memory create transaction requires a synchronous EventLog append port."
        );
      },
      afterCreate: () => {
        if (event === undefined) {
          throw new CoreError("CONFLICT", "Memory create transaction did not append its audit event.");
        }
        persistSourceStatementDependency?.();
        this.persistEnrichmentIntent(memoryEntry.workspace_id, memoryEntry.object_id, event.revision, enqueueEnrichment, memoryEntry.created_at);
        this.dependencies.objectKeyWriter?.materializeForMemory(memoryEntry);
      }
    });

    if (event === undefined) {
      throw new CoreError("CONFLICT", "Memory create transaction did not append its audit event.");
    }

    return { created, event };
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
    reason: string,
    enqueueEnrichment?: MemoryEntryInput["enqueueEnrichment"]
  ): Promise<Readonly<MemoryEntry>> {
    return await this.updateInternal({ objectId, workspaceId, fields, reason, enqueueEnrichment });
  }

  public async validateUpdate(objectId: string, fields: MemoryEntryUpdateFields): Promise<void> {
    await this.loadMemoryForUpdate(parseObjectId(objectId), parseUpdateFields(fields));
  }

  private async loadMemoryForUpdate(
    objectId: string, fields: MemoryEntryUpdateFields, workspaceId?: string
  ): Promise<Readonly<MemoryEntry>> {
    const existing = await this.dependencies.memoryEntryRepo.findById(objectId);
    if (existing === null || (workspaceId !== undefined && existing.workspace_id !== workspaceId)) {
      throw new CoreError("NOT_FOUND", "Memory entry not found");
    }

    if (fields.evidence_refs !== undefined) {
      await this.validateEvidenceRefs(existing.workspace_id, fields.evidence_refs);
    }

    if (existing.lifecycle_state === "archived") {
      throw new CoreError("VALIDATION", "Memory entry is archived and cannot be updated");
    }
    rejectFrozenObservationConfidence(existing, fields);
    return existing;
  }

  private async updateInternal(input: {
    readonly objectId: string;
    readonly workspaceId?: string;
    readonly fields: MemoryEntryUpdateFields;
    readonly reason: string;
    readonly enqueueEnrichment?: MemoryEntryInput["enqueueEnrichment"];
  }): Promise<Readonly<MemoryEntry>> {
    const parsedObjectId = parseObjectId(input.objectId);
    const parsedWorkspaceId =
      input.workspaceId === undefined ? undefined : parseNonEmptyString(input.workspaceId, "workspaceId");
    const parsedReason = parseReason(input.reason);
    const parsedFields = parseUpdateFields(input.fields);
    const enqueueEnrichment = freezeEnrichmentIntent(input.enqueueEnrichment);

    const existing = await this.loadMemoryForUpdate(parsedObjectId, parsedFields, parsedWorkspaceId);
    const { updated, event } = this.updateRowAtomically(
      parsedObjectId,
      { ...parsedFields, updated_at: this.now() },
      memoryUpdatedEvent(existing, parsedFields, parsedReason),
      parsedWorkspaceId,
      enqueueEnrichment
    );
    await this.eventPublisher.propagateCommitted([event]);
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

  private updateRowAtomically(
    objectId: string,
    repoFields: MemoryEntryRepoUpdateFields,
    eventInput: Omit<EventLogEntry, "event_id" | "created_at" | "revision">,
    workspaceId: string | undefined,
    enqueueEnrichment: MemoryEntryInput["enqueueEnrichment"]
  ): { readonly updated: Readonly<MemoryEntry>; readonly event: EventLogEntry } {
    const update = this.dependencies.memoryEntryRepo.updateWithinTransaction;
    if (update === undefined) {
      throw new CoreError("CONFLICT", "Memory update transaction port is not available", {
        subCode: "PORT_UNAVAILABLE"
      });
    }
    this.requireEnrichmentPorts(enqueueEnrichment);
    let event: EventLogEntry | undefined;
    const updated = update.call(this.dependencies.memoryEntryRepo, objectId, repoFields, {
      beforeUpdate: () => {
        event = appendMemoryEventLogSynchronously(
          this.dependencies.eventLogRepo, eventInput,
          "Memory update transaction requires a synchronous EventLog append port."
        );
      },
      afterUpdate: (row) => {
        if (event === undefined) {
          throw new CoreError("CONFLICT", "Memory update transaction did not append its audit event.");
        }
        this.persistEnrichmentIntent(
          row.workspace_id, row.object_id, event.revision, enqueueEnrichment, repoFields.updated_at ?? event.created_at
        );
        this.dependencies.objectKeyWriter?.materializeForMemory(row);
      }
    }, workspaceId);
    if (event === undefined) {
      throw new CoreError("CONFLICT", "Memory update transaction did not append its audit event.");
    }
    return { updated, event };
  }

  private async validateEvidenceRefs(workspaceId: string, evidenceRefs: readonly string[]): Promise<void> {
    if (evidenceRefs.length === 0) {
      return;
    }

    const distinctEvidenceRefs = [...new Set(evidenceRefs)];
    const findByIds = this.dependencies.evidenceService.findByIds;
    if (findByIds !== undefined) {
      const evidence = await findByIds.call(this.dependencies.evidenceService, workspaceId, distinctEvidenceRefs);
      const foundEvidenceRefs = new Set(evidence.filter((entry) => entry.lifecycle_state !== "tombstone").map((entry) => entry.object_id));
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

    const firstMissing = results.find(
      (result) => result.evidence === null || result.evidence.workspace_id !== workspaceId ||
        result.evidence.lifecycle_state === "tombstone"
    );

    if (firstMissing !== undefined) {
      throw new CoreError("VALIDATION", `Evidence reference not found: ${firstMissing.evidenceRef}`);
    }
  }

  private requireEnrichmentPorts(enqueueEnrichment: MemoryEntryInput["enqueueEnrichment"]): void {
    if (
      enqueueEnrichment !== undefined &&
      this.dependencies.gardenIntentPort === undefined &&
      this.dependencies.enrichPendingWriter === undefined
    ) {
      throw new CoreError(
        "CONFLICT",
        "Atomic enrichment enqueue requested but no Garden intent or enrich-pending writer is wired."
      );
    }
  }

  private persistEnrichmentIntent(
    workspaceId: string,
    sourceObjectId: string,
    sourceRevision: number,
    enqueueEnrichment: MemoryEntryInput["enqueueEnrichment"],
    createdAt: string
  ): void {
    if (enqueueEnrichment === undefined) {
      return;
    }
    if (this.dependencies.gardenIntentPort !== undefined) {
      try {
        admitSourceEnrichmentIntent(this.dependencies.gardenIntentPort, {
          workspaceId,
          sourceObjectId,
          sourceRevision,
          enrichmentContract: SOURCE_ENRICHMENT_CONTRACT,
          runId: enqueueEnrichment.runId,
          createdAt
        });
        return;
      } catch (error) {
        if (
          !isSourceEnrichmentQueueBackpressure(error) ||
          this.dependencies.enrichPendingWriter === undefined
        ) {
          throw error;
        }
      }
    }
    this.dependencies.enrichPendingWriter?.enqueue({
      workspaceId,
      memoryId: sourceObjectId,
      runId: enqueueEnrichment.runId,
      sourceSignalId: enqueueEnrichment.sourceSignalId
    });
  }
}

function memoryUpdatedEvent(
  memory: Readonly<MemoryEntry>, fields: MemoryEntryUpdateFields, reason: string
): Omit<EventLogEntry, "event_id" | "created_at" | "revision"> {
  return {
    event_type: MemoryGovernanceEventType.SOUL_MEMORY_UPDATED,
    entity_type: "memory_entry",
    entity_id: memory.object_id,
    workspace_id: memory.workspace_id,
    run_id: memory.run_id,
    caused_by: reason,
    payload_json: SoulMemoryUpdatedPayloadSchema.parse({
      object_id: memory.object_id,
      object_kind: memory.object_kind,
      workspace_id: memory.workspace_id,
      run_id: memory.run_id,
      updated_fields: toUpdatedFieldNames(fields)
    })
  };
}

function rejectFrozenObservationConfidence(
  existing: MemoryEntry,
  fields: MemoryEntryUpdateFields
): void {
  if (fields.confidence === undefined) return;
  if (resolveMemoryDynamicsPolicy(existing.dimension, existing.formation_kind).confidence !== null) {
    return;
  }
  throw new CoreError("VALIDATION", "observation confidence cannot be mutated");
}

function freezeEnrichmentIntent(
  intent: MemoryEntryInput["enqueueEnrichment"]
): MemoryEntryInput["enqueueEnrichment"] {
  if (intent === undefined) {
    return undefined;
  }
  return Object.freeze({
    runId: intent.runId,
    sourceSignalId: intent.sourceSignalId
  });
}
