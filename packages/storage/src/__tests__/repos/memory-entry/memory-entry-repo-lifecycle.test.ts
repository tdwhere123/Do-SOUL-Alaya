import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  StorageTier,
  SynthesisStatus,
  type MemoryEntry,
  type SynthesisCapsule
} from "@do-soul/alaya-protocol";
import { StorageError } from "../../../shared/errors.js";
import {
  FIND_BY_EVIDENCE_REFS_INPUT_CAP,
  SqliteMemoryEntryRepo,
  type MemoryEntryRepoDiagnosticSink
} from "../../../repos/memory-entry/index.js";
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

describe("SqliteMemoryEntryRepo", () => {
  it("only treats retention_state tombstoned entries as GC-eligible", async () => {
    const { repo } = await createRepo();
    await repo.create(
      createMemoryEntry({
        object_id: "55555555-5555-4555-8555-555555555555",
        retention_state: "tombstoned",
        lifecycle_state: "active"
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "66666666-6666-4666-8666-666666666666",
        run_id: "run-2",
        retention_state: "canon",
        lifecycle_state: "tombstone"
      })
    );

    await expect(repo.findTombstonedMemories("workspace-1")).resolves.toEqual([
      expect.objectContaining({
        object_id: "55555555-5555-4555-8555-555555555555"
      })
    ]);
    await expect(repo.hardDeleteTombstoned("66666666-6666-4666-8666-666666666666")).rejects.toMatchObject({
      name: "StorageError",
      code: "NOT_FOUND"
    });

    await expect(repo.hardDeleteTombstoned("55555555-5555-4555-8555-555555555555")).resolves.toBeUndefined();
    await expect(repo.findById("55555555-5555-4555-8555-555555555555")).resolves.toBeNull();
  });

  it("hardDeleteTombstoned rolls the delete back when onDeleted throws", async () => {
    const { repo } = await createRepo();
    const entry = createMemoryEntry({
      object_id: "55555555-5555-4555-8555-555555555556",
      retention_state: "tombstoned",
      lifecycle_state: "tombstone"
    });
    await repo.create(entry);
    const onDeleted = vi.fn(() => {
      throw new Error("delete audit append failed mid-transaction");
    });

    await expect(repo.hardDeleteTombstoned(entry.object_id, onDeleted)).rejects.toThrow(StorageError);

    expect(onDeleted).toHaveBeenCalledTimes(1);
    await expect(repo.findById(entry.object_id)).resolves.toEqual(expect.objectContaining({
      object_id: entry.object_id,
      retention_state: "tombstoned"
    }));
  });

  it("autonomousTombstone only fires on a dormant row and writes the durable disposition", async () => {
    const { repo } = await createRepo();
    const dormant = createMemoryEntry({
      object_id: "aaaaaaaa-0000-4000-8000-000000000001",
      lifecycle_state: "dormant"
    });
    await repo.create(dormant);

    const tombstoned = await repo.autonomousTombstone({
      objectId: dormant.object_id,
      disposition: "judged_useless",
      dispositionRef: null,
      updatedAt: "2026-03-22T00:00:00.000Z"
    });
    expect(tombstoned.forget_disposition).toBe("judged_useless");
    expect(tombstoned.forget_disposition_ref).toBeNull();
    expect(tombstoned.retention_state).toBe("tombstoned");
    expect(tombstoned.lifecycle_state).toBe("tombstone");
  });

  it.each([
    ["became pinned", { decay_profile: "pinned" } satisfies Partial<MemoryEntry>],
    ["became hazard", { decay_profile: "hazard" } satisfies Partial<MemoryEntry>],
    ["became canon", { retention_state: "canon" } satisfies Partial<MemoryEntry>],
    ["became consolidated", { retention_state: "consolidated" } satisfies Partial<MemoryEntry>]
  ])("autonomousTombstone atomically REFUSES when a dormant row %s", async (_label, overrides) => {
    const { repo } = await createRepo();
    const protectedDormant = createMemoryEntry({
      object_id: "aaaaaaaa-0000-4000-8000-000000000005",
      lifecycle_state: "dormant",
      evidence_refs: [],
      reinforcement_count: 0,
      ...overrides
    });
    await repo.create(protectedDormant);
    const onTransition = vi.fn();

    await expect(
      repo.autonomousTombstone(
        {
          objectId: protectedDormant.object_id,
          disposition: "judged_useless",
          dispositionRef: null,
          updatedAt: "2026-03-22T00:00:00.000Z"
        },
        { onTransition }
      )
    ).rejects.toMatchObject({ name: "StorageError", code: "NOT_FOUND" });
    expect(onTransition).not.toHaveBeenCalled();
    await expect(repo.findById(protectedDormant.object_id)).resolves.toEqual(
      expect.objectContaining({
        lifecycle_state: "dormant",
        forget_disposition: null,
        forget_disposition_ref: null,
        ...overrides
      })
    );
  });

  it("autonomousTombstone rolls the tombstone update back when the transition audit callback throws", async () => {
    const { repo } = await createRepo();
    const dormant = createMemoryEntry({
      object_id: "aaaaaaaa-0000-4000-8000-000000000004",
      lifecycle_state: "dormant"
    });
    await repo.create(dormant);
    const onTransition = vi.fn(() => {
      throw new Error("audit append failed mid-transaction");
    });

    await expect(
      repo.autonomousTombstone(
        {
          objectId: dormant.object_id,
          disposition: "judged_useless",
          dispositionRef: null,
          updatedAt: "2026-03-22T00:00:00.000Z"
        },
        { onTransition }
      )
    ).rejects.toThrow(StorageError);
    expect(onTransition).toHaveBeenCalledTimes(1);
    await expect(repo.findById(dormant.object_id)).resolves.toEqual(
      expect.objectContaining({
        lifecycle_state: "dormant",
        retention_state: null,
        forget_disposition: null,
        forget_disposition_ref: null
      })
    );
  });

  it("autonomousTombstone refuses a non-dormant (active) row — recallable memory is never silently tombstoned", async () => {
    const { repo } = await createRepo();
    const active = createMemoryEntry({
      object_id: "aaaaaaaa-0000-4000-8000-000000000002",
      lifecycle_state: "active"
    });
    await repo.create(active);

    await expect(
      repo.autonomousTombstone({
        objectId: active.object_id,
        disposition: "judged_useless",
        dispositionRef: null,
        updatedAt: "2026-03-22T00:00:00.000Z"
      })
    ).rejects.toMatchObject({ name: "StorageError", code: "NOT_FOUND" });

    const reloaded = await repo.findById(active.object_id);
    expect(reloaded?.lifecycle_state).toBe("active");
    expect(reloaded?.forget_disposition ?? null).toBeNull();
  });

  it("autonomousTombstone rejects a malformed compressed marker without a capsule ref", async () => {
    const { repo } = await createRepo();
    const dormant = createMemoryEntry({
      object_id: "aaaaaaaa-0000-4000-8000-000000000003",
      lifecycle_state: "dormant"
    });
    await repo.create(dormant);

    await expect(
      repo.autonomousTombstone({
        objectId: dormant.object_id,
        disposition: "compressed",
        dispositionRef: null,
        updatedAt: "2026-03-22T00:00:00.000Z"
      })
    ).rejects.toMatchObject({ name: "StorageError", code: "VALIDATION_FAILED" });
  });

  it("hardDeleteTombstonedWithDisposition refuses a tombstoned row that has NO disposition (defense in depth)", async () => {
    const { repo } = await createRepo();
    // A human-Inspector-style tombstone: retention_state tombstoned, past grace,
    // but no forget_disposition. The autonomous GC authority must refuse it.
    const humanTombstoned = createMemoryEntry({
      object_id: "bbbbbbbb-0000-4000-8000-000000000001",
      retention_state: "tombstoned",
      lifecycle_state: "tombstone"
    });
    await repo.create(humanTombstoned);

    await expect(
      repo.hardDeleteTombstonedWithDisposition(humanTombstoned.object_id)
    ).rejects.toMatchObject({ name: "StorageError", code: "NOT_FOUND" });
    await expect(repo.findById(humanTombstoned.object_id)).resolves.not.toBeNull();
  });

  it("hardDeleteTombstonedWithDisposition removes a tombstoned+past-grace row that carries a disposition", async () => {
    const { repo } = await createRepo();
    const disposed = createMemoryEntry({
      object_id: "bbbbbbbb-0000-4000-8000-000000000002",
      retention_state: "tombstoned",
      lifecycle_state: "tombstone",
      forget_disposition: "judged_useless",
      forget_disposition_ref: null
    });
    await repo.create(disposed);

    await expect(
      repo.findTombstonedMemoriesWithDisposition("workspace-1")
    ).resolves.toEqual([expect.objectContaining({ object_id: disposed.object_id })]);
    await expect(
      repo.hardDeleteTombstonedWithDisposition(disposed.object_id)
    ).resolves.toBe(true);
    await expect(repo.findById(disposed.object_id)).resolves.toBeNull();
  });

  it("hardDeleteTombstonedWithDisposition (judged_useless-guarded) deletes only while the verdict still holds", async () => {
    const { repo } = await createRepo();
    const disposed = createMemoryEntry({
      object_id: "bbbbbbbb-0000-4000-8000-000000000003",
      retention_state: "tombstoned",
      lifecycle_state: "tombstone",
      forget_disposition: "judged_useless",
      forget_disposition_ref: null,
      evidence_refs: [],
      reinforcement_count: 0,
      decay_profile: null
    });
    await repo.create(disposed);
    const onDeleted = vi.fn();

    await expect(
      repo.hardDeleteTombstonedWithDisposition(disposed.object_id, {
        requireJudgedUselessVerdict: true,
        onDeleted
      })
    ).resolves.toBe(true);
    expect(onDeleted).toHaveBeenCalledTimes(1);
    await expect(repo.findById(disposed.object_id)).resolves.toBeNull();
  });

  it.each([
    ["gained evidence", { evidence_refs: ["late-evidence"] } satisfies Partial<MemoryEntry>],
    ["gained reinforcement", { reinforcement_count: 1 } satisfies Partial<MemoryEntry>],
    ["became pinned", { decay_profile: "pinned" } satisfies Partial<MemoryEntry>],
    ["became hazard", { decay_profile: "hazard" } satisfies Partial<MemoryEntry>],
    ["became canon", { retention_state: "canon" } satisfies Partial<MemoryEntry>],
    ["became consolidated", { retention_state: "consolidated" } satisfies Partial<MemoryEntry>]
  ])(
    "hardDeleteTombstonedWithDisposition (judged_useless-guarded) atomically REFUSES when the row %s",
    async (_label, overrides) => {
      const { repo } = await createRepo();
      const disposed = createMemoryEntry({
        object_id: "bbbbbbbb-0000-4000-8000-000000000004",
        retention_state: "tombstoned",
        lifecycle_state: "tombstone",
        forget_disposition: "judged_useless",
        forget_disposition_ref: null,
        evidence_refs: [],
        reinforcement_count: 0,
        decay_profile: null,
        ...overrides
      });
      await repo.create(disposed);
      const onDeleted = vi.fn();

      await expect(
        repo.hardDeleteTombstonedWithDisposition(disposed.object_id, {
          requireJudgedUselessVerdict: true,
          onDeleted
        })
      ).resolves.toBe(false);
      expect(onDeleted).not.toHaveBeenCalled();
      await expect(repo.findById(disposed.object_id)).resolves.not.toBeNull();
    }
  );

  it("hardDeleteTombstonedWithDisposition (judged_useless-guarded) rolls back the physical delete when onDeleted throws", async () => {
    const { repo } = await createRepo();
    const disposed = createMemoryEntry({
      object_id: "bbbbbbbb-0000-4000-8000-000000000005",
      retention_state: "tombstoned",
      lifecycle_state: "tombstone",
      forget_disposition: "judged_useless",
      forget_disposition_ref: null,
      evidence_refs: [],
      reinforcement_count: 0,
      decay_profile: null
    });
    await repo.create(disposed);
    const onDeleted = vi.fn(() => {
      throw new Error("audit append failed mid-transaction");
    });

    await expect(
      repo.hardDeleteTombstonedWithDisposition(disposed.object_id, {
        requireJudgedUselessVerdict: true,
        onDeleted
      })
    ).rejects.toThrow(StorageError);
    expect(onDeleted).toHaveBeenCalledTimes(1);
    await expect(repo.findById(disposed.object_id)).resolves.not.toBeNull();
  });

  // invariant: the compressed delete (requireLiveCapsuleRef) re-asserts capsule
  // liveness + membership ATOMICALLY in the DELETE statement, so there is no
  // window between a re-check and the physical removal. A capsule that archived /
  // tombstoned / dropped the member / was deleted makes the guard match 0 rows,
  // and the member survives (recoverable). see also:
  // packages/core/src/memory/memory-service/service.ts:MemoryService.autonomousHardDeleteTombstoned.
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

  it("hardDeleteTombstonedWithDisposition (compressed-guarded) removes the member only when a live capsule STILL references it", async () => {
    const memoryId = "dddddddd-0000-4000-8000-000000000001";
    const capsuleId = "dddddddd-1111-4000-8000-000000000001";
    const { repo } = await seedCompressedMember({ memoryId, capsuleId, capsule: {} });

    await expect(
      repo.hardDeleteTombstonedWithDisposition(memoryId, { requireLiveCapsuleRef: true })
    ).resolves.toBe(true);
    await expect(repo.findById(memoryId)).resolves.toBeNull();
  });

  it.each([
    ["capsule archived", { synthesis_status: SynthesisStatus.ARCHIVED } satisfies Partial<SynthesisCapsule>],
    ["capsule tombstoned/superseded", { lifecycle_state: "tombstone" } satisfies Partial<SynthesisCapsule>],
    ["capsule dropped the member", { source_memory_refs: [] } satisfies Partial<SynthesisCapsule>]
  ])(
    "hardDeleteTombstonedWithDisposition (compressed-guarded) atomically REFUSES (0 rows, member survives) when %s",
    async (_label, capsule) => {
      const memoryId = "dddddddd-0000-4000-8000-000000000002";
      const capsuleId = "dddddddd-1111-4000-8000-000000000002";
      const { repo } = await seedCompressedMember({ memoryId, capsuleId, capsule });

      await expect(
        repo.hardDeleteTombstonedWithDisposition(memoryId, { requireLiveCapsuleRef: true })
      ).resolves.toBe(false);
      await expect(repo.findById(memoryId)).resolves.not.toBeNull();
    }
  );

  it("hardDeleteTombstonedWithDisposition (compressed-guarded) atomically REFUSES when the preserving capsule was cascade-deleted", async () => {
    const memoryId = "dddddddd-0000-4000-8000-000000000003";
    const capsuleId = "dddddddd-1111-4000-8000-000000000003";
    const { repo } = await seedCompressedMember({ memoryId, capsuleId, capsule: null });

    await expect(
      repo.hardDeleteTombstonedWithDisposition(memoryId, { requireLiveCapsuleRef: true })
    ).resolves.toBe(false);
    await expect(repo.findById(memoryId)).resolves.not.toBeNull();
  });

  it.each([
    ["member became pinned", { decay_profile: "pinned" } satisfies Partial<MemoryEntry>],
    ["member became hazard", { decay_profile: "hazard" } satisfies Partial<MemoryEntry>],
    ["member became canon", { retention_state: "canon" } satisfies Partial<MemoryEntry>],
    ["member became consolidated", { retention_state: "consolidated" } satisfies Partial<MemoryEntry>]
  ])(
    "hardDeleteTombstonedWithDisposition (compressed-guarded) atomically REFUSES when %s",
    async (_label, memory) => {
      const memoryId = "dddddddd-0000-4000-8000-000000000007";
      const capsuleId = "dddddddd-1111-4000-8000-000000000007";
      const { repo } = await seedCompressedMember({ memoryId, capsuleId, capsule: {}, memory });

      await expect(
        repo.hardDeleteTombstonedWithDisposition(memoryId, { requireLiveCapsuleRef: true })
      ).resolves.toBe(false);
      await expect(repo.findById(memoryId)).resolves.not.toBeNull();
    }
  );

  // invariant (I-2): the caller's deleted-audit append (onDeleted) shares the
  // delete transaction, so the physical removal and the audit commit or roll
  // back together. onDeleted runs ONLY on changes>0 and a throw inside it undoes
  // the physical delete.
  it("hardDeleteTombstonedWithDisposition (compressed-guarded) fires onDeleted exactly once when a row is removed", async () => {
    const memoryId = "dddddddd-0000-4000-8000-000000000004";
    const capsuleId = "dddddddd-1111-4000-8000-000000000004";
    const { repo } = await seedCompressedMember({ memoryId, capsuleId, capsule: {} });
    const onDeleted = vi.fn();

    await expect(
      repo.hardDeleteTombstonedWithDisposition(memoryId, { requireLiveCapsuleRef: true, onDeleted })
    ).resolves.toBe(true);
    expect(onDeleted).toHaveBeenCalledTimes(1);
    await expect(repo.findById(memoryId)).resolves.toBeNull();
  });

  it("hardDeleteTombstonedWithDisposition (compressed-guarded) does NOT fire onDeleted on a 0-row preservation-revoked race", async () => {
    const memoryId = "dddddddd-0000-4000-8000-000000000005";
    const capsuleId = "dddddddd-1111-4000-8000-000000000005";
    const { repo } = await seedCompressedMember({
      memoryId,
      capsuleId,
      capsule: { source_memory_refs: [] }
    });
    const onDeleted = vi.fn();

    await expect(
      repo.hardDeleteTombstonedWithDisposition(memoryId, { requireLiveCapsuleRef: true, onDeleted })
    ).resolves.toBe(false);
    expect(onDeleted).not.toHaveBeenCalled();
    await expect(repo.findById(memoryId)).resolves.not.toBeNull();
  });

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


  it("throws NOT_FOUND when updating dynamics for a missing entry", async () => {
    const { repo } = await createRepo();

    await expect(
      repo.updateDynamics(
        "missing-memory-id",
        {
          activation_score: 0.4,
          retention_score: 0.6,
          manifestation_state: "hint"
        },
        "2026-03-21T06:00:00.000Z"
      )
    ).rejects.toMatchObject({
      name: "StorageError",
      code: "NOT_FOUND"
    });
  });

  it("archives an entry by setting lifecycle_state to archived", async () => {
    const { repo } = await createRepo();
    const entry = createMemoryEntry();
    await repo.create(entry);

    const archived = await repo.archive(entry.object_id, "2026-03-21T04:00:00.000Z");
    expect(archived.lifecycle_state).toBe("archived");
    expect(archived.updated_at).toBe("2026-03-21T04:00:00.000Z");
  });

  it("archive rolls the archive update back when onArchived throws", async () => {
    const { repo } = await createRepo();
    const entry = createMemoryEntry({
      object_id: "55555555-0000-4000-8000-000000000001",
      lifecycle_state: "active"
    });
    await repo.create(entry);
    const onArchived = vi.fn(() => {
      throw new Error("archive audit append failed mid-transaction");
    });

    await expect(
      repo.archive(entry.object_id, "2026-03-21T04:00:00.000Z", onArchived)
    ).rejects.toThrow(StorageError);

    expect(onArchived).toHaveBeenCalledTimes(1);
    expect((await repo.findById(entry.object_id))?.lifecycle_state).toBe("active");
  });

  it("keeps all dynamics fields null in phase 1B", async () => {
    const { repo } = await createRepo();
    const created = await repo.create(createMemoryEntry());

    expect(created.activation_score).toBeNull();
    expect(created.retention_score).toBeNull();
    expect(created.manifestation_state).toBeNull();
    expect(created.retention_state).toBeNull();
    expect(created.decay_profile).toBeNull();
    expect(created.confidence).toBeNull();
    expect(created.last_used_at).toBeNull();
    expect(created.last_hit_at).toBeNull();
    expect(created.reinforcement_count).toBeNull();
    expect(created.contradiction_count).toBeNull();
    expect(created.superseded_by).toBeNull();
  });

  it("round-trips domain_tags and evidence_refs JSON fields", async () => {
    const { repo } = await createRepo();
    const entry = createMemoryEntry({
      object_id: "4f5af11e-03be-4248-8a89-2180b99c7158",
      domain_tags: ["a", "b"],
      evidence_refs: ["e1", "e2", "e3"]
    });

    await repo.create(entry);
    const loaded = await repo.findById(entry.object_id);

    expect(loaded?.domain_tags).toEqual(["a", "b"]);
    expect(loaded?.evidence_refs).toEqual(["e1", "e2", "e3"]);
  });

  it("returns immutable entries", async () => {
    const { repo } = await createRepo();
    const created = await repo.create(createMemoryEntry());

    expect(() => {
      (created as any).content = "mutated";
    }).toThrow(TypeError);
  });

  it("matches an English query through the porter word-stemmed FTS index", async () => {
    const { repo } = await createRepo();
    await repo.create(
      createMemoryEntry({
        object_id: "e1111111-1111-4111-8111-111111111111",
        content: "The team agreed to refactor the recall ranking pipeline."
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "e2222222-2222-4222-8222-222222222222",
        run_id: "run-2",
        content: "Governance reviews need durable evidence."
      })
    );

    // "agree" / "refactoring" only match via porter stemming of the stored
    // "agreed" / "refactor"; the trigram table cannot bridge these.
    // "agree" is a literal substring of stored "agreed", so the trigram lane
    // also hits and surfaces a trigram_rank alongside the porter rank.
    await expect(repo.searchByKeyword("workspace-1", "agree", 5)).resolves.toEqual([
      { object_id: "e1111111-1111-4111-8111-111111111111", normalized_rank: 1, trigram_rank: 1 }
    ]);
    // "refactoring" only bridges via porter stemming of stored "refactor";
    // the trigram lane cannot match it, so no trigram_rank is surfaced.
    await expect(repo.searchByKeyword("workspace-1", "refactoring", 5)).resolves.toEqual([
      { object_id: "e1111111-1111-4111-8111-111111111111", normalized_rank: 1 }
    ]);
  });

  it("matches a Chinese query through the trigram index in the dual-index setup", async () => {
    const { repo } = await createRepo();
    await repo.create(
      createMemoryEntry({
        object_id: "c1111111-1111-4111-8111-111111111111",
        content: "请记住中文路径需要逐字保留，避免命名漂移。"
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "c2222222-2222-4222-8222-222222222222",
        run_id: "run-2",
        content: "英文路径在这个用例里不重要。"
      })
    );

    await expect(repo.searchByKeyword("workspace-1", "中文路径", 5)).resolves.toEqual([
      { object_id: "c1111111-1111-4111-8111-111111111111", normalized_rank: 1, trigram_rank: 1 }
    ]);
  });

  it("routes a mixed Chinese-and-English query across both FTS indexes", async () => {
    const { repo } = await createRepo();
    await repo.create(
      createMemoryEntry({
        object_id: "d1111111-1111-4111-8111-111111111111",
        content: "The migration agreed to keep 中文路径 stable."
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "d2222222-2222-4222-8222-222222222222",
        run_id: "run-2",
        content: "An unrelated note about deployment scripts."
      })
    );

    const matches = await repo.searchByKeyword("workspace-1", "agreed 中文路径", 5);
    expect(matches.map((match) => match.object_id)).toEqual([
      "d1111111-1111-4111-8111-111111111111"
    ]);
  });

  it("backfills the porter FTS index from rows that pre-date the porter table", async () => {
    const { database, repo } = await createRepo();
    await repo.create(
      createMemoryEntry({
        object_id: "f1111111-1111-4111-8111-111111111111",
        content: "Indexing reconciliation collapses duplicated facts."
      })
    );

    // Simulate an existing database that pre-dates migration 077: drop the
    // porter table and its triggers, then re-run the migration's backfill +
    // trigger SQL. A correct migration must reindex the pre-existing row.
    database.connection.exec(`
      DROP TRIGGER IF EXISTS memory_content_fts_porter_ai;
      DROP TRIGGER IF EXISTS memory_content_fts_porter_ad;
      DROP TRIGGER IF EXISTS memory_content_fts_porter_au;
      DROP TABLE IF EXISTS memory_content_fts_porter;
    `);

    const migrationsDir = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../migrations"
    );
    const migrationSql = fs.readFileSync(
      path.join(migrationsDir, "077-memory-content-fts-dual.sql"),
      "utf8"
    );
    database.connection.exec(migrationSql);

    const porterRows = database.connection
      .prepare(
        `SELECT object_id FROM memory_content_fts_porter
         WHERE workspace_id = ? AND memory_content_fts_porter MATCH ?`
      )
      .all("workspace-1", '"duplicate"') as Array<{ readonly object_id: string }>;

    expect(porterRows.map((row) => row.object_id)).toEqual([
      "f1111111-1111-4111-8111-111111111111"
    ]);
  });

  it("keeps the porter FTS index live on delete and content update", async () => {
    const { database, repo } = await createRepo();
    const entry = await repo.create(
      createMemoryEntry({
        object_id: "a9999999-1111-4111-8111-111111111111",
        content: "The scheduler retried the stalled task."
      })
    );

    const porterMatch = (token: string): readonly string[] =>
      (
        database.connection
          .prepare(
            `SELECT object_id FROM memory_content_fts_porter
             WHERE workspace_id = ? AND memory_content_fts_porter MATCH ?`
          )
          .all("workspace-1", `"${token}"`) as Array<{ readonly object_id: string }>
      ).map((row) => row.object_id);

    expect(porterMatch("retry")).toEqual(["a9999999-1111-4111-8111-111111111111"]);

    await repo.update(entry.object_id, {
      content: "The scheduler cancelled the queued job.",
      updated_at: "2026-03-21T01:00:00.000Z"
    });
    expect(porterMatch("retry")).toEqual([]);
    expect(porterMatch("cancel")).toEqual(["a9999999-1111-4111-8111-111111111111"]);

    await repo.hardDeleteTombstoned(entry.object_id).catch(() => undefined);
    await repo.create(
      createMemoryEntry({
        object_id: "b9999999-2222-4222-8222-222222222222",
        run_id: "run-2",
        content: "A second deletable note about caching."
      })
    );
    database.connection
      .prepare("DELETE FROM memory_entries WHERE object_id = ?")
      .run("b9999999-2222-4222-8222-222222222222");
    expect(porterMatch("cach")).toEqual([]);
  });

  it("findBySharedDomainTags returns memories sharing >=1 tag, excludes zero-shared, is workspace-scoped, and dedupes", async () => {
    const { repo } = await createRepo();

    // shares one tag ("coffee") with the query.
    const sharesOne = createMemoryEntry({
      object_id: "11111111-1111-4111-8111-111111111111",
      domain_tags: ["coffee", "beans"]
    });
    // shares two tags -- must still appear exactly once (dedupe across the
    // json_each expansion).
    const sharesTwo = createMemoryEntry({
      object_id: "22222222-2222-4222-8222-222222222222",
      run_id: "run-2",
      domain_tags: ["coffee", "tea"]
    });
    // shares zero tags -- excluded.
    const sharesNone = createMemoryEntry({
      object_id: "33333333-3333-4333-8333-333333333333",
      run_id: "run-2",
      domain_tags: ["kettle", "mug"]
    });
    // empty tag array -- json_each yields no rows, so excluded.
    const noTags = createMemoryEntry({
      object_id: "44444444-4444-4444-8444-444444444444",
      run_id: "run-1",
      domain_tags: []
    });
    // matching tag but a DIFFERENT workspace -- must not leak across scope.
    const otherWorkspace = createMemoryEntry({
      object_id: "55555555-5555-4555-8555-555555555555",
      workspace_id: "workspace-2",
      run_id: "run-3",
      domain_tags: ["coffee"]
    });

    await repo.create(sharesOne);
    await repo.create(sharesTwo);
    await repo.create(sharesNone);
    await repo.create(noTags);
    await repo.create(otherWorkspace);

    const rows = await repo.findBySharedDomainTags("workspace-1", ["coffee", "tea"]);
    const ids = rows.map((row) => row.object_id);

    // sharesOne + sharesTwo only; each once; no zero-shared, no empty-tag,
    // no cross-workspace leak.
    expect(ids).toEqual([sharesOne.object_id, sharesTwo.object_id]);
  });

  it("findBySharedDomainTags returns empty for an empty tag query", async () => {
    const { repo } = await createRepo();
    await repo.create(createMemoryEntry({ domain_tags: ["coffee"] }));

    await expect(repo.findBySharedDomainTags("workspace-1", [])).resolves.toEqual([]);
  });

  it("findBySharedDomainTags excludes cold-tier and tombstoned rows (matches findByWorkspaceId hot scope)", async () => {
    const { repo } = await createRepo();

    const hot = createMemoryEntry({
      object_id: "1a111111-1111-4111-8111-111111111111",
      storage_tier: StorageTier.HOT,
      domain_tags: ["coffee"]
    });
    const cold = createMemoryEntry({
      object_id: "2a222222-2222-4222-8222-222222222222",
      run_id: "run-2",
      storage_tier: StorageTier.COLD,
      domain_tags: ["coffee"]
    });
    const tombstoned = createMemoryEntry({
      object_id: "3a333333-3333-4333-8333-333333333333",
      run_id: "run-2",
      storage_tier: StorageTier.HOT,
      retention_state: "tombstoned",
      domain_tags: ["coffee"]
    });

    await repo.create(hot);
    await repo.create(cold);
    await repo.create(tombstoned);

    const rows = await repo.findBySharedDomainTags("workspace-1", ["coffee"]);
    expect(rows.map((row) => row.object_id)).toEqual([hot.object_id]);
  });

  it("findByEvidenceRefs warns at the input cap and stays fail-safe", async () => {
    const { database } = await createRepo();
    const diagnostics = vi.fn<MemoryEntryRepoDiagnosticSink>();
    const repo = new SqliteMemoryEntryRepo(database, diagnostics);

    // input over the cap -> ids beyond the cap are never queried (fail-safe),
    // and the warn-level diagnostic surfaces the over-cap input to operators.
    const overCap = Array.from(
      { length: FIND_BY_EVIDENCE_REFS_INPUT_CAP + 5 },
      (_unused, index) => `evidence-${index}`
    );
    await repo.findByEvidenceRefs("workspace-1", overCap);

    expect(diagnostics).toHaveBeenCalledTimes(1);
    expect(diagnostics).toHaveBeenCalledWith("memory evidence-ref lookup input truncated", {
      workspace_id: "workspace-1",
      input_count: FIND_BY_EVIDENCE_REFS_INPUT_CAP + 5,
      capped_count: FIND_BY_EVIDENCE_REFS_INPUT_CAP
    });
  });

  it("findByEvidenceRefs does not warn when the input is within the cap", async () => {
    const { database } = await createRepo();
    const diagnostics = vi.fn<MemoryEntryRepoDiagnosticSink>();
    const repo = new SqliteMemoryEntryRepo(database, diagnostics);

    await repo.findByEvidenceRefs("workspace-1", ["evidence-1", "evidence-2"]);

    expect(diagnostics).not.toHaveBeenCalled();
  });
});
