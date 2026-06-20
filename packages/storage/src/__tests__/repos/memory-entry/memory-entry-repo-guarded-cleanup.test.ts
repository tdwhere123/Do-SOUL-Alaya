import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SynthesisStatus,
  type MemoryEntry,
  type SynthesisCapsule
} from "@do-soul/alaya-protocol";
import { StorageError } from "../../../shared/errors.js";
import {
  SqliteMemoryEntryRepo} from "../../../repos/memory-entry/index.js";
import { SqliteSynthesisCapsuleRepo } from "../../../repos/capsules/synthesis-capsule-repo.js";
import {
  createMemoryEntry,
  createRepo,
  trackedDatabases
} from "./memory-entry-repo-fixture.js";

const databases = trackedDatabases;

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

async function seedCompressedMember(input: {
  readonly memoryId: string;
  readonly capsule: Partial<SynthesisCapsule> | null;
  readonly capsuleId: string;
  readonly memory?: Partial<MemoryEntry>;
}): Promise<{ readonly repo: SqliteMemoryEntryRepo }> {
  const { repo, database } = await createRepo();
  if (input.capsule !== null) {
    const capsuleRepo = new SqliteSynthesisCapsuleRepo(database);
    await capsuleRepo.create({
      object_id: input.capsuleId,
      object_kind: "synthesis_capsule",
      schema_version: 1,
      lifecycle_state: "active",
      created_at: "2026-03-21T00:00:00.000Z",
      updated_at: "2026-03-21T00:00:00.000Z",
      created_by: "consolidation-executor",
      topic_key: "tooling/pnpm",
      synthesis_type: "phase_synthesis",
      summary: "Use pnpm for workspace commands.",
      evidence_refs: ["evidence-1"],
      source_memory_refs: [input.memoryId],
      workspace_id: "workspace-1",
      run_id: "run-1",
      synthesis_status: SynthesisStatus.STABLE,
      ...input.capsule
    });
  }
  await repo.create(
    createMemoryEntry({
      object_id: input.memoryId,
      retention_state: "tombstoned",
      lifecycle_state: "tombstone",
      forget_disposition: "compressed",
      forget_disposition_ref: input.capsuleId,
      ...input.memory
    })
  );
  return { repo };
}

