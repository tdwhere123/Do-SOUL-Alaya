import { randomUUID } from "node:crypto";
import {
  FactualPolicyConditionSchema,
  MemoryDimension,
  MemoryEntrySchema,
  ObjectLifecycleStateSchema,
  MemoryGovernanceEventType,
  SoulMemoryArchivedPayloadSchema,
  SoulMemoryCreatedPayloadSchema,
  SoulMemoryStateChangedPayloadSchema,
  SoulMemoryUpdatedPayloadSchema,
  StorageTier,
  StorageTierSchema,
  TransitionCausedBySchema,
  isValidLifecycleTransition,
  type EventLogEntry,
  type FactualPolicyCondition,
  type MemoryEntry,
  type MemoryEntryMutableFields,
  type MemoryEntryRepoUpdateFields as ProtocolMemoryEntryRepoUpdateFields,
  type ScopeClass,
  type TransitionCausedBy
} from "@do-soul/alaya-protocol";
import { CoreError } from "./errors.js";
import { parseObjectId } from "./shared/validators.js";

export type MemoryEntryInput = Omit<
  MemoryEntry,
  | "object_id"
  | "object_kind"
  | "schema_version"
  | "lifecycle_state"
  | "created_at"
  | "updated_at"
  | "storage_tier"
  | "activation_score"
  | "retention_score"
  | "manifestation_state"
  | "retention_state"
  | "decay_profile"
  | "confidence"
  | "last_used_at"
  | "last_hit_at"
  | "reinforcement_count"
  | "contradiction_count"
  | "superseded_by"
> & {
  readonly storage_tier?: MemoryEntry["storage_tier"];
};

export type MemoryEntryUpdateFields = MemoryEntryMutableFields;
export type MemoryEntryRepoUpdateFields = ProtocolMemoryEntryRepoUpdateFields;

export interface MemoryServiceEventLogRepoPort {
  append(event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">): EventLogEntry | Promise<EventLogEntry>;
  queryByEntity(entityType: string, entityId: string): Promise<readonly EventLogEntry[]>;
}

export interface MemoryServiceMemoryEntryRepoPort {
  create(entry: MemoryEntry): Promise<Readonly<MemoryEntry>>;
  findById(objectId: string): Promise<Readonly<MemoryEntry> | null>;
  findByWorkspaceId(
    workspaceId: string,
    tier?: MemoryEntry["storage_tier"]
  ): Promise<readonly Readonly<MemoryEntry>[]>;
  findByRunId(runId: string): Promise<readonly Readonly<MemoryEntry>[]>;
  findByDimension(
    workspaceId: string,
    dimension: MemoryEntry["dimension"]
  ): Promise<readonly Readonly<MemoryEntry>[]>;
  findByScopeClass(
    workspaceId: string,
    scopeClass: ScopeClass
  ): Promise<readonly Readonly<MemoryEntry>[]>;
  update(objectId: string, fields: MemoryEntryRepoUpdateFields): Promise<Readonly<MemoryEntry>>;
  transitionLifecycle?(
    objectId: string,
    lifecycleState: MemoryEntry["lifecycle_state"],
    updatedAt: string
  ): Promise<Readonly<MemoryEntry>>;
  archive(objectId: string, updatedAt: string): Promise<Readonly<MemoryEntry>>;
  hardDeleteTombstoned?(objectId: string): Promise<void>;
}

export interface MemoryServiceEvidenceServicePort {
  findById(objectId: string): Promise<unknown | null>;
}

export interface MemoryRuntimeNotifier {
  notifyEntry(entry: EventLogEntry): void | Promise<void>;
}

export interface MemoryServiceDynamicsPort {
  assignInitialDynamics(params: {
    readonly dimension: MemoryEntry["dimension"];
    readonly formation_kind: MemoryEntry["formation_kind"];
    readonly created_at: string;
  }): {
    readonly decay_profile: MemoryEntry["decay_profile"];
    readonly confidence: number;
    readonly retention_score: number;
    readonly retention_state: MemoryEntry["retention_state"];
    readonly activation_score: number;
    readonly manifestation_state: NonNullable<MemoryEntry["manifestation_state"]>;
    readonly reinforcement_count: number;
    readonly contradiction_count: number;
  };
}

export interface MemoryServiceGreenPort {
  reevaluate(params: {
    readonly targetObjectId: string;
    readonly workspaceId: string;
  }): Promise<unknown>;
}

export interface MemoryServiceDependencies {
  readonly memoryEntryRepo: MemoryServiceMemoryEntryRepoPort;
  readonly evidenceService: MemoryServiceEvidenceServicePort;
  readonly eventLogRepo: MemoryServiceEventLogRepoPort;
  readonly runtimeNotifier: MemoryRuntimeNotifier;
  readonly dynamicsService?: MemoryServiceDynamicsPort;
  readonly greenService?: MemoryServiceGreenPort;
  readonly generateObjectId?: () => string;
  readonly now?: () => string;
}

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
    const event = await this.dependencies.eventLogRepo.append({
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
    });

