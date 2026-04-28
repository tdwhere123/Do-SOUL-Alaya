import { randomUUID } from "node:crypto";
import {
  Phase1BEventType,
  PromotionState,
  PromotionStateSchema,
  SoulSynthesisCreatedPayloadSchema,
  SoulSynthesisPromotedPayloadSchema,
  SoulSynthesisStatusChangedPayloadSchema,
  SynthesisCapsuleSchema,
  SynthesisStatus,
  SynthesisStatusSchema,
  isValidSynthesisTransition,
  TransitionCausedBy,
  TransitionCausedBySchema,
  type EventLogEntry,
  type PromotionState as PromotionStateType,
  type SynthesisCapsule,
  type SynthesisStatus as SynthesisStatusType,
  type TransitionCausedBy as TransitionCausedByType
} from "@do-what/protocol";
import { CoreError } from "./errors.js";
import { parseObjectId } from "./shared/validators.js";

export type SynthesisCapsuleInput = Omit<
  SynthesisCapsule,
  | "object_id"
  | "object_kind"
  | "schema_version"
  | "lifecycle_state"
  | "created_at"
  | "updated_at"
  | "authority_round_count"
  | "cooldown_until"
  | "promotion_state"
  | "synthesis_status"
>;

export interface SynthesisServiceEventLogRepoPort {
  append(event: Omit<EventLogEntry, "event_id" | "created_at">): Promise<EventLogEntry>;
  queryByEntity(entityType: string, entityId: string): Promise<readonly EventLogEntry[]>;
}

export interface SynthesisServiceSynthesisCapsuleRepoPort {
  create(capsule: SynthesisCapsule): Promise<Readonly<SynthesisCapsule>>;
  findById(objectId: string): Promise<Readonly<SynthesisCapsule> | null>;
  findByWorkspaceId(workspaceId: string): Promise<readonly Readonly<SynthesisCapsule>[]>;
  findByTopicKey(workspaceId: string, topicKey: string): Promise<readonly Readonly<SynthesisCapsule>[]>;
  updateStatus(
    objectId: string,
    status: SynthesisStatusType,
    updatedAt: string
  ): Promise<Readonly<SynthesisCapsule>>;
  updatePromotionState(
    objectId: string,
    state: SynthesisCapsule["promotion_state"],
    updatedAt: string
  ): Promise<Readonly<SynthesisCapsule>>;
  incrementAuthorityRound(objectId: string, updatedAt: string): Promise<Readonly<SynthesisCapsule>>;
  setCooldownUntil(
    objectId: string,
    cooldownUntil: string | null,
    updatedAt: string
  ): Promise<Readonly<SynthesisCapsule>>;
}

export interface SynthesisServiceEvidenceServicePort {
  findById(objectId: string): Promise<unknown | null>;
}

export interface SynthesisServiceMemoryServicePort {
  findById(objectId: string): Promise<unknown | null>;
}

export interface SynthesisSseBroadcaster {
  broadcastEntry(entry: EventLogEntry): void | Promise<void>;
}

export interface SynthesisServiceDependencies {
  readonly synthesisCapsuleRepo: SynthesisServiceSynthesisCapsuleRepoPort;
  readonly evidenceService: SynthesisServiceEvidenceServicePort;
  readonly memoryService: SynthesisServiceMemoryServicePort;
  readonly eventLogRepo: SynthesisServiceEventLogRepoPort;
  readonly sseBroadcaster: SynthesisSseBroadcaster;
  readonly generateObjectId?: () => string;
  readonly now?: () => string;
}

export class SynthesisService {
  private readonly generateObjectId: () => string;
  private readonly now: () => string;

