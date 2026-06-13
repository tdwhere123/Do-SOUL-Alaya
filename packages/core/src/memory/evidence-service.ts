import { randomUUID } from "node:crypto";
import {
  EvidenceCapsuleSchema,
  EvidenceHealthStateSchema,
  MemoryGovernanceEventType,
  SoulEvidenceCreatedPayloadSchema,
  SoulEvidenceHealthChangedPayloadSchema,
  TransitionCausedBySchema,
  type EvidenceCapsule,
  type EvidenceHealthState,
  type EventLogEntry,
  type TransitionCausedBy
} from "@do-soul/alaya-protocol";
import { CoreError } from "../shared/errors.js";
import { parseObjectId } from "../shared/validators.js";

const evidenceHealthTransitions: Readonly<Record<EvidenceHealthState, readonly EvidenceHealthState[]>> = {
  verified: ["questionable", "degraded", "broken"],
  questionable: ["verified", "degraded", "broken"],
  degraded: ["verified", "questionable", "broken"],
  broken: ["degraded"]
};

export type EvidenceCapsuleInput = Omit<
  EvidenceCapsule,
  "object_id" | "object_kind" | "schema_version" | "lifecycle_state" | "created_at" | "updated_at"
>;

export interface EvidenceServiceEventLogRepoPort {
  append(event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">): EventLogEntry | Promise<EventLogEntry>;
}

export interface EvidenceServiceEvidenceCapsuleRepoPort {
  create(capsule: EvidenceCapsule): Promise<Readonly<EvidenceCapsule>>;
  findById(objectId: string): Promise<Readonly<EvidenceCapsule> | null>;
  findByRunId(runId: string): Promise<readonly Readonly<EvidenceCapsule>[]>;
  findByWorkspaceId(workspaceId: string): Promise<readonly Readonly<EvidenceCapsule>[]>;
  findByHealth(health: EvidenceHealthState): Promise<readonly Readonly<EvidenceCapsule>[]>;
  updateHealth(
    objectId: string,
    health: EvidenceHealthState,
    updatedAt: string
  ): Promise<Readonly<EvidenceCapsule>>;
}

export interface EvidenceRuntimeNotifier {
  notifyEntry(entry: EventLogEntry): void | Promise<void>;
}

// invariant: see also: DynamicsService.emitKarmaEvent — the
// evidence_gain karma kind fires from transitionHealth on the
// questionable -> verified edge so the memory bound to the evidence
// gets a retention bump when the source becomes trustworthy again.
export interface EvidenceServiceKarmaEmitterPort {
  emitKarmaEvent(input: {
    readonly kind: "evidence_gain";
    readonly objectId: string;
    readonly workspaceId: string;
    // evidence promotion fires from transitionHealth with no run
    // context in hand, so this stays unset; the field exists to keep
    // the emitter contract uniform with the run-bearing producers.
    readonly runId?: string | null;
  }): Promise<void>;
}

export interface EvidenceServiceMemoryRefLookupPort {
  findMemoriesByEvidenceRef(
    evidenceObjectId: string,
    workspaceId: string
  ): Promise<readonly { readonly object_id: string }[]>;
}

export interface EvidenceServiceDependencies {
  readonly evidenceCapsuleRepo: EvidenceServiceEvidenceCapsuleRepoPort;
  readonly eventLogRepo: EvidenceServiceEventLogRepoPort;
  readonly runtimeNotifier: EvidenceRuntimeNotifier;
  readonly karmaEmitter?: EvidenceServiceKarmaEmitterPort;
  readonly memoryRefLookup?: EvidenceServiceMemoryRefLookupPort;
  readonly warn?: (message: string, meta: Record<string, unknown>) => void;
  readonly generateObjectId?: () => string;
  readonly now?: () => string;
}

export class EvidenceService {
  private readonly generateObjectId: () => string;
  private readonly now: () => string;