    const created = await this.dependencies.memoryEntryRepo.create(memoryEntry);
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

  public async update(
    objectId: string,
    fields: MemoryEntryUpdateFields,
    reason: string
  ): Promise<Readonly<MemoryEntry>> {
    const parsedObjectId = parseObjectId(objectId);
    const parsedReason = parseReason(reason);
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

    const updatedFields = toUpdatedFieldNames(parsedFields);
    const occurredAt = this.now();
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

    const updated = await this.dependencies.memoryEntryRepo.update(parsedObjectId, {
      ...parsedFields,
      updated_at: occurredAt
    });

    await this.dependencies.runtimeNotifier.notifyEntry(event);
    return updated;
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
    const archivedEvent = await this.dependencies.eventLogRepo.append({
      event_type: MemoryGovernanceEventType.SOUL_MEMORY_ARCHIVED,
      entity_type: "memory_entry",
      entity_id: existing.object_id,
      workspace_id: existing.workspace_id,
      run_id: existing.run_id,
      caused_by: parsedCausedBy,
      payload_json: SoulMemoryArchivedPayloadSchema.parse(transitionPayload)
    });

    const stateChangedEvent = await this.dependencies.eventLogRepo.append({
      event_type: MemoryGovernanceEventType.SOUL_MEMORY_STATE_CHANGED,
      entity_type: "memory_entry",
      entity_id: existing.object_id,
      workspace_id: existing.workspace_id,
      run_id: existing.run_id,
      caused_by: parsedCausedBy,
      payload_json: SoulMemoryStateChangedPayloadSchema.parse(transitionPayload)
    });

    const archived = await this.dependencies.memoryEntryRepo.archive(parsedObjectId, occurredAt);
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
    const event = await this.dependencies.eventLogRepo.append({
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
    });

    const updated = await transitionLifecycle(parsedObjectId, parsedNextState, occurredAt);

    await this.dependencies.runtimeNotifier.notifyEntry(event);
    return updated;
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
    const event = await this.dependencies.eventLogRepo.append({
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
    });

    await hardDeleteTombstoned(parsedObjectId);
    await this.dependencies.runtimeNotifier.notifyEntry(event);
  }

  public findById(objectId: string): Promise<Readonly<MemoryEntry> | null> {
    return this.dependencies.memoryEntryRepo.findById(objectId);
  }

  /**
   * Workspace-scoped lookup. Per invariants §29 (Default Scope) + §30
   * (Fix at Source), MCP/CLI surfaces MUST use this method instead of
   * `findById` so cross-workspace leak (p5-system-review-r1 MR-B02 /
   * Round 2 F-r2-002) cannot recur at any handler boundary.
   * Returns null when the object exists in a different workspace —
   * indistinguishable from "not found", which is the intended privacy
   * surface.
   */
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

  public findByWorkspaceId(workspaceId: string): Promise<readonly Readonly<MemoryEntry>[]> {
    return this.dependencies.memoryEntryRepo.findByWorkspaceId(workspaceId);
  }