  public constructor(private readonly dependencies: SynthesisServiceDependencies) {
    this.generateObjectId = dependencies.generateObjectId ?? (() => randomUUID());
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  public async create(input: SynthesisCapsuleInput): Promise<Readonly<SynthesisCapsule>> {
    const timestamp = this.now();
    const synthesis = parseSynthesisCapsule({
      ...input,
      object_id: this.generateObjectId(),
      object_kind: "synthesis_capsule",
      schema_version: 1,
      lifecycle_state: "active",
      created_at: timestamp,
      updated_at: timestamp,
      authority_round_count: 0,
      cooldown_until: null,
      promotion_state: PromotionState.NONE,
      synthesis_status: SynthesisStatus.WORKING
    });

    // Validate references before any EventLog write to keep EventLog-first semantics intact.
    await Promise.all([
      this.validateEvidenceRefs(synthesis.evidence_refs),
      this.validateSourceMemoryRefs(synthesis.source_memory_refs)
    ]);

    const revision = await this.getNextRevision("synthesis_capsule", synthesis.object_id);
    const event = await this.dependencies.eventLogRepo.append({
      event_type: Phase1BEventType.SOUL_SYNTHESIS_CREATED,
      entity_type: "synthesis_capsule",
      entity_id: synthesis.object_id,
      workspace_id: synthesis.workspace_id,
      run_id: synthesis.run_id,
      caused_by: synthesis.created_by,
      revision,
      payload_json: SoulSynthesisCreatedPayloadSchema.parse({
        object_id: synthesis.object_id,
        object_kind: synthesis.object_kind,
        workspace_id: synthesis.workspace_id,
        run_id: synthesis.run_id
      })
    });

    const created = await this.dependencies.synthesisCapsuleRepo.create(synthesis);
    await this.dependencies.sseBroadcaster.broadcastEntry(event);
    return created;
  }

  public async transitionStatus(
    objectId: string,
    newStatus: SynthesisStatusType,
    reason: string,
    causedBy: TransitionCausedByType
  ): Promise<Readonly<SynthesisCapsule>> {
    const parsedObjectId = parseObjectId(objectId);
    const parsedStatus = parseSynthesisStatus(newStatus);
    const parsedReason = parseReason(reason);
    const parsedCausedBy = parseTransitionCausedBy(causedBy);

    const existing = await this.dependencies.synthesisCapsuleRepo.findById(parsedObjectId);

    if (existing === null) {
      throw new CoreError("NOT_FOUND", "Synthesis capsule not found");
    }

    ensureValidStatusTransition(existing.synthesis_status, parsedStatus);

    const occurredAt = this.now();
    const revision = await this.getNextRevision("synthesis_capsule", existing.object_id);
    const event = await this.dependencies.eventLogRepo.append({
      event_type: Phase1BEventType.SOUL_SYNTHESIS_STATUS_CHANGED,
      entity_type: "synthesis_capsule",
      entity_id: existing.object_id,
      workspace_id: existing.workspace_id,
      run_id: existing.run_id,
      caused_by: parsedCausedBy,
      revision,
      payload_json: SoulSynthesisStatusChangedPayloadSchema.parse({
        object_id: existing.object_id,
        object_kind: existing.object_kind,
        workspace_id: existing.workspace_id,
        run_id: existing.run_id,
        from_state: existing.synthesis_status,
        to_state: parsedStatus,
        reason_code: parsedReason,
        caused_by: parsedCausedBy,
        evidence_refs: null,
        occurred_at: occurredAt
      })
    });

    const updated = await this.dependencies.synthesisCapsuleRepo.updateStatus(
      parsedObjectId,
      parsedStatus,
      occurredAt
    );
    await this.dependencies.sseBroadcaster.broadcastEntry(event);
    return updated;
  }

  public async incrementAuthority(objectId: string): Promise<Readonly<SynthesisCapsule>> {
    const parsedObjectId = parseObjectId(objectId);
    const existing = await this.dependencies.synthesisCapsuleRepo.findById(parsedObjectId);

    if (existing === null) {
      throw new CoreError("NOT_FOUND", "Synthesis capsule not found");
    }

    return await this.dependencies.synthesisCapsuleRepo.incrementAuthorityRound(
      parsedObjectId,
      this.now()
    );
  }

  public async requestPromotion(objectId: string): Promise<Readonly<SynthesisCapsule>> {
    const parsedObjectId = parseObjectId(objectId);
    const existing = await this.dependencies.synthesisCapsuleRepo.findById(parsedObjectId);

    if (existing === null) {
      throw new CoreError("NOT_FOUND", "Synthesis capsule not found");
    }

    const occurredAt = this.now();
    ensurePromotionRequestAllowed(existing, occurredAt);

    const revision = await this.getNextRevision("synthesis_capsule", existing.object_id);
    const event = await this.dependencies.eventLogRepo.append({
      event_type: Phase1BEventType.SOUL_SYNTHESIS_PROMOTED,
      entity_type: "synthesis_capsule",
      entity_id: existing.object_id,
      workspace_id: existing.workspace_id,
      run_id: existing.run_id,
      caused_by: TransitionCausedBy.SYSTEM,
      revision,
      payload_json: SoulSynthesisPromotedPayloadSchema.parse({
        object_id: existing.object_id,
        object_kind: existing.object_kind,
        workspace_id: existing.workspace_id,
        run_id: existing.run_id,
        from_state: existing.promotion_state,
        to_state: PromotionState.CANDIDATE,
        reason_code: "promotion_requested",
        caused_by: TransitionCausedBy.SYSTEM,
        evidence_refs: null,
        occurred_at: occurredAt
      })
    });

    const updated = await this.dependencies.synthesisCapsuleRepo.updatePromotionState(
      existing.object_id,
      PromotionState.CANDIDATE,
      occurredAt
    );
    await this.dependencies.sseBroadcaster.broadcastEntry(event);
    return updated;
  }

  public async resolvePromotionDecision(
    objectId: string,
    nextState: Extract<PromotionStateType, "promoted" | "rejected">,
    reason: string,
    causedBy: TransitionCausedByType,
    options: {
      readonly cooldownUntil?: string | null;
      // When provided, SSE broadcast is deferred: the event is pushed here instead
      // of being broadcast immediately, allowing the caller to broadcast in order.
      readonly deferredBroadcastEvents?: EventLogEntry[];
    } = {}
  ): Promise<Readonly<SynthesisCapsule>> {
    const parsedObjectId = parseObjectId(objectId);
    const parsedNextState = parsePromotionDecision(nextState);
    const parsedReason = parseReason(reason);
    const parsedCausedBy = parseTransitionCausedBy(causedBy);
    const existing = await this.dependencies.synthesisCapsuleRepo.findById(parsedObjectId);

    if (existing === null) {
      throw new CoreError("NOT_FOUND", "Synthesis capsule not found");
    }

    if (existing.promotion_state !== PromotionState.CANDIDATE) {
      throw new CoreError(
        "VALIDATION",
        `Synthesis promotion decision requires candidate state, got ${existing.promotion_state}`
      );
    }

    const occurredAt = this.now();
    const revision = await this.getNextRevision("synthesis_capsule", existing.object_id);
    const event = await this.dependencies.eventLogRepo.append({
      event_type: Phase1BEventType.SOUL_SYNTHESIS_PROMOTED,
      entity_type: "synthesis_capsule",
      entity_id: existing.object_id,
      workspace_id: existing.workspace_id,
      run_id: existing.run_id,
      caused_by: parsedCausedBy,
      revision,
      payload_json: SoulSynthesisPromotedPayloadSchema.parse({
        object_id: existing.object_id,
        object_kind: existing.object_kind,
        workspace_id: existing.workspace_id,
        run_id: existing.run_id,
        from_state: existing.promotion_state,
        to_state: parsedNextState,
        reason_code: parsedReason,
        caused_by: parsedCausedBy,
        evidence_refs: null,
        occurred_at: occurredAt
      })
    });

    let updated = await this.dependencies.synthesisCapsuleRepo.updatePromotionState(
      existing.object_id,
      parsedNextState,
      occurredAt
    );

    if (parsedNextState === PromotionState.REJECTED) {
      const cooldownUntil =
        options.cooldownUntil === undefined
          ? updated.cooldown_until
          : parseCooldownUntil(options.cooldownUntil);
      updated = await this.dependencies.synthesisCapsuleRepo.setCooldownUntil(
        existing.object_id,
        cooldownUntil,
        occurredAt
      );
    }

    if (parsedNextState === PromotionState.PROMOTED && updated.cooldown_until !== null) {
      updated = await this.dependencies.synthesisCapsuleRepo.setCooldownUntil(
        existing.object_id,
        null,
        occurredAt
      );
    }

    if (options.deferredBroadcastEvents !== undefined) {
      // Caller requested deferred broadcast — push event to the collector so it
      // can be broadcast in EventLog order alongside sibling events.
      options.deferredBroadcastEvents.push(event);
    } else {
      await this.dependencies.sseBroadcaster.broadcastEntry(event);
    }

    return updated;
  }
  public findById(objectId: string): Promise<Readonly<SynthesisCapsule> | null> {
    return this.dependencies.synthesisCapsuleRepo.findById(objectId);
  }

  public findByWorkspaceId(workspaceId: string): Promise<readonly Readonly<SynthesisCapsule>[]> {
    return this.dependencies.synthesisCapsuleRepo.findByWorkspaceId(workspaceId);
  }

  public findByTopicKey(workspaceId: string, topicKey: string): Promise<readonly Readonly<SynthesisCapsule>[]> {
    return this.dependencies.synthesisCapsuleRepo.findByTopicKey(workspaceId, topicKey);
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

  private async validateSourceMemoryRefs(sourceMemoryRefs: readonly string[]): Promise<void> {
    const results = await Promise.all(
      sourceMemoryRefs.map(async (sourceMemoryRef) => ({
        sourceMemoryRef,
        memory: await this.dependencies.memoryService.findById(sourceMemoryRef)
      }))
    );

    const firstMissing = results.find((result) => result.memory === null);

    if (firstMissing !== undefined) {
      throw new CoreError("VALIDATION", `Source memory reference not found: ${firstMissing.sourceMemoryRef}`);
    }
  }

  private async getNextRevision(entityType: string, entityId: string): Promise<number> {
    const events = await this.dependencies.eventLogRepo.queryByEntity(entityType, entityId);

    if (events.length === 0) {
      return 0;
    }

    const maxRevision = events.reduce((max, event) => Math.max(max, event.revision), 0);
    return maxRevision + 1;
  }
}

function parseSynthesisCapsule(value: SynthesisCapsule): SynthesisCapsule {
  try {
    return SynthesisCapsuleSchema.parse(value);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid synthesis capsule payload", { cause: error });
  }
}

function parseSynthesisStatus(value: SynthesisStatusType): SynthesisStatusType {
  try {
    return SynthesisStatusSchema.parse(value);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid synthesis status", { cause: error });
  }
}

function parseReason(value: string): string {
  if (value.trim().length === 0) {
    throw new CoreError("VALIDATION", "Reason is required");
  }

  return value;
}

function parseTransitionCausedBy(value: TransitionCausedByType): TransitionCausedByType {
  try {
    return TransitionCausedBySchema.parse(value);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid transition caused_by", { cause: error });
  }
}

function parsePromotionDecision(
  value: PromotionStateType
): Extract<PromotionStateType, "promoted" | "rejected"> {
  let parsedState: PromotionStateType;

  try {
    parsedState = PromotionStateSchema.parse(value);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid promotion state", { cause: error });
  }

  if (parsedState !== PromotionState.PROMOTED && parsedState !== PromotionState.REJECTED) {
    throw new CoreError(
      "VALIDATION",
      `Promotion decision must be promoted or rejected, received ${parsedState}`
    );
  }

  return parsedState;
}

function parseCooldownUntil(value: string | null): string | null {
  if (value === null) {
    return null;
  }

  if (value.trim().length === 0) {
    throw new CoreError("VALIDATION", "Cooldown timestamp must not be empty");
  }

  return value;
}
function ensureValidStatusTransition(from: SynthesisStatusType, to: SynthesisStatusType): void {
  if (from === to) {
    throw new CoreError("VALIDATION", "Synthesis status transition must change state");
  }

  if (!isValidSynthesisTransition(from, to)) {
    throw new CoreError("VALIDATION", `Invalid synthesis status transition: ${from} -> ${to}`);
  }
}

function ensurePromotionRequestAllowed(existing: SynthesisCapsule, nowIso: string): void {
  if (existing.cooldown_until !== null) {
    const now = Date.parse(nowIso);
    const cooldownUntil = Date.parse(existing.cooldown_until);

    if (Number.isFinite(now) && Number.isFinite(cooldownUntil) && now < cooldownUntil) {
      throw new CoreError(
        "VALIDATION",
        `Synthesis capsule is in cooldown until ${existing.cooldown_until}`
      );
    }
  }

  if (existing.promotion_state !== PromotionState.NONE && existing.promotion_state !== PromotionState.REJECTED) {
    throw new CoreError("VALIDATION", "Synthesis capsule already has an active promotion state");
  }
}




