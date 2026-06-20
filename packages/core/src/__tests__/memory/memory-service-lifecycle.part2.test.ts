import { describe, expect, it, vi } from "vitest";
import { TransitionCausedBy } from "@do-soul/alaya-protocol";
import { MemoryService, type MemoryServiceDependencies } from "../../memory/memory-service.js";
import type { TestMock } from "../shared/mock-types.js";
import { createDependencies, createMemoryEntry } from "./memory-service-test-fixtures.js";

describe("MemoryService", () => {
it("autonomousHardDeleteTombstoned REFUSES a judged_useless delete when the atomic verdict guard returns 0 rows", async () => {
    const hardDeleteSpy = vi.fn(async () => false);
    const { dependencies, appendSpy, notifySpy } = createDependencies({
      memoryEntryRepo: {
        create: vi.fn(async (entry) => entry),
        findById: vi.fn(async () =>
          createMemoryEntry({
            lifecycle_state: "tombstone",
            retention_state: "tombstoned",
            forget_disposition: "judged_useless",
            forget_disposition_ref: null,
            evidence_refs: [],
            reinforcement_count: 0
          })
        ),
        findByWorkspaceId: vi.fn(async () => []),
        findByRunId: vi.fn(async () => []),
        findByDimension: vi.fn(async () => []),
        findByScopeClass: vi.fn(async () => []),
        update: vi.fn(async () => {
          throw new Error("not used");
        }),
        archive: vi.fn(async () => {
          throw new Error("not used");
        }),
        hardDeleteTombstonedWithDisposition: hardDeleteSpy
      }
    });
    const service = new MemoryService(dependencies);

    const deleted = await service.autonomousHardDeleteTombstoned(
      "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
      "autonomous_tombstone_gc",
      TransitionCausedBy.DETERMINISTIC_RULE
    );

    expect(deleted).toBe(false);
    expect(hardDeleteSpy).toHaveBeenCalledWith(
      "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
      expect.objectContaining({ requireJudgedUselessVerdict: true })
    );
    expect(appendSpy).toHaveBeenCalledTimes(1);
    expect(appendSpy.mock.calls[0]?.[0]).toMatchObject({
      payload_json: expect.objectContaining({
        to_state: "tombstone",
        reason_code: expect.stringContaining("verdict_revoked")
      })
    });
    expect(notifySpy).toHaveBeenCalledTimes(1);
  });

// invariant (delete-time verdict re-verify): a `judged_useless` tombstone that
  // GAINED evidence during the grace window no longer classifies judged_useless,
  // so the physical delete is REFUSED fail-closed — the row survives (stays
  // tombstoned) and a verdict_revoked skip event is audited.
  it("autonomousHardDeleteTombstoned REFUSES a judged_useless row that gained evidence + audits verdict_revoked", async () => {
    const hardDeleteSpy = vi.fn(async () => true);
    const { dependencies, appendSpy, notifySpy } = createDependencies({
      memoryEntryRepo: {
        create: vi.fn(async (entry) => entry),
        findById: vi.fn(async () =>
          createMemoryEntry({
            lifecycle_state: "tombstone",
            retention_state: "tombstoned",
            forget_disposition: "judged_useless",
            forget_disposition_ref: null,
            // gained evidence after marking -> importance gate now classifies
            // this as keep (evidence_basis), so the verdict no longer holds.
            evidence_refs: ["evidence-gained-during-grace"],
            reinforcement_count: 0
          })
        ),
        findByWorkspaceId: vi.fn(async () => []),
        findByRunId: vi.fn(async () => []),
        findByDimension: vi.fn(async () => []),
        findByScopeClass: vi.fn(async () => []),
        update: vi.fn(async () => {
          throw new Error("not used");
        }),
        archive: vi.fn(async () => {
          throw new Error("not used");
        }),
        hardDeleteTombstonedWithDisposition: hardDeleteSpy
      }
    });
    const service = new MemoryService(dependencies);

    const deleted = await service.autonomousHardDeleteTombstoned(
      "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
      "autonomous_tombstone_gc",
      TransitionCausedBy.DETERMINISTIC_RULE
    );

    expect(deleted).toBe(false);
    expect(hardDeleteSpy).not.toHaveBeenCalled();
    // the audited event is the verdict_revoked skip, NOT a "deleted" audit.
    expect(appendSpy).toHaveBeenCalledTimes(1);
    expect(appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        payload_json: expect.objectContaining({
          to_state: "tombstone",
          reason_code: expect.stringContaining("verdict_revoked")
        })
      })
    );
    expect(notifySpy).toHaveBeenCalledTimes(1);
  });