  public findByRunId(runId: string): Promise<readonly Readonly<MemoryEntry>[]> {
    return this.dependencies.memoryEntryRepo.findByRunId(runId);
  }

  public findByDimension(
    workspaceId: string,
    dimension: MemoryEntry["dimension"]
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    return this.dependencies.memoryEntryRepo.findByDimension(workspaceId, dimension);
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

function parseMemoryEntry(value: MemoryEntry): MemoryEntry {
  try {
    return MemoryEntrySchema.parse(value);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid memory entry payload", { cause: error });
  }
}

function parseFactualPolicyCondition(condition: FactualPolicyCondition): FactualPolicyCondition {
  try {
    return FactualPolicyConditionSchema.parse(condition);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid factual policy condition", { cause: error });
  }
}

function parseStorageTier(value: MemoryEntry["storage_tier"]): MemoryEntry["storage_tier"] {
  try {
    return StorageTierSchema.parse(value);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid storage tier", { cause: error });
  }
}

function parseLifecycleState(value: MemoryEntry["lifecycle_state"]): MemoryEntry["lifecycle_state"] {
  try {
    return ObjectLifecycleStateSchema.parse(value);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid lifecycle state", { cause: error });
  }
}

function parseReason(value: string): string {
  if (value.trim().length === 0) {
    throw new CoreError("VALIDATION", "Reason is required");
  }

  return value;
}

function parseTransitionCausedBy(value: TransitionCausedBy): TransitionCausedBy {
  try {
    return TransitionCausedBySchema.parse(value);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid transition caused_by", { cause: error });
  }
}

function parseUpdateFields(fields: MemoryEntryUpdateFields): MemoryEntryUpdateFields {
  const parsed: MemoryEntryUpdateFields = {
    content: fields.content,
    domain_tags: fields.domain_tags,
    evidence_refs: fields.evidence_refs,
    storage_tier: fields.storage_tier
  };

  if (
    parsed.content === undefined &&
    parsed.domain_tags === undefined &&
    parsed.evidence_refs === undefined &&
    parsed.storage_tier === undefined
  ) {
    throw new CoreError("VALIDATION", "At least one field is required for update");
  }

  if (parsed.content !== undefined && parsed.content.trim().length === 0) {
    throw new CoreError("VALIDATION", "Memory content cannot be empty");
  }

  if (parsed.domain_tags !== undefined) {
    assertStringArray(parsed.domain_tags, "domain_tags");
  }

  if (parsed.evidence_refs !== undefined) {
    assertStringArray(parsed.evidence_refs, "evidence_refs");
  }

  const parsedStorageTier =
    parsed.storage_tier === undefined ? undefined : parseStorageTier(parsed.storage_tier);

  return {
    ...parsed,
    storage_tier: parsedStorageTier
  };
}

function assertStringArray(value: readonly string[], field: "domain_tags" | "evidence_refs"): void {
  for (const item of value) {
    if (item.trim().length === 0) {
      throw new CoreError("VALIDATION", `${field} cannot contain empty items`);
    }
  }
}

function toUpdatedFieldNames(fields: MemoryEntryUpdateFields): string[] {
  const updatedFields: string[] = [];

  if (fields.content !== undefined) {
    updatedFields.push("content");
  }
  if (fields.domain_tags !== undefined) {
    updatedFields.push("domain_tags");
  }
  if (fields.evidence_refs !== undefined) {
    updatedFields.push("evidence_refs");
  }
  if (fields.storage_tier !== undefined) {
    updatedFields.push("storage_tier");
  }

  return updatedFields;
}

function ensureAllowedLifecycleTransition(
  from: MemoryEntry["lifecycle_state"],
  to: MemoryEntry["lifecycle_state"]
): void {
  if (!isValidLifecycleTransition(from, to)) {
    throw new CoreError("VALIDATION", `Invalid memory lifecycle transition: ${from} -> ${to}`);
  }
}