  public constructor(private readonly dependencies: EvidenceServiceDependencies) {
    this.generateObjectId = dependencies.generateObjectId ?? (() => randomUUID());
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  public async create(input: EvidenceCapsuleInput): Promise<Readonly<EvidenceCapsule>> {
    const timestamp = this.now();
    const evidence = parseEvidenceCapsule({
      ...input,
      object_id: this.generateObjectId(),
      object_kind: "evidence_capsule",
      schema_version: 1,
      lifecycle_state: "active",
      created_at: timestamp,
      updated_at: timestamp
    });

    const event = await this.dependencies.eventLogRepo.append({
      event_type: MemoryGovernanceEventType.SOUL_EVIDENCE_CREATED,
      entity_type: "evidence_capsule",
      entity_id: evidence.object_id,
      workspace_id: evidence.workspace_id,
      run_id: evidence.run_id,
      caused_by: evidence.created_by,
      payload_json: SoulEvidenceCreatedPayloadSchema.parse({
        object_id: evidence.object_id,
        object_kind: evidence.object_kind,
        workspace_id: evidence.workspace_id,
        run_id: evidence.run_id
      })
    });

    const created = await this.dependencies.evidenceCapsuleRepo.create(evidence);
    await this.dependencies.runtimeNotifier.notifyEntry(event);
    return created;
  }

  public async transitionHealth(
    objectId: string,
    newHealth: EvidenceHealthState,
    reason: string,
    causedBy: TransitionCausedBy
  ): Promise<Readonly<EvidenceCapsule>> {
    const parsedObjectId = parseObjectId(objectId);
    const parsedHealth = parseEvidenceHealthState(newHealth);
    const parsedReason = parseReason(reason);
    const parsedCausedBy = parseTransitionCausedBy(causedBy);

    const existing = await this.dependencies.evidenceCapsuleRepo.findById(parsedObjectId);

    if (existing === null) {
      throw new CoreError("NOT_FOUND", "Evidence not found");
    }

    ensureValidHealthTransition(existing.evidence_health_state, parsedHealth);

    const occurredAt = this.now();
    const event = await this.dependencies.eventLogRepo.append({
      event_type: MemoryGovernanceEventType.SOUL_EVIDENCE_HEALTH_CHANGED,
      entity_type: "evidence_capsule",
      entity_id: existing.object_id,
      workspace_id: existing.workspace_id,
      run_id: existing.run_id,
      caused_by: parsedCausedBy,
      payload_json: SoulEvidenceHealthChangedPayloadSchema.parse({
        object_id: existing.object_id,
        object_kind: existing.object_kind,
        workspace_id: existing.workspace_id,
        run_id: existing.run_id,
        from_state: existing.evidence_health_state,
        to_state: parsedHealth,
        reason_code: parsedReason,
        caused_by: parsedCausedBy,
        evidence_refs: null,
        occurred_at: occurredAt
      })
    });

    const updated = await this.dependencies.evidenceCapsuleRepo.updateHealth(
      existing.object_id,
      parsedHealth,
      occurredAt
    );

    await this.dependencies.runtimeNotifier.notifyEntry(event);
    await this.emitEvidenceGainIfPromoted({
      fromHealth: existing.evidence_health_state,
      toHealth: parsedHealth,
      evidenceObjectId: updated.object_id,
      workspaceId: updated.workspace_id
    });
    return updated;
  }

  private async emitEvidenceGainIfPromoted(input: {
    readonly fromHealth: EvidenceHealthState;
    readonly toHealth: EvidenceHealthState;
    readonly evidenceObjectId: string;
    readonly workspaceId: string;
  }): Promise<void> {
    if (input.fromHealth !== "questionable" || input.toHealth !== "verified") {
      return;
    }
    const karmaEmitter = this.dependencies.karmaEmitter;
    const memoryRefLookup = this.dependencies.memoryRefLookup;
    if (karmaEmitter === undefined || memoryRefLookup === undefined) {
      return;
    }
    let memories: readonly { readonly object_id: string }[] = [];
    try {
      memories = await memoryRefLookup.findMemoriesByEvidenceRef(
        input.evidenceObjectId,
        input.workspaceId
      );
    } catch (error) {
      this.dependencies.warn?.("evidence_gain memory lookup failed", {
        evidence_object_id: input.evidenceObjectId,
        workspace_id: input.workspaceId,
        error: error instanceof Error ? error.message : String(error)
      });
      return;
    }
    for (const memory of memories) {
      try {
        await karmaEmitter.emitKarmaEvent({
          kind: "evidence_gain",
          objectId: memory.object_id,
          workspaceId: input.workspaceId
        });
      } catch (error) {
        this.dependencies.warn?.("evidence_gain karma emit failed", {
          memory_object_id: memory.object_id,
          workspace_id: input.workspaceId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  public findById(objectId: string): Promise<Readonly<EvidenceCapsule> | null> {
    return this.dependencies.evidenceCapsuleRepo.findById(objectId);
  }

  // SECURITY: scoped lookup blocks cross-workspace pointer resolution at
  // the service layer (parallel to MemoryService.findByIdScoped). Used by
  // soul.open_pointer to dereference evidence_refs back to raw turn
  // material without leaking foreign-workspace evidence.
  public async findByIdScoped(
    objectId: string,
    workspaceId: string
  ): Promise<Readonly<EvidenceCapsule> | null> {
    const evidence = await this.dependencies.evidenceCapsuleRepo.findById(objectId);
    if (evidence === null || evidence.workspace_id !== workspaceId) {
      return null;
    }
    return evidence;
  }

  public findByRunId(runId: string): Promise<readonly Readonly<EvidenceCapsule>[]> {
    return this.dependencies.evidenceCapsuleRepo.findByRunId(runId);
  }

  public findByWorkspaceId(workspaceId: string): Promise<readonly Readonly<EvidenceCapsule>[]> {
    return this.dependencies.evidenceCapsuleRepo.findByWorkspaceId(workspaceId);
  }

  public findByHealth(health: EvidenceHealthState): Promise<readonly Readonly<EvidenceCapsule>[]> {
    return this.dependencies.evidenceCapsuleRepo.findByHealth(health);
  }
}

function parseEvidenceCapsule(value: EvidenceCapsule): EvidenceCapsule {
  try {
    return EvidenceCapsuleSchema.parse(value);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid evidence capsule payload", { cause: error });
  }
}

function parseEvidenceHealthState(value: EvidenceHealthState): EvidenceHealthState {
  try {
    return EvidenceHealthStateSchema.parse(value);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid evidence health state", { cause: error });
  }
}

function parseReason(value: string): string {
  if (value.trim().length === 0) {
    throw new CoreError("VALIDATION", "Transition reason is required");
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

function ensureValidHealthTransition(from: EvidenceHealthState, to: EvidenceHealthState): void {
  if (from === to) {
    throw new CoreError("VALIDATION", "Evidence health transition must change state");
  }

  if (!evidenceHealthTransitions[from].includes(to)) {
    throw new CoreError("VALIDATION", `Invalid evidence health transition: ${from} -> ${to}`);
  }
}