describe("SqliteMemoryEntryRepo guarded lifecycle cleanup", () => {
  it("hardDeleteTombstonedWithDisposition (compressed-guarded) rolls the physical delete back when onDeleted throws (one transaction)", async () => {
    const memoryId = "dddddddd-0000-4000-8000-000000000006";
    const capsuleId = "dddddddd-1111-4000-8000-000000000006";
    const { repo } = await seedCompressedMember({ memoryId, capsuleId, capsule: {} });
    const onDeleted = vi.fn(() => {
      throw new Error("audit append failed mid-transaction");
    });

    await expect(
      repo.hardDeleteTombstonedWithDisposition(memoryId, { requireLiveCapsuleRef: true, onDeleted })
    ).rejects.toThrow(StorageError);
    expect(onDeleted).toHaveBeenCalledTimes(1);
    // The audit-append throw rolled the whole transaction back: the row survives.
    await expect(repo.findById(memoryId)).resolves.not.toBeNull();
  });

  it("findTombstonedMemoriesWithDisposition excludes tombstoned rows lacking a disposition", async () => {
    const { repo } = await createRepo();
    await repo.create(
      createMemoryEntry({
        object_id: "cccccccc-0000-4000-8000-000000000001",
        retention_state: "tombstoned",
        lifecycle_state: "tombstone"
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "cccccccc-0000-4000-8000-000000000002",
        retention_state: "tombstoned",
        lifecycle_state: "tombstone",
        forget_disposition: "compressed",
        forget_disposition_ref: "capsule-9"
      })
    );

    await expect(
      repo.findTombstonedMemoriesWithDisposition("workspace-1")
    ).resolves.toEqual([
      expect.objectContaining({ object_id: "cccccccc-0000-4000-8000-000000000002" })
    ]);
  });

  it("I3: transitionLifecycle to a NON-tombstone state clears the forget marker", async () => {
    const { repo } = await createRepo();
    // A row that carries a stale terminal-removal marker (e.g. import-carried, or
    // tombstoned then revived). Any non-tombstone transition must strip it so the
    // autonomous GC can never physically delete a revived/active row.
    const marked = createMemoryEntry({
      object_id: "dddddddd-0000-4000-8000-000000000001",
      lifecycle_state: "dormant",
      forget_disposition: "compressed",
      forget_disposition_ref: "capsule-stale"
    });
    await repo.create(marked);

    const revived = await repo.transitionLifecycle(marked.object_id, "active", "2026-03-22T00:00:00.000Z");
    expect(revived.lifecycle_state).toBe("active");
    expect(revived.forget_disposition).toBeNull();
    expect(revived.forget_disposition_ref).toBeNull();
  });

  it("I3: transitionLifecycle to tombstone KEEPS the forget marker (GC authorization)", async () => {
    const { repo } = await createRepo();
    const marked = createMemoryEntry({
      object_id: "dddddddd-0000-4000-8000-000000000002",
      lifecycle_state: "dormant",
      forget_disposition: "judged_useless",
      forget_disposition_ref: null
    });
    await repo.create(marked);

    const tombstoned = await repo.transitionLifecycle(marked.object_id, "tombstone", "2026-03-22T00:00:00.000Z");
    expect(tombstoned.lifecycle_state).toBe("tombstone");
    expect(tombstoned.forget_disposition).toBe("judged_useless");
  });

  it("transitionLifecycle rolls the lifecycle update back when onTransition throws", async () => {
    const { repo } = await createRepo();
    const active = createMemoryEntry({
      object_id: "dddddddd-0000-4000-8000-000000000003",
      lifecycle_state: "active"
    });
    await repo.create(active);
    const onTransition = vi.fn(() => {
      throw new Error("lifecycle audit append failed mid-transaction");
    });

    await expect(
      repo.transitionLifecycle(active.object_id, "dormant", "2026-03-22T00:00:00.000Z", onTransition)
    ).rejects.toThrow(StorageError);

    expect(onTransition).toHaveBeenCalledTimes(1);
    expect((await repo.findById(active.object_id))?.lifecycle_state).toBe("active");
  });

  it("N1: reviveDormant flips a dormant row to active and clears the forget marker", async () => {
    const { repo } = await createRepo();
    const dormant = createMemoryEntry({
      object_id: "eeeeeeee-0000-4000-8000-000000000001",
      lifecycle_state: "dormant",
      forget_disposition: "compressed",
      forget_disposition_ref: "capsule-y"
    });
    await repo.create(dormant);

    const revived = await repo.reviveDormant(dormant.object_id, "2026-03-22T00:00:00.000Z");
    expect(revived?.lifecycle_state).toBe("active");
    expect(revived?.forget_disposition).toBeNull();
    expect(revived?.forget_disposition_ref).toBeNull();
  });

  it("N1: reviveDormant is a guarded no-op (returns null) for an already-active row", async () => {
    const { repo } = await createRepo();
    const active = createMemoryEntry({
      object_id: "eeeeeeee-0000-4000-8000-000000000002",
      lifecycle_state: "active"
    });
    await repo.create(active);

    await expect(repo.reviveDormant(active.object_id, "2026-03-22T00:00:00.000Z")).resolves.toBeNull();
    expect((await repo.findById(active.object_id))?.lifecycle_state).toBe("active");
  });

  // invariant (I-1): guarded active -> dormant demotion. onTransition (the
  // active->dormant audit append) shares the UPDATE transaction; a 0-row guard
  // (row not active) is a benign no-op skip, never an audit and never a throw.
  it("transitionToDormantIfActive demotes an active row, clears the forget marker, and fires onTransition once", async () => {
    const { repo } = await createRepo();
    const active = createMemoryEntry({
      object_id: "ffffffff-0000-4000-8000-000000000001",
      lifecycle_state: "active",
      forget_disposition: "compressed",
      forget_disposition_ref: "capsule-z"
    });
    await repo.create(active);
    const onTransition = vi.fn();

    const demoted = await repo.transitionToDormantIfActive(
      active.object_id,
      "2026-03-22T00:00:00.000Z",
      onTransition
    );
    expect(onTransition).toHaveBeenCalledTimes(1);
    expect(demoted?.lifecycle_state).toBe("dormant");
    expect(demoted?.forget_disposition).toBeNull();
    expect(demoted?.forget_disposition_ref).toBeNull();
  });

  it("transitionToDormantIfActive is a guarded no-op (null, no onTransition) for a row that is not active", async () => {
    const { repo } = await createRepo();
    const dormant = createMemoryEntry({
      object_id: "ffffffff-0000-4000-8000-000000000002",
      lifecycle_state: "dormant"
    });
    await repo.create(dormant);
    const onTransition = vi.fn();

    await expect(
      repo.transitionToDormantIfActive(dormant.object_id, "2026-03-22T00:00:00.000Z", onTransition)
    ).resolves.toBeNull();
    expect(onTransition).not.toHaveBeenCalled();
    expect((await repo.findById(dormant.object_id))?.lifecycle_state).toBe("dormant");
  });

  it("transitionToDormantIfActive rolls the demotion back when onTransition throws (one transaction)", async () => {
    const { repo } = await createRepo();
    const active = createMemoryEntry({
      object_id: "ffffffff-0000-4000-8000-000000000003",
      lifecycle_state: "active"
    });
    await repo.create(active);
    const onTransition = vi.fn(() => {
      throw new Error("active->dormant audit append failed mid-transaction");
    });

    await expect(
      repo.transitionToDormantIfActive(active.object_id, "2026-03-22T00:00:00.000Z", onTransition)
    ).rejects.toThrow(StorageError);
    expect(onTransition).toHaveBeenCalledTimes(1);
    // The audit-append throw rolled the UPDATE back: the row stays active.
    expect((await repo.findById(active.object_id))?.lifecycle_state).toBe("active");
  });



});
