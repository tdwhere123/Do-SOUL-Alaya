import {
  FieldGenerationEventType,
  ProjectionEraseBarrierSchema,
  sameEraseBarrier,
  SoulFieldEraseBarrierPayloadSchema,
  type EventLogEntry,
  type ProjectionEraseBarrier
} from "@do-soul/alaya-protocol";
import { SYSTEM_ACTOR } from "../../shared/actors.js";
import { CoreError } from "../../shared/errors.js";
import type { EventPublisherInput } from "../../runtime/event-publisher.js";

export interface EraseSubjectStore {
  getPlaintext(workspaceId: string, subjectId: string): string | null;
  clearPlaintext(workspaceId: string, subjectId: string): void;
}

export interface EraseBarrierStore {
  put(barrier: ProjectionEraseBarrier): ProjectionEraseBarrier;
  get(workspaceId: string, barrierId: string): ProjectionEraseBarrier | null;
  findBySubject(workspaceId: string, subjectId: string): ProjectionEraseBarrier | null;
}

export interface GovernanceEventLogPort {
  append(input: EventPublisherInput): EventLogEntry;
}

export interface EventLogSafeEraseBarrierDependencies {
  readonly barriers: EraseBarrierStore;
  readonly subjects: EraseSubjectStore;
}

export class EventLogSafeEraseBarrier {
  public constructor(private readonly dependencies: EventLogSafeEraseBarrierDependencies) {}

  public erase(input: ProjectionEraseBarrier): ProjectionEraseBarrier {
    const barrier = ProjectionEraseBarrierSchema.parse(input);
    const existing = this.existingCompatibleBarrier(barrier);
    if (existing !== null) return existing;
    this.dependencies.subjects.clearPlaintext(barrier.workspace_id, barrier.subject_id);
    return this.dependencies.barriers.put(barrier);
  }

  public restorePlaintext(
    workspaceId: string,
    subjectId: string,
    _plaintext: string
  ): never {
    if (this.dependencies.barriers.findBySubject(workspaceId, subjectId) !== null) {
      throw new CoreError("CONFLICT", "privacy erase is irreversible");
    }
    throw new CoreError("NOT_FOUND", "erase barrier was not found");
  }

  private existingCompatibleBarrier(
    barrier: ProjectionEraseBarrier
  ): ProjectionEraseBarrier | null {
    const byId = this.dependencies.barriers.get(barrier.workspace_id, barrier.barrier_id);
    const bySubject = this.dependencies.barriers.findBySubject(
      barrier.workspace_id,
      barrier.subject_id
    );
    const existing = byId ?? bySubject;
    if (existing === null) return null;
    if (!sameEraseBarrier(existing, barrier)) {
      throw new CoreError("CONFLICT", "erase barrier identity conflict");
    }
    return existing;
  }
}

export class InMemoryEraseSubjectStore implements EraseSubjectStore {
  private readonly plaintext = new Map<string, string>();

  public seed(workspaceId: string, subjectId: string, body: string): void {
    this.plaintext.set(subjectKey(workspaceId, subjectId), body);
  }

  public getPlaintext(workspaceId: string, subjectId: string): string | null {
    return this.plaintext.get(subjectKey(workspaceId, subjectId)) ?? null;
  }

  public clearPlaintext(workspaceId: string, subjectId: string): void {
    this.plaintext.delete(subjectKey(workspaceId, subjectId));
  }
}

export class InMemoryEraseBarrierStore implements EraseBarrierStore {
  private readonly byId = new Map<string, ProjectionEraseBarrier>();
  private readonly bySubject = new Map<string, ProjectionEraseBarrier>();

  public put(barrier: ProjectionEraseBarrier): ProjectionEraseBarrier {
    this.byId.set(barrierKey(barrier.workspace_id, barrier.barrier_id), barrier);
    this.bySubject.set(subjectKey(barrier.workspace_id, barrier.subject_id), barrier);
    return barrier;
  }

  public get(workspaceId: string, barrierId: string): ProjectionEraseBarrier | null {
    return this.byId.get(barrierKey(workspaceId, barrierId)) ?? null;
  }

  public findBySubject(workspaceId: string, subjectId: string): ProjectionEraseBarrier | null {
    return this.bySubject.get(subjectKey(workspaceId, subjectId)) ?? null;
  }
}

export class InMemoryGovernanceEventLog implements GovernanceEventLogPort {
  public readonly entries: EventLogEntry[] = [];

  public constructor(private readonly now: () => string = () => "2026-08-16T00:00:00.000Z") {}

  public append(input: EventPublisherInput): EventLogEntry {
    const entry = Object.freeze({
      ...input,
      event_id: `evt_${String(this.entries.length + 1).padStart(3, "0")}`,
      created_at: this.now(),
      revision: this.entries.length
    });
    this.entries.push(entry);
    return entry;
  }
}

export function buildEraseBarrierEventInput(
  barrier: ProjectionEraseBarrier
): EventPublisherInput {
  return {
    event_type: FieldGenerationEventType.SOUL_FIELD_ERASE_BARRIER,
    entity_type: "projection_erase_barrier",
    entity_id: barrier.barrier_id,
    workspace_id: barrier.workspace_id,
    run_id: null,
    caused_by: SYSTEM_ACTOR,
    payload_json: SoulFieldEraseBarrierPayloadSchema.parse({
      workspace_id: barrier.workspace_id,
      barrier_id: barrier.barrier_id,
      generation_id: barrier.generation_id,
      subject_kind: barrier.subject_kind,
      subject_id: barrier.subject_id,
      erased_at: barrier.erased_at
    })
  };
}

function barrierKey(workspaceId: string, barrierId: string): string {
  return `${workspaceId}\0${barrierId}`;
}

function subjectKey(workspaceId: string, subjectId: string): string {
  return `${workspaceId}\0${subjectId}`;
}
