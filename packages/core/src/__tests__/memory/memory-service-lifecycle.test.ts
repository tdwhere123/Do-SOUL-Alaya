import { describe, expect, it, vi } from "vitest";
import { TransitionCausedBy } from "@do-soul/alaya-protocol";
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
        transitionLifecycle: vi.fn(async (_objectId: string, lifecycleState: MemoryEntry["lifecycle_state"], updatedAt: string) => {
          order.push("repo_transition");
          return Object.freeze(createMemoryEntry({ lifecycle_state: lifecycleState, updated_at: updatedAt }));
        })
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

  it("autonomousTombstone translates a storage CAS refusal after a concurrent explicit keep", async () => {
    const storageRefusal = Object.assign(new Error("storage CAS matched zero rows"), {
      name: "StorageError",
      code: "NOT_FOUND"
    });
    const findById = vi
      .fn()
      .mockResolvedValueOnce(createMemoryEntry({ lifecycle_state: "dormant", evidence_refs: [], reinforcement_count: 0 }))
      .mockResolvedValueOnce(
        createMemoryEntry({
          lifecycle_state: "dormant",
          evidence_refs: [],
          reinforcement_count: 0,
          decay_profile: "pinned"
        })
      );
    const tombstoneSpy = vi.fn(async () => {
      throw storageRefusal;
    });
    const { dependencies, appendSpy, notifySpy } = createDependencies({
      memoryEntryRepo: {
        create: vi.fn(async (entry) => entry),
        findById,
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

    expect(findById).toHaveBeenCalledTimes(2);
    expect(tombstoneSpy).toHaveBeenCalledTimes(1);
    expect(appendSpy).not.toHaveBeenCalled();
    expect(notifySpy).not.toHaveBeenCalled();
  });
});