// invariant (B1): a `compressed` member is hard-deleted ONLY when its
  // preserving capsule is re-verified LIVE + still referencing the member at
  // delete time (>=24h after marking). Each capsule-archived/superseded/
  // dropped-member/deleted variant during the grace window MUST refuse the
  // physical delete so the preserved content can never be permanently lost.
  function compressedDeps(input: {
    readonly capsuleFindById: () => Promise<unknown>;
    readonly hardDeleteSpy: TestMock;
    readonly forgetDispositionRef?: string | null;
  }) {
    return createDependencies({
      memoryEntryRepo: {
        create: vi.fn(async (entry) => entry),
        findById: vi.fn(async () =>
          createMemoryEntry({
            lifecycle_state: "tombstone",
            retention_state: "tombstoned",
            forget_disposition: "compressed",
            forget_disposition_ref:
              input.forgetDispositionRef === undefined ? "capsule-1" : input.forgetDispositionRef
          })
        ),
        findByWorkspaceId: vi.fn(async () => []),
        findByRunId: vi.fn(async () => []),
        findByDimension: vi.fn(async () => []),
        findByScopeClass: vi.fn(async () => []),
        update: vi.fn(async () => {
          throw new Error("not used");
        }),
        archive: vi.fn(async () => {
          throw new Error("not used");
        }),
        hardDeleteTombstonedWithDisposition: input.hardDeleteSpy
      },
      synthesisCapsuleLookup: {
        findById: vi.fn(input.capsuleFindById)
      } as MemoryServiceDependencies["synthesisCapsuleLookup"]
    });
  }

function liveCapsule(overrides: Record<string, unknown> = {}) {
    return {
      object_id: "capsule-1",
      object_kind: "synthesis_capsule",
      schema_version: 1,
      lifecycle_state: "active",
      created_at: "2026-03-21T00:00:00.000Z",
      updated_at: "2026-03-21T00:00:00.000Z",
      created_by: "consolidation-executor",
      topic_key: "topic",
      synthesis_type: "cross_evidence",
      summary: "preserved content",
      evidence_refs: [],
      source_memory_refs: ["70a0b18b-5f8b-4fd2-a1b0-97ce48113fca"],
      workspace_id: "workspace-1",
      run_id: "run-1",
      synthesis_status: "stable",
      ...overrides
    };
  }

// invariant: a real disposition-gated repo runs the caller's onDeleted INSIDE
  // the delete transaction when it removes a row, so the to_state=deleted audit
  // append commits atomically with the physical delete. A success fake MUST honor
  // that contract (fire onDeleted) or the service refuses (CONFLICT: an
  // audit-less compressed delete is a forbidden crash-gap).
  function compressedHardDeleteSuccessSpy(): TestMock {
    return vi.fn(async (_objectId: string, options?: { readonly onDeleted?: () => void }) => {
      options?.onDeleted?.();
      return true;
    });
  }

it("B1: hard-deletes a compressed member only when the capsule is STILL live + references it", async () => {
    const hardDeleteSpy = compressedHardDeleteSuccessSpy();
    const { dependencies, appendSpy, notifySpy } = compressedDeps({
      capsuleFindById: async () => liveCapsule(),
      hardDeleteSpy
    });
    const service = new MemoryService(dependencies);

    await service.autonomousHardDeleteTombstoned(
      "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
      "autonomous_tombstone_gc",
      TransitionCausedBy.DETERMINISTIC_RULE
    );

    expect(hardDeleteSpy).toHaveBeenCalledTimes(1);
    // The compressed delete is routed through the atomic capsule-guarded path so
    // the preservation re-check and the physical removal are one statement.
    expect(hardDeleteSpy).toHaveBeenCalledWith(
      "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
      expect.objectContaining({ requireLiveCapsuleRef: true })
    );
    // I-2: exactly ONE "deleted" audit, appended via onDeleted (atomic with the
    // physical delete), then notified post-commit.
    expect(appendSpy).toHaveBeenCalledTimes(1);
    expect(appendSpy.mock.calls[0]?.[0]).toMatchObject({
      payload_json: expect.objectContaining({ to_state: "deleted" })
    });
    expect(notifySpy).toHaveBeenCalledTimes(1);
    expect(notifySpy.mock.calls[0]?.[0]).toMatchObject({
      payload_json: expect.objectContaining({ to_state: "deleted" })
    });
  });

