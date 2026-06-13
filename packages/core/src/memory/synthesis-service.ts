import { randomUUID } from "node:crypto";
import {
  MemoryGovernanceEventType,
  SoulSynthesisCreatedPayloadSchema,
  SoulSynthesisStatusChangedPayloadSchema,
  SynthesisCapsuleSchema,
  SynthesisStatus,
  SynthesisStatusSchema,
  isValidSynthesisTransition,
  TransitionCausedBySchema,
  type EventLogEntry,
  type SynthesisCapsule,
  type SynthesisStatus as SynthesisStatusType,
  type TransitionCausedBy as TransitionCausedByType
} from "@do-soul/alaya-protocol";
import { CoreError } from "../shared/errors.js";
import { parseObjectId } from "../shared/validators.js";

export type SynthesisCapsuleInput = Omit<
  SynthesisCapsule,
  | "object_id"
  | "object_kind"
  | "schema_version"
  | "lifecycle_state"
  | "created_at"
  | "updated_at"
  | "synthesis_status"
>;

export interface SynthesisServiceEventLogRepoPort {
  append(event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">): EventLogEntry | Promise<EventLogEntry>;
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
}

export interface SynthesisServiceEvidenceServicePort {
  findById(objectId: string): Promise<unknown | null>;
}

export interface SynthesisServiceMemoryServicePort {
  findById(objectId: string): Promise<unknown | null>;
}

export interface SynthesisRuntimeNotifier {
  notifyEntry(entry: EventLogEntry): void | Promise<void>;
}

export interface SynthesisServiceDependencies {
  readonly synthesisCapsuleRepo: SynthesisServiceSynthesisCapsuleRepoPort;
  readonly evidenceService: SynthesisServiceEvidenceServicePort;
  readonly memoryService: SynthesisServiceMemoryServicePort;
  readonly eventLogRepo: SynthesisServiceEventLogRepoPort;
  readonly runtimeNotifier: SynthesisRuntimeNotifier;
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
      synthesis_status: SynthesisStatus.WORKING
    });

    // EventLog-first: reference validation runs before any EventLog write.
    await Promise.all([
      this.validateEvidenceRefs(synthesis.evidence_refs),
      this.validateSourceMemoryRefs(synthesis.source_memory_refs)
    ]);
    const event = await this.dependencies.eventLogRepo.append({
      event_type: MemoryGovernanceEventType.SOUL_SYNTHESIS_CREATED,
      entity_type: "synthesis_capsule",
      entity_id: synthesis.object_id,
      workspace_id: synthesis.workspace_id,
      run_id: synthesis.run_id,
      caused_by: synthesis.created_by,
      payload_json: SoulSynthesisCreatedPayloadSchema.parse({
        object_id: synthesis.object_id,
        object_kind: synthesis.object_kind,
        workspace_id: synthesis.workspace_id,
        run_id: synthesis.run_id
      })
    });

    const created = await this.dependencies.synthesisCapsuleRepo.create(synthesis);
    await this.dependencies.runtimeNotifier.notifyEntry(event);
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
    const event = await this.dependencies.eventLogRepo.append({
      event_type: MemoryGovernanceEventType.SOUL_SYNTHESIS_STATUS_CHANGED,
      entity_type: "synthesis_capsule",
      entity_id: existing.object_id,
      workspace_id: existing.workspace_id,
      run_id: existing.run_id,
      caused_by: parsedCausedBy,
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
    await this.dependencies.runtimeNotifier.notifyEntry(event);
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

function ensureValidStatusTransition(from: SynthesisStatusType, to: SynthesisStatusType): void {
  if (from === to) {
    throw new CoreError("VALIDATION", "Synthesis status transition must change state");
  }

  if (!isValidSynthesisTransition(from, to)) {
    throw new CoreError("VALIDATION", `Invalid synthesis status transition: ${from} -> ${to}`);
  }
}
