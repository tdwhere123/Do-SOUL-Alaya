import { describe, expect, it, vi } from "vitest";
import { TransitionCausedBy, type EventLogEntry, type MemoryEntry } from "@do-soul/alaya-protocol";
import { MemoryService } from "../../memory/memory-service.js";
import { createDependencies, createMemoryEntry } from "./memory-service-test-fixtures.js";

describe("MemoryService", () => {
it("rejects lifecycle transitions without a repo port before appending EventLog entries", async () => {
    const { dependencies, appendSpy, notifySpy } = createDependencies();
    const service = new MemoryService(dependencies);

    await expect(
      service.transitionLifecycle(
        "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
        "tombstone",
        "janitor_gc",
        TransitionCausedBy.SYSTEM
      )
    ).rejects.toMatchObject({
      name: "CoreError",
      code: "CONFLICT",
      message: "Memory lifecycle transition port is not available"
    });

    expect(appendSpy).not.toHaveBeenCalled();
    expect(notifySpy).not.toHaveBeenCalled();
  });

it("does not append a lifecycle audit when the repo transition fails before the atomic callback", async () => {
    const transitionError = new Error("repo transition failed before audit callback");
    const transitionLifecycle = vi.fn(async () => {
      throw transitionError;
    });
    const { dependencies, appendSpy, notifySpy } = createDependencies({
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
        transitionLifecycle
      }
    });
    const service = new MemoryService(dependencies);

    await expect(
      service.transitionLifecycle(
        "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
        "dormant",
        "autonomous_dormant_demotion: task-1",
        TransitionCausedBy.DETERMINISTIC_RULE
      )
    ).rejects.toThrow(transitionError);

    expect(transitionLifecycle).toHaveBeenCalledTimes(1);
    expect(appendSpy).not.toHaveBeenCalled();
    expect(notifySpy).not.toHaveBeenCalled();
  });

it("audits an active -> dormant demotion (SOUL_MEMORY_STATE_CHANGED) BEFORE the row leaves recall via the DB mutation", async () => {
    // invariant pinned: dormancy is a recall-visibility change (dormant rows are
    // excluded from recall / list / FTS at the storage layer), so the demotion
    // MUST be audited EventLog-first — the SOUL_MEMORY_STATE_CHANGED row is
    // appended BEFORE the lifecycle_state UPDATE that removes the row from recall.
    const order: string[] = [];
    const appendEvents: Array<Omit<EventLogEntry, "event_id" | "created_at" | "revision">> = [];

    const { dependencies } = createDependencies({
      eventLogRepo: {
        append: vi.fn((event) => {
          order.push("event_log");
          appendEvents.push(event);
          return {
            event_id: "event-dormant",
            created_at: "2026-03-21T01:00:00.000Z",
            revision: 0,
            ...event
          };
        }),
        queryByEntity: vi.fn(async () => [] as readonly EventLogEntry[])
      },
      memoryEntryRepo: {
        create: vi.fn(async (entry) => Object.freeze({ ...entry })),
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
        transitionLifecycle: vi.fn(
          async (
            _objectId: string,
            lifecycleState: MemoryEntry["lifecycle_state"],
            updatedAt: string,
            onTransition?: () => void
          ) => {
            onTransition?.();
            order.push("repo_transition");
            return Object.freeze(createMemoryEntry({ lifecycle_state: lifecycleState, updated_at: updatedAt }));
          }
        )
      },
      runtimeNotifier: {
        notifyEntry: vi.fn(async () => {
          order.push("notify");
        })
      }
    });

    const service = new MemoryService(dependencies);
    const updated = await service.transitionLifecycle(
      "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
      "dormant",
      "autonomous_dormant_demotion: task-1",
      TransitionCausedBy.DETERMINISTIC_RULE
    );

    expect(order).toEqual(["event_log", "repo_transition", "notify"]);
    expect(updated.lifecycle_state).toBe("dormant");
    expect(appendEvents[0]).toMatchObject({
      event_type: "soul.memory.state_changed",
      payload_json: expect.objectContaining({
        from_state: "active",
        to_state: "dormant"
      })
    });
  });

// invariant (I-1): the audited active->dormant demotion is race-tolerant. A
  // candidate that left active between snapshot and turn resolves "skipped" (no
  // audit, no throw); a row that actually transitions gets its active->dormant
  // audit appended atomically via onTransition.
  it("demoteActiveToDormantIfActive: appends the active->dormant audit (via onTransition) and notifies on demote", async () => {
    const { dependencies, appendSpy, notifySpy } = createDependencies({
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
        transitionToDormantIfActive: vi.fn(
          async (_objectId: string, updatedAt: string, onTransition?: () => void) => {
            onTransition?.();
            return Object.freeze(createMemoryEntry({ lifecycle_state: "dormant", updated_at: updatedAt }));
          }
        )
      }
    });
    const service = new MemoryService(dependencies);

    const result = await service.demoteActiveToDormantIfActive(
      "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
      "autonomous_dormant_demotion: task-1",
      TransitionCausedBy.DETERMINISTIC_RULE
    );

    expect(result.status).toBe("demoted");
    expect(appendSpy).toHaveBeenCalledTimes(1);
    expect(appendSpy.mock.calls[0]?.[0]).toMatchObject({
      payload_json: expect.objectContaining({ from_state: "active", to_state: "dormant" })
    });
    expect(notifySpy).toHaveBeenCalledTimes(1);
  });