it("I-2: the deleted-audit append runs INSIDE the delete (onDeleted) so an append failure fails the delete loud and never notifies", async () => {
    // The audit append is the onDeleted callback, so it runs inside the guarded
    // delete transaction. If it throws, the real repo rolls the physical delete
    // back with it; the service must surface the failure and never notify a
    // "deleted" event for a delete that did not durably commit its audit.
    const appendBoom = new Error("event log append failed mid-transaction");
    const hardDeleteSpy = vi.fn(
      async (_objectId: string, options?: { readonly onDeleted?: () => void }) => {
        options?.onDeleted?.();
        return true;
      }
    );
    const { dependencies, appendSpy, notifySpy } = compressedDeps({
      capsuleFindById: async () => liveCapsule(),
      hardDeleteSpy
    });
    appendSpy.mockImplementationOnce(() => {
      throw appendBoom;
    });
    const service = new MemoryService(dependencies);

    await expect(
      service.autonomousHardDeleteTombstoned(
        "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
        "autonomous_tombstone_gc",
        TransitionCausedBy.DETERMINISTIC_RULE
      )
    ).rejects.toThrow(appendBoom);

    expect(hardDeleteSpy).toHaveBeenCalledTimes(1);
    expect(notifySpy).not.toHaveBeenCalled();
  });

it("B5: REFUSES the delete (memory survives) when the capsule is revoked AFTER the pre-check but the atomic guarded delete removes 0 rows", async () => {
    // The lookup port reports the capsule LIVE (pre-check passes), but the atomic
    // guarded delete matches 0 rows — a concurrent capsule archive/tombstone/
    // member-drop that raced past the pre-check. The row must survive (recoverable)
    // and a preservation_revoked skip event must be audited, fail-closed.
    const hardDeleteSpy = vi.fn(async () => false);
    const { dependencies, appendSpy, notifySpy } = compressedDeps({
      capsuleFindById: async () => liveCapsule(),
      hardDeleteSpy
    });
    const service = new MemoryService(dependencies);

    const deleted = await service.autonomousHardDeleteTombstoned(
      "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
      "autonomous_tombstone_gc",
      TransitionCausedBy.DETERMINISTIC_RULE
    );

    expect(deleted).toBe(false);
    expect(hardDeleteSpy).toHaveBeenCalledWith(
      "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
      expect.objectContaining({ requireLiveCapsuleRef: true })
    );
    // The guarded delete returns 0 rows so onDeleted never fires, so the ONLY
    // emitted event is the preservation_revoked skip (no spurious "deleted"
    // audit). The memory is never notified as deleted.
    expect(appendSpy).toHaveBeenCalledTimes(1);
    expect(appendSpy.mock.calls[0]?.[0]).toMatchObject({
      payload_json: expect.objectContaining({
        to_state: "tombstone",
        reason_code: expect.stringContaining("preservation_revoked")
      })
    });
    expect(notifySpy).toHaveBeenCalledTimes(1);
    expect(notifySpy.mock.calls[0]?.[0]).toMatchObject({
      payload_json: expect.objectContaining({
        reason_code: expect.stringContaining("preservation_revoked")
      })
    });
  });

it.each([
    ["capsule archived during grace", async () => liveCapsule({ synthesis_status: "archived" })],
    ["capsule tombstoned/superseded during grace", async () => liveCapsule({ lifecycle_state: "tombstone" })],
    ["capsule dropped the member during grace", async () => liveCapsule({ source_memory_refs: [] })],
    ["capsule cascade-deleted during grace", async () => null]
  ])(
    "B1: REFUSES the physical delete (memory survives, recoverable) when %s",
    async (_label, capsuleFindById) => {
      const hardDeleteSpy = vi.fn(async () => true);
      const { dependencies, appendSpy, notifySpy } = compressedDeps({
        capsuleFindById,
        hardDeleteSpy
      });
      const service = new MemoryService(dependencies);

      // The call RESOLVES (no throw) but performs NO physical delete: the row
      // stays tombstoned and a preservation_revoked skip event is audited.
      await service.autonomousHardDeleteTombstoned(
        "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
        "autonomous_tombstone_gc",
        TransitionCausedBy.DETERMINISTIC_RULE
      );

      expect(hardDeleteSpy).not.toHaveBeenCalled();
      expect(appendSpy).toHaveBeenCalledTimes(1);
      expect(appendSpy.mock.calls[0]?.[0]).toMatchObject({
        payload_json: expect.objectContaining({
          to_state: "tombstone",
          reason_code: expect.stringContaining("preservation_revoked")
        })
      });
      expect(notifySpy).toHaveBeenCalledTimes(1);
    }
  );

it("B1: REFUSES the delete when the capsule-lookup port is unwired (fail-closed)", async () => {
    const hardDeleteSpy = vi.fn(async () => true);
    const { dependencies } = createDependencies({
      memoryEntryRepo: {
        create: vi.fn(async (entry) => entry),
        findById: vi.fn(async () =>
          createMemoryEntry({
            lifecycle_state: "tombstone",
            retention_state: "tombstoned",
            forget_disposition: "compressed",
            forget_disposition_ref: "capsule-1"
          })
        ),
        findByWorkspaceId: vi.fn(async () => []),
        findByRunId: vi.fn(async () => []),
        findByDimension: vi.fn(async () => []),
        findByScopeClass: vi.fn(async () => []),
        update: vi.fn(async () => {
          throw new Error("not used");
        }),
        archive: vi.fn(async () => {
          throw new Error("not used");
        }),
        hardDeleteTombstonedWithDisposition: hardDeleteSpy
      }
      // synthesisCapsuleLookup intentionally absent.
    });
    const service = new MemoryService(dependencies);

    await service.autonomousHardDeleteTombstoned(
      "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
      "autonomous_tombstone_gc",
      TransitionCausedBy.DETERMINISTIC_RULE
    );

    expect(hardDeleteSpy).not.toHaveBeenCalled();
  });

