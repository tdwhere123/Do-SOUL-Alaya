import { describe, expect, it } from "vitest";
import {
  ProjectionEraseBarrierSchema,
  sameEraseBarrier,
  type ProjectionEraseBarrier
} from "@do-soul/alaya-protocol";
import { CoreError } from "../../shared/errors.js";

const RECORDED = "2026-08-16T00:00:00.000Z";
const DIGEST = `sha256:${"a".repeat(64)}`;

describe("EventLogSafeEraseBarrier", () => {
  it("clears plaintext, persists the barrier only, and refuses rollback", () => {
    const subjects = new InMemoryEraseSubjectStore();
    const barriers = new InMemoryEraseBarrierStore();
    subjects.seed("workspace-1", "source-1", "secret excerpt about a person");
    const erase = new EventLogSafeEraseBarrier({ subjects, barriers });

    const stored = erase.erase(barrier());

    expect(subjects.getPlaintext("workspace-1", "source-1")).toBeNull();
    expect(stored.subject_id).toBe("source-1");
    expect(JSON.stringify(stored)).not.toMatch(/secret excerpt/u);
    expect(() => ProjectionEraseBarrierSchema.parse({
      ...barrier(),
      excerpt: "secret excerpt"
    })).toThrow();
    expect(() => erase.restorePlaintext(
      "workspace-1",
      "source-1",
      "secret excerpt about a person"
    )).toThrow(/irreversible/u);
    expect(subjects.getPlaintext("workspace-1", "source-1")).toBeNull();
    expect(erase.erase(barrier())).toEqual(stored);
    expect(barriers.get("workspace-1", "barrier-1")).toEqual(stored);
  });
});

function barrier() {
  return ProjectionEraseBarrierSchema.parse({
    schema_version: 1,
    producer: "erase_barrier",
    consumer: "projection_generation",
    identity: DIGEST,
    replay_rule: "idempotent_same_identity",
    failure_disposition: "fail_closed",
    governance_effect: "tombstone",
    deletion_behavior: "content_free_tombstone",
    workspace_id: "workspace-1",
    barrier_id: "barrier-1",
    generation_id: null,
    subject_kind: "source_record",
    subject_id: "source-1",
    erased_at: RECORDED
  });
}

interface EraseSubjectStore {
  getPlaintext(workspaceId: string, subjectId: string): string | null;
  clearPlaintext(workspaceId: string, subjectId: string): void;
}

interface EraseBarrierStore {
  put(row: ProjectionEraseBarrier): ProjectionEraseBarrier;
  get(workspaceId: string, barrierId: string): ProjectionEraseBarrier | null;
  findBySubject(workspaceId: string, subjectId: string): ProjectionEraseBarrier | null;
}

interface EventLogSafeEraseBarrierDependencies {
  readonly barriers: EraseBarrierStore;
  readonly subjects: EraseSubjectStore;
}

// In-memory double for identity, idempotence, and irreversible plaintext
// clear. Uses protocol sameEraseBarrier; not the SQL erase owner.
class EventLogSafeEraseBarrier {
  public constructor(private readonly dependencies: EventLogSafeEraseBarrierDependencies) {}

  public erase(input: ProjectionEraseBarrier): ProjectionEraseBarrier {
    const row = ProjectionEraseBarrierSchema.parse(input);
    const existing = this.existingCompatibleBarrier(row);
    if (existing !== null) return existing;
    this.dependencies.subjects.clearPlaintext(row.workspace_id, row.subject_id);
    return this.dependencies.barriers.put(row);
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
    row: ProjectionEraseBarrier
  ): ProjectionEraseBarrier | null {
    const byId = this.dependencies.barriers.get(row.workspace_id, row.barrier_id);
    const bySubject = this.dependencies.barriers.findBySubject(
      row.workspace_id,
      row.subject_id
    );
    const existing = byId ?? bySubject;
    if (existing === null) return null;
    if (!sameEraseBarrier(existing, row)) {
      throw new CoreError("CONFLICT", "erase barrier identity conflict");
    }
    return existing;
  }
}

class InMemoryEraseSubjectStore implements EraseSubjectStore {
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

class InMemoryEraseBarrierStore implements EraseBarrierStore {
  private readonly byId = new Map<string, ProjectionEraseBarrier>();
  private readonly bySubject = new Map<string, ProjectionEraseBarrier>();

  public put(row: ProjectionEraseBarrier): ProjectionEraseBarrier {
    this.byId.set(barrierKey(row.workspace_id, row.barrier_id), row);
    this.bySubject.set(subjectKey(row.workspace_id, row.subject_id), row);
    return row;
  }

  public get(workspaceId: string, barrierId: string): ProjectionEraseBarrier | null {
    return this.byId.get(barrierKey(workspaceId, barrierId)) ?? null;
  }

  public findBySubject(workspaceId: string, subjectId: string): ProjectionEraseBarrier | null {
    return this.bySubject.get(subjectKey(workspaceId, subjectId)) ?? null;
  }
}

function barrierKey(workspaceId: string, barrierId: string): string {
  return `${workspaceId}\0${barrierId}`;
}

function subjectKey(workspaceId: string, subjectId: string): string {
  return `${workspaceId}\0${subjectId}`;
}