it("demoteActiveToDormantIfActive: SKIPS (no audit, no throw) when the guarded transition reports 0 rows (row no longer active)", async () => {
    const transitionToDormantIfActive = vi.fn(
      async (_objectId: string, _updatedAt: string, _onTransition?: () => void) => null
    );
    const { dependencies, appendSpy, notifySpy } = createDependencies({
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
        transitionToDormantIfActive
      }
    });
    const service = new MemoryService(dependencies);

    const result = await service.demoteActiveToDormantIfActive(
      "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
      "autonomous_dormant_demotion: task-1",
      TransitionCausedBy.DETERMINISTIC_RULE
    );

    expect(result.status).toBe("skipped");
    expect(transitionToDormantIfActive).toHaveBeenCalledTimes(1);
    expect(appendSpy).not.toHaveBeenCalled();
    expect(notifySpy).not.toHaveBeenCalled();
  });

it("demoteActiveToDormantIfActive: SKIPS (no audit, no transition call) when the row is no longer active at load", async () => {
    const transitionToDormantIfActive = vi.fn(
      async (_objectId: string, _updatedAt: string, _onTransition?: () => void) =>
        Object.freeze(createMemoryEntry({ lifecycle_state: "dormant" }))
    );
    const { dependencies, appendSpy, notifySpy } = createDependencies({
      memoryEntryRepo: {
        create: vi.fn(async (entry) => entry),
        // The candidate already left active (concurrent revival was reverted, or
        // an overlapping sweep moved it) by the time this turn loads it.
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
        transitionToDormantIfActive
      }
    });
    const service = new MemoryService(dependencies);

    const result = await service.demoteActiveToDormantIfActive(
      "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
      "autonomous_dormant_demotion: task-1",
      TransitionCausedBy.DETERMINISTIC_RULE
    );

    expect(result.status).toBe("skipped");
    expect(transitionToDormantIfActive).not.toHaveBeenCalled();
    expect(appendSpy).not.toHaveBeenCalled();
    expect(notifySpy).not.toHaveBeenCalled();
  });

it("does not append archive audits when the repo archive fails before the atomic callback", async () => {
    const archiveError = new Error("repo archive failed before audit callback");
    const archive = vi.fn(async () => {
      throw archiveError;
    });
    const { dependencies, appendSpy, notifySpy } = createDependencies({
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
        archive
      }
    });
    const service = new MemoryService(dependencies);

    await expect(
      service.archive(
        "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
        "manual_archive",
        TransitionCausedBy.USER
      )
    ).rejects.toThrow(archiveError);

    expect(archive).toHaveBeenCalledTimes(1);
    expect(appendSpy).not.toHaveBeenCalled();
    expect(notifySpy).not.toHaveBeenCalled();
  });

it("rejects hard delete when retention_state is not tombstoned", async () => {
    const hardDeleteSpy = vi.fn(async () => undefined);
    const { dependencies, appendSpy, notifySpy } = createDependencies({
      memoryEntryRepo: {
        create: vi.fn(async (entry) => entry),
        findById: vi.fn(async () => createMemoryEntry({ lifecycle_state: "tombstone", retention_state: "canon" })),
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
        hardDeleteTombstoned: hardDeleteSpy
      }
    });
    const service = new MemoryService(dependencies);

    await expect(
      service.hardDeleteTombstoned(
        "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
        "janitor_gc",
        TransitionCausedBy.SYSTEM
      )
    ).rejects.toMatchObject({
      name: "CoreError",
      code: "VALIDATION",
      message: "Only tombstoned memories can be hard-deleted"
    });

    expect(appendSpy).not.toHaveBeenCalled();
    expect(hardDeleteSpy).not.toHaveBeenCalled();
    expect(notifySpy).not.toHaveBeenCalled();
  });