it("autonomousTombstone refuses a non-dormant row and only fires on dormant memories", async () => {
    const tombstoneSpy = vi.fn(async () =>
      createMemoryEntry({ lifecycle_state: "tombstone", retention_state: "tombstoned" })
    );
    const { dependencies, appendSpy } = createDependencies({
      memoryEntryRepo: {
        create: vi.fn(async (entry) => entry),
        findById: vi.fn(async () => createMemoryEntry({ lifecycle_state: "active" })),
        findByWorkspaceId: vi.fn(async () => []),
        findByRunId: vi.fn(async () => []),
        findByDimension: vi.fn(async () => []),
        findByScopeClass: vi.fn(async () => []),
        update: vi.fn(async () => {
          throw new Error("not used");
        }),
        archive: vi.fn(async () => {
          throw new Error("not used");
        }),
        autonomousTombstone: tombstoneSpy
      }
    });
    const service = new MemoryService(dependencies);

    await expect(
      service.autonomousTombstone(
        "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
        "judged_useless",
        null,
        "autonomous_forget_sweep",
        TransitionCausedBy.DETERMINISTIC_RULE
      )
    ).rejects.toMatchObject({
      name: "CoreError",
      code: "VALIDATION",
      message: "Only a dormant memory may be autonomously tombstoned"
    });

    expect(appendSpy).not.toHaveBeenCalled();
    expect(tombstoneSpy).not.toHaveBeenCalled();
  });

it("autonomousTombstone rejects a compressed disposition with no capsule ref", async () => {
    const { dependencies } = createDependencies({
      memoryEntryRepo: {
        create: vi.fn(async (entry) => entry),
        findById: vi.fn(async () => createMemoryEntry({ lifecycle_state: "dormant" })),
        findByWorkspaceId: vi.fn(async () => []),
        findByRunId: vi.fn(async () => []),
        findByDimension: vi.fn(async () => []),
        findByScopeClass: vi.fn(async () => []),
        update: vi.fn(async () => {
          throw new Error("not used");
        }),
        archive: vi.fn(async () => {
          throw new Error("not used");
        }),
        autonomousTombstone: vi.fn(async () => {
          throw new Error("not used");
        })
      }
    });
    const service = new MemoryService(dependencies);

    await expect(
      service.autonomousTombstone(
        "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
        "compressed",
        null,
        "autonomous_forget_sweep",
        TransitionCausedBy.DETERMINISTIC_RULE
      )
    ).rejects.toMatchObject({
      name: "CoreError",
      code: "VALIDATION",
      message: "compressed disposition requires a live synthesis-capsule ref"
    });
  });

// invariant: a protected dormant row that reaches the tombstone authority is
  // REFUSED fail-closed; the repo tombstone port is never called.
  it("autonomousTombstone refuses an explicitly-protected dormant row (defense in depth)", async () => {
    const tombstoneSpy = vi.fn(async () =>
      createMemoryEntry({ lifecycle_state: "tombstone", retention_state: "tombstoned" })
    );
    const { dependencies, appendSpy } = createDependencies({
      memoryEntryRepo: {
        create: vi.fn(async (entry) => entry),
        findById: vi.fn(async () =>
          createMemoryEntry({ lifecycle_state: "dormant", decay_profile: "pinned" })
        ),
        findByWorkspaceId: vi.fn(async () => []),
        findByRunId: vi.fn(async () => []),
        findByDimension: vi.fn(async () => []),
        findByScopeClass: vi.fn(async () => []),
        update: vi.fn(async () => {
          throw new Error("not used");
        }),
        archive: vi.fn(async () => {
          throw new Error("not used");
        }),
        autonomousTombstone: tombstoneSpy
      }
    });
    const service = new MemoryService(dependencies);

    await expect(
      service.autonomousTombstone(
        "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
        "judged_useless",
        null,
        "autonomous_forget_sweep",
        TransitionCausedBy.DETERMINISTIC_RULE
      )
    ).rejects.toMatchObject({
      name: "CoreError",
      code: "VALIDATION",
      message: "Autonomous tombstone refused: memory is explicitly protected (pinned/hazard/canon/consolidated)"
    });

    expect(tombstoneSpy).not.toHaveBeenCalled();
    expect(appendSpy).not.toHaveBeenCalled();
  });
});
