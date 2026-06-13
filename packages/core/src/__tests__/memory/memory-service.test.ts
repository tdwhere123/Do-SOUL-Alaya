import { describe, expect, it, vi } from "vitest";
import { RevokeReason, StorageTier } from "@do-soul/alaya-protocol";
import { MemoryService, type MemoryServiceDependencies } from "../../memory/memory-service.js";
import {
  createDependencies,
  createEventLogHistory,
  createMemoryEntry,
  createMemoryInput
} from "./memory-service-test-fixtures.js";

describe("MemoryService", () => {
  it("writes soul.memory.created before persistence and runtime notification with computed revision", async () => {
    const order: string[] = [];
    const appendEvents: Array<Omit<EventLogEntry, "event_id" | "created_at" | "revision">> = [];

    const { dependencies, queryByEntitySpy } = createDependencies({
      eventLogRepo: {
        append: vi.fn((event) => {
          order.push("event_log");
          appendEvents.push(event);
          return {
            event_id: "event-1",
            created_at: "2026-03-21T01:00:00.000Z",
            revision: 0,
            ...event
          };
        }),
        queryByEntity: vi.fn(async (...args: Parameters<MemoryServiceDependencies["eventLogRepo"]["queryByEntity"]>) => {
          order.push("event_query");
          return queryByEntitySpy(...args);
        })
      },
      memoryEntryRepo: {
        create: vi.fn(async (entry) => {
          order.push("repo_create");
          return Object.freeze({ ...entry });
        }),
        findById: vi.fn(async () => null),
        findByWorkspaceId: vi.fn(async () => []),
        findByRunId: vi.fn(async () => []),
        findByDimension: vi.fn(async () => []),
        findByScopeClass: vi.fn(async () => []),
        update: vi.fn(async () => {
          throw new Error("not used");
        }),
        archive: vi.fn(async () => {
          throw new Error("not used");
        })
      },
      runtimeNotifier: {
        notifyEntry: vi.fn(async () => {
          order.push("notify");
        })
      }
    });

    const service = new MemoryService(dependencies);
    const created = await service.create(createMemoryInput());

    expect(order).toEqual(["event_log", "repo_create", "notify"]);
    expect(created.object_id).toBe("85b3671a-d8d8-4848-9e5c-07d0a89f5ae9");
    expect(appendEvents[0]).toMatchObject({
      event_type: "soul.memory.created"
    });
  });

  it("filters cross-workspace rows from scoped batch lookups", async () => {
    const findByIds = vi.fn(async () => [
      createMemoryEntry({ object_id: "mem-1", workspace_id: "workspace-1" }),
      createMemoryEntry({ object_id: "mem-2", workspace_id: "workspace-2" }),
      createMemoryEntry({ object_id: "mem-3", workspace_id: "workspace-1" })
    ]);
    const { dependencies } = createDependencies({
      memoryEntryRepo: {
        create: vi.fn(async (entry) => Object.freeze({ ...entry })),
        findById: vi.fn(async () => null),
        findByIds,
        findByWorkspaceId: vi.fn(async () => []),
        findByRunId: vi.fn(async () => []),
        findByDimension: vi.fn(async () => []),
        findByScopeClass: vi.fn(async () => []),
        update: vi.fn(async () => {
          throw new Error("not used");
        }),
        archive: vi.fn(async () => {
          throw new Error("not used");
        })
      }
    });

    const service = new MemoryService(dependencies);
    await expect(service.findByIdsScoped(["mem-1", "mem-2", "mem-3"], "workspace-1")).resolves.toEqual([
      expect.objectContaining({ object_id: "mem-1", workspace_id: "workspace-1" }),
      expect.objectContaining({ object_id: "mem-3", workspace_id: "workspace-1" })
    ]);
    expect(findByIds).toHaveBeenCalledWith(["mem-1", "mem-2", "mem-3"]);
  });

  it("commits the enrich_pending marker atomically with the row when the create input carries the intent", async () => {
    // invariant pinned: a created memory ALWAYS carries its enrich_pending
    // marker and audit row — the EventLog append, row insert, and enqueue run
    // inside ONE storage transaction. The enqueue uses the freshly created
    // memory_id + workspace_id and the intent's run_id / source_signal_id.
    const order: string[] = [];
    const enqueueSpy = vi.fn((_params: unknown) => {
      order.push("enqueue");
    });
    const appendEvents: Array<Omit<EventLogEntry, "event_id" | "created_at" | "revision">> = [];
    const createWithinTransaction = vi.fn(
      (
        entry: MemoryEntry,
        callbacks: Parameters<NonNullable<MemoryServiceDependencies["memoryEntryRepo"]["createWithinTransaction"]>>[1]
      ): Readonly<MemoryEntry> => {
        callbacks.beforeCreate?.();
        order.push("repo_create");
        callbacks.afterCreate?.();
        return Object.freeze({ ...entry });
      }
    );
    const plainCreate = vi.fn(async (entry: MemoryEntry) => Object.freeze({ ...entry }));

    const { dependencies } = createDependencies({
      eventLogRepo: {
        append: vi.fn((event) => {
          order.push("event_log");
          appendEvents.push(event);
          return {
            event_id: "event-1",
            created_at: "2026-03-21T01:00:00.000Z",
            revision: 0,
            ...event
          };
        }),
        queryByEntity: vi.fn(async () => [])
      },
      memoryEntryRepo: {
        create: plainCreate,
        createWithinTransaction,
        findById: vi.fn(async () => null),
        findByWorkspaceId: vi.fn(async () => []),
        findByRunId: vi.fn(async () => []),
        findByDimension: vi.fn(async () => []),
        findByScopeClass: vi.fn(async () => []),
        update: vi.fn(async () => {
          throw new Error("not used");
        }),
        archive: vi.fn(async () => {
          throw new Error("not used");
        })
      },
      enrichPendingWriter: { enqueue: enqueueSpy },
      runtimeNotifier: {
        notifyEntry: vi.fn(async () => {
          order.push("notify");
        })
      }
    });

    const service = new MemoryService(dependencies);
    const created = await service.create(
      createMemoryInput({
        evidence_refs: ["evidence"],
        enqueueEnrichment: { runId: "run-7", sourceSignalId: "signal-7" }
      })
    );

    expect(plainCreate).not.toHaveBeenCalled();
    expect(createWithinTransaction).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["event_log", "repo_create", "enqueue", "notify"]);
    expect(appendEvents[0]).toMatchObject({
      event_type: "soul.memory.created",
      entity_id: created.object_id
    });
    expect(enqueueSpy).toHaveBeenCalledWith({
      workspaceId: created.workspace_id,
      memoryId: created.object_id,
      runId: "run-7",
      sourceSignalId: "signal-7"
    });
  });

  it("rolls back the whole create when the EventLog append throws before the row insert", async () => {
    const order: string[] = [];
    const enqueueSpy = vi.fn(() => {
      order.push("enqueue");
    });
    const createWithinTransaction = vi.fn(
      (
        entry: MemoryEntry,
        callbacks: Parameters<NonNullable<MemoryServiceDependencies["memoryEntryRepo"]["createWithinTransaction"]>>[1]
      ): Readonly<MemoryEntry> => {
        callbacks.beforeCreate?.();
        order.push("repo_create");
        callbacks.afterCreate?.();
        return Object.freeze({ ...entry });
      }
    );
    const plainCreate = vi.fn(async (entry: MemoryEntry) => Object.freeze({ ...entry }));
    const notifySpy = vi.fn(async () => {
      order.push("notify");
    });

    const { dependencies } = createDependencies({
      eventLogRepo: {
        append: vi.fn(() => {
          order.push("event_log");
          throw new Error("event append failed");
        }),
        queryByEntity: vi.fn(async () => [])
      },
      memoryEntryRepo: {
        create: plainCreate,
        createWithinTransaction,
        findById: vi.fn(async () => null),
        findByWorkspaceId: vi.fn(async () => []),
        findByRunId: vi.fn(async () => []),
        findByDimension: vi.fn(async () => []),
        findByScopeClass: vi.fn(async () => []),
        update: vi.fn(async () => {
          throw new Error("not used");
        }),
        archive: vi.fn(async () => {
          throw new Error("not used");
        })
      },
      enrichPendingWriter: { enqueue: enqueueSpy },
      runtimeNotifier: { notifyEntry: notifySpy }
    });

    const service = new MemoryService(dependencies);

    await expect(
      service.create(
        createMemoryInput({
          evidence_refs: ["evidence"],
          enqueueEnrichment: { runId: "run-7", sourceSignalId: "signal-7" }
        })
      )
    ).rejects.toThrow("event append failed");
    expect(order).toEqual(["event_log"]);
    expect(plainCreate).not.toHaveBeenCalled();
    expect(enqueueSpy).not.toHaveBeenCalled();
    expect(notifySpy).not.toHaveBeenCalled();
  });

  it("rolls back the whole create (no marker-less memory) when the enrich_pending enqueue throws", async () => {
    // invariant pinned: the no-drop handoff. If the marker enqueue throws inside
    // the row transaction, the row insert rolls back too — neither the memory
    // nor the marker lands, so the originating signal can replay. There is no
    // durable memory left without a marker (the silent no-drop violation).
    const order: string[] = [];
    const enqueueSpy = vi.fn(() => {
      order.push("enqueue");
      throw new Error("SQLITE_BUSY: enrich_pending insert failed");
    });
    // Mirrors connection.transaction rollback: if withinTransaction throws, the
    // row insert is not visible and the error propagates out of create.
    const createWithinTransaction = vi.fn(
      (
        _entry: MemoryEntry,
        callbacks: Parameters<NonNullable<MemoryServiceDependencies["memoryEntryRepo"]["createWithinTransaction"]>>[1]
      ): Readonly<MemoryEntry> => {
        callbacks.beforeCreate?.();
        order.push("repo_create");
        callbacks.afterCreate?.();
        throw new Error("unreachable: withinTransaction already threw");
      }
    );
    const plainCreate = vi.fn(async (entry: MemoryEntry) => Object.freeze({ ...entry }));
    const notifySpy = vi.fn(async () => {
      order.push("notify");
    });

    const { dependencies } = createDependencies({
      eventLogRepo: {
        append: vi.fn((event) => {
          order.push("event_log");
          return {
            event_id: "event-1",
            created_at: "2026-03-21T01:00:00.000Z",
            revision: 0,
            ...event
          };
        }),
        queryByEntity: vi.fn(async () => [])
      },
      memoryEntryRepo: {
        create: plainCreate,
        createWithinTransaction,
        findById: vi.fn(async () => null),
        findByWorkspaceId: vi.fn(async () => []),
        findByRunId: vi.fn(async () => []),
        findByDimension: vi.fn(async () => []),
        findByScopeClass: vi.fn(async () => []),
        update: vi.fn(async () => {
          throw new Error("not used");
        }),
        archive: vi.fn(async () => {
          throw new Error("not used");
        })
      },
      enrichPendingWriter: { enqueue: enqueueSpy },
      runtimeNotifier: { notifyEntry: notifySpy }
    });

    const service = new MemoryService(dependencies);

    await expect(
      service.create(
        createMemoryInput({
          evidence_refs: ["evidence"],
          enqueueEnrichment: { runId: "run-7", sourceSignalId: "signal-7" }
        })
      )
    ).rejects.toThrow("SQLITE_BUSY");
    expect(order).toEqual(["event_log", "repo_create", "enqueue"]);
    expect(plainCreate).not.toHaveBeenCalled();
    expect(notifySpy).not.toHaveBeenCalled();
  });

  it("throws rather than silently dropping the marker when the atomic enqueue seam is not wired", async () => {
    // invariant pinned: an enqueueEnrichment intent without the
    // createWithinTransaction capability / enrichPendingWriter must fail loud,
    // never fall back to a non-atomic create that could strand the memory.
    const { dependencies } = createDependencies();

    const service = new MemoryService(dependencies);

    await expect(
      service.create(
        createMemoryInput({
          evidence_refs: ["evidence"],
          enqueueEnrichment: { runId: "run-7", sourceSignalId: "signal-7" }
        })
      )
    ).rejects.toMatchObject({ name: "CoreError", code: "CONFLICT" });
  });

  it("rejects create when evidence_refs contains a missing reference", async () => {
    const { dependencies, appendSpy } = createDependencies({
      evidenceService: {
        findById: vi
          .fn()
          .mockResolvedValueOnce({ object_id: "evidence-1" })
          .mockResolvedValueOnce(null)
      }
    });

    const service = new MemoryService(dependencies);

    await expect(service.create(createMemoryInput())).rejects.toMatchObject({
      name: "CoreError",
      code: "VALIDATION",
      message: "Evidence reference not found: evidence-2"
    });
    expect(appendSpy).not.toHaveBeenCalled();
  });

  it("uses dynamics service defaults when provided", async () => {
    const { dependencies } = createDependencies({
      evidenceService: {
        findById: vi.fn(async () => ({ object_id: "evidence" }))
      },
      dynamicsService: {
        assignInitialDynamics: vi.fn(() => ({
          decay_profile: "stable",
          confidence: 0.9,
          retention_score: 0.9,
          retention_state: "working",
          activation_score: 0.45,
          manifestation_state: "excerpt",
          reinforcement_count: 0,
          contradiction_count: 0
        } as const))
      }
    });

    const service = new MemoryService(dependencies);
    const created = await service.create(createMemoryInput({ evidence_refs: ["evidence"] }));

    expect(created.decay_profile).toBe("stable");
    expect(created.confidence).toBe(0.9);
    expect(created.retention_score).toBe(0.9);
    expect(created.retention_state).toBe("working");
    expect(created.activation_score).toBe(0.45);
    expect(created.manifestation_state).toBe("excerpt");
    expect(created.reinforcement_count).toBe(0);
    expect(created.contradiction_count).toBe(0);
  });

  it("forces all dynamics fields to null on create", async () => {
    const { dependencies } = createDependencies({
      evidenceService: {
        findById: vi.fn(async () => ({ object_id: "evidence" }))
      }
    });

    const service = new MemoryService(dependencies);
    const created = await service.create(createMemoryInput({ evidence_refs: ["evidence"] }));

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

  it("writes soul.memory.updated after persistence and before runtime notification with computed revision", async () => {
    const order: string[] = [];
    const existing = createMemoryEntry();

    const updateAppendSpy = vi.fn(async (event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => {
      order.push("event_log");
      return {
        event_id: "event-updated",
        created_at: "2026-03-21T02:00:00.000Z",
        revision: 0,
        ...event
      };
    });

    const { dependencies } = createDependencies({
      eventLogRepo: {
        queryByEntity: vi.fn(async () => {
          order.push("event_query");
          return createEventLogHistory(4);
        }),
        append: updateAppendSpy
      },
      memoryEntryRepo: {
        create: vi.fn(async (entry) => entry),
        findById: vi.fn(async () => existing),
        findByWorkspaceId: vi.fn(async () => []),
        findByRunId: vi.fn(async () => []),
        findByDimension: vi.fn(async () => []),
        findByScopeClass: vi.fn(async () => []),
        update: vi.fn(async (_objectId, fields) => {
          order.push("repo_update");
          return Object.freeze({
            ...existing,
            content: fields.content ?? existing.content,
            evidence_refs: fields.evidence_refs ?? existing.evidence_refs,
            updated_at: fields.updated_at,
            storage_tier: fields.storage_tier ?? existing.storage_tier
          });
        }),
        archive: vi.fn(async () => {
          throw new Error("not used");
        })
      },
      runtimeNotifier: {
        notifyEntry: vi.fn(async () => {
          order.push("notify");
        })
      }
    });

    const service = new MemoryService(dependencies);
    const updated = await service.update(
      existing.object_id,
      {
        content: "Updated content",
        evidence_refs: ["evidence-3"],
        storage_tier: StorageTier.COLD
      },
      "manual_update"
    );

    expect(order).toEqual(["repo_update", "event_log", "notify"]);
    expect(updated.content).toBe("Updated content");
    expect(updated.storage_tier).toBe(StorageTier.COLD);

    const emitted = updateAppendSpy.mock.calls[0][0];
    expect(emitted).not.toHaveProperty("revision");
    expect(emitted.event_type).toBe("soul.memory.updated");
  });

  it("updates memory through the workspace-scoped repo path", async () => {
    const { dependencies, repoUpdateSpy, repoUpdateScopedSpy } = createDependencies();
    const service = new MemoryService(dependencies);

    const updated = await service.updateScoped(
      "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
      "workspace-1",
      {
        storage_tier: StorageTier.HOT,
        last_used_at: "2026-03-21T03:30:00.000Z",
        last_hit_at: "2026-03-21T03:30:00.000Z"
      },
      "recall_usage_reported"
    );

    expect(repoUpdateSpy).not.toHaveBeenCalled();
    expect(repoUpdateScopedSpy).toHaveBeenCalledWith(
      "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
      "workspace-1",
      expect.objectContaining({
        storage_tier: StorageTier.HOT,
        last_used_at: "2026-03-21T03:30:00.000Z",
        last_hit_at: "2026-03-21T03:30:00.000Z",
        updated_at: "2026-03-21T01:00:00.000Z"
      })
    );
    expect(updated.last_hit_at).toBe("2026-03-21T03:30:00.000Z");
  });

  it("revokes green mapping when an evidence rewrite removes every prior anchor", async () => {
    const pierceSpy = vi.fn(async () => undefined);
    const { dependencies } = createDependencies({
      greenService: {
        reevaluate: vi.fn(async () => undefined),
        pierce: pierceSpy
      }
    });
    const service = new MemoryService(dependencies);

    await service.update(
      "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
      { evidence_refs: ["evidence-3"] },
      "manual_update"
    );

    expect(pierceSpy).toHaveBeenCalledWith({
      targetObjectId: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
      workspaceId: "workspace-1",
      reason: RevokeReason.MAPPING_REVOKED,
      runId: "run-1"
    });
  });

  it("keeps green mapping when an evidence rewrite preserves one prior anchor", async () => {
    const pierceSpy = vi.fn(async () => undefined);
    const { dependencies } = createDependencies({
      greenService: {
        reevaluate: vi.fn(async () => undefined),
        pierce: pierceSpy
      }
    });
    const service = new MemoryService(dependencies);

    await service.update(
      "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
      { evidence_refs: ["evidence-2", "evidence-3"] },
      "manual_update"
    );

    expect(pierceSpy).not.toHaveBeenCalled();
  });

  it("rejects scoped update for a foreign workspace before EventLog append", async () => {
    const updateScopedSpy = vi.fn(async () => createMemoryEntry());
    const { dependencies, appendSpy } = createDependencies({
      memoryEntryRepo: {
        create: vi.fn(async (entry) => entry),
        findById: vi.fn(async () => createMemoryEntry({ workspace_id: "workspace-2" })),
        findByWorkspaceId: vi.fn(async () => []),
        findByRunId: vi.fn(async () => []),
        findByDimension: vi.fn(async () => []),
        findByScopeClass: vi.fn(async () => []),
        update: vi.fn(async () => {
          throw new Error("not used");
        }),
        updateScoped: updateScopedSpy,
        archive: vi.fn(async () => {
          throw new Error("not used");
        })
      }
    });
    const service = new MemoryService(dependencies);

    await expect(
      service.updateScoped(
        "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
        "workspace-1",
        { last_hit_at: "2026-03-21T03:30:00.000Z" },
        "recall_usage_reported"
      )
    ).rejects.toMatchObject({
      name: "CoreError",
      code: "NOT_FOUND",
      message: "Memory entry not found"
    });
    expect(appendSpy).not.toHaveBeenCalled();
    expect(updateScopedSpy).not.toHaveBeenCalled();
  });

  it("validates evidence_refs on update", async () => {
    const existing = createMemoryEntry();
    const appendSpy = vi.fn();

    const { dependencies } = createDependencies({
      evidenceService: {
        findById: vi.fn(async () => null)
      },
      eventLogRepo: {
        queryByEntity: vi.fn(async () => createEventLogHistory(1)),
        append: appendSpy
      },
      memoryEntryRepo: {
        create: vi.fn(async (entry) => entry),
        findById: vi.fn(async () => existing),
        findByWorkspaceId: vi.fn(async () => []),
        findByRunId: vi.fn(async () => []),
        findByDimension: vi.fn(async () => []),
        findByScopeClass: vi.fn(async () => []),
        update: vi.fn(async () => existing),
        archive: vi.fn(async () => existing)
      }
    });

    const service = new MemoryService(dependencies);

    await expect(
      service.update(existing.object_id, { evidence_refs: ["missing-evidence"] }, "manual_update")
    ).rejects.toMatchObject({
      name: "CoreError",
      code: "VALIDATION",
      message: "Evidence reference not found: missing-evidence"
    });
    expect(appendSpy).not.toHaveBeenCalled();
  });

  it("rejects update for missing memory entries", async () => {
    const { dependencies } = createDependencies({
      memoryEntryRepo: {
        create: vi.fn(async (entry) => entry),
        findById: vi.fn(async () => null),
        findByWorkspaceId: vi.fn(async () => []),
        findByRunId: vi.fn(async () => []),
        findByDimension: vi.fn(async () => []),
        findByScopeClass: vi.fn(async () => []),
        update: vi.fn(async () => {
          throw new Error("not used");
        }),
        archive: vi.fn(async () => {
          throw new Error("not used");
        })
      }
    });

    const service = new MemoryService(dependencies);

    await expect(service.update("missing", { content: "x" }, "manual_update")).rejects.toMatchObject({
      name: "CoreError",
      code: "NOT_FOUND",
      message: "Memory entry not found"
    });
  });

  it("rejects update for already archived memory entries", async () => {
    const { dependencies } = createDependencies({
      memoryEntryRepo: {
        create: vi.fn(async (entry) => entry),
        findById: vi.fn(async () => createMemoryEntry({ lifecycle_state: "archived" })),
        findByWorkspaceId: vi.fn(async () => []),
        findByRunId: vi.fn(async () => []),
        findByDimension: vi.fn(async () => []),
        findByScopeClass: vi.fn(async () => []),
        update: vi.fn(async () => {
          throw new Error("not used");
        }),
        archive: vi.fn(async () => {
          throw new Error("not used");
        })
      }
    });

    const service = new MemoryService(dependencies);

    await expect(
      service.update("70a0b18b-5f8b-4fd2-a1b0-97ce48113fca", { content: "x" }, "manual_update")
    ).rejects.toMatchObject({
      name: "CoreError",
      code: "VALIDATION",
      message: "Memory entry is archived and cannot be updated"
    });
  });

  it("rejects update when update fields are empty", async () => {
    const { dependencies } = createDependencies();
    const service = new MemoryService(dependencies);

    await expect(
      service.update("70a0b18b-5f8b-4fd2-a1b0-97ce48113fca", {}, "manual_update")
    ).rejects.toMatchObject({
      name: "CoreError",
      code: "VALIDATION",
      message: "At least one field is required for update"
    });
  });

  it("rejects update when content is empty", async () => {
    const { dependencies } = createDependencies();
    const service = new MemoryService(dependencies);

    await expect(
      service.update("70a0b18b-5f8b-4fd2-a1b0-97ce48113fca", { content: "   " }, "manual_update")
    ).rejects.toMatchObject({
      name: "CoreError",
      code: "VALIDATION",
      message: "Memory content cannot be empty"
    });
  });
});
