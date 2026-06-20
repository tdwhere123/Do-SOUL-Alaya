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

});