it("rejects hard delete without a repo port before appending EventLog entries", async () => {
    const { dependencies, appendSpy, notifySpy } = createDependencies();
    const service = new MemoryService({
      ...dependencies,
      memoryEntryRepo: {
        ...dependencies.memoryEntryRepo,
        findById: vi.fn(async () =>
          createMemoryEntry({ lifecycle_state: "tombstone", retention_state: "tombstoned" })
        )
      }
    });

    await expect(
      service.hardDeleteTombstoned(
        "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
        "janitor_gc",
        TransitionCausedBy.SYSTEM
      )
    ).rejects.toMatchObject({
      name: "CoreError",
      code: "CONFLICT",
      message: "Memory tombstone delete port is not available"
    });

    expect(appendSpy).not.toHaveBeenCalled();
    expect(notifySpy).not.toHaveBeenCalled();
  });

it("does not append a deleted audit when the repo hard delete fails before the atomic callback", async () => {
    const deleteError = new Error("repo hard delete failed before audit callback");
    const hardDeleteTombstoned = vi.fn(async () => {
      throw deleteError;
    });
    const { dependencies, appendSpy, notifySpy } = createDependencies({
      memoryEntryRepo: {
        create: vi.fn(async (entry) => entry),
        findById: vi.fn(async () =>
          createMemoryEntry({ lifecycle_state: "tombstone", retention_state: "tombstoned" })
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
        hardDeleteTombstoned
      }
    });
    const service = new MemoryService(dependencies);

    await expect(
      service.hardDeleteTombstoned(
        "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
        "janitor_gc",
        TransitionCausedBy.SYSTEM
      )
    ).rejects.toThrow(deleteError);

    expect(hardDeleteTombstoned).toHaveBeenCalledTimes(1);
    expect(appendSpy).not.toHaveBeenCalled();
    expect(notifySpy).not.toHaveBeenCalled();
  });

it("autonomousHardDeleteTombstoned REFUSES a tombstoned row that has NO disposition (defense in depth)", async () => {
    const hardDeleteSpy = vi.fn(async () => true);
    const { dependencies, appendSpy, notifySpy } = createDependencies({
      memoryEntryRepo: {
        create: vi.fn(async (entry) => entry),
        // tombstoned, but forget_disposition is null (e.g. a human Inspector retire).
        findById: vi.fn(async () =>
          createMemoryEntry({ lifecycle_state: "tombstone", retention_state: "tombstoned" })
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

    await expect(
      service.autonomousHardDeleteTombstoned(
        "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
        "autonomous_tombstone_gc",
        TransitionCausedBy.DETERMINISTIC_RULE
      )
    ).rejects.toMatchObject({
      name: "CoreError",
      code: "VALIDATION",
      message: "Autonomous hard-delete refused: tombstoned row carries no forget disposition"
    });

    expect(appendSpy).not.toHaveBeenCalled();
    expect(hardDeleteSpy).not.toHaveBeenCalled();
    expect(notifySpy).not.toHaveBeenCalled();
  });

it("autonomousHardDeleteTombstoned removes a tombstoned row that carries a disposition + audits the deletion", async () => {
    const hardDeleteSpy = vi.fn(
      async (
        _objectId: string,
        options?: {
          readonly requireJudgedUselessVerdict?: boolean;
          readonly onDeleted?: () => void;
        }
      ) => {
        options?.onDeleted?.();
        return true;
      }
    );
    const { dependencies, appendSpy, notifySpy } = createDependencies({
      memoryEntryRepo: {
        create: vi.fn(async (entry) => entry),
        findById: vi.fn(async () =>
          createMemoryEntry({
            lifecycle_state: "tombstone",
            retention_state: "tombstoned",
            forget_disposition: "judged_useless",
            forget_disposition_ref: null,
            // judged_useless still holds at delete time: source-less + never
            // reinforced, so the importance gate clears it for terminal removal.
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

    await service.autonomousHardDeleteTombstoned(
      "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
      "autonomous_tombstone_gc",
      TransitionCausedBy.DETERMINISTIC_RULE
    );

    expect(hardDeleteSpy).toHaveBeenCalledTimes(1);
    expect(hardDeleteSpy).toHaveBeenCalledWith(
      "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
      expect.objectContaining({ requireJudgedUselessVerdict: true })
    );
    expect(appendSpy).toHaveBeenCalledTimes(1);
    expect(notifySpy).toHaveBeenCalledTimes(1);
  });
});
