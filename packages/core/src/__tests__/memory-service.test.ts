import { describe, expect, it, vi } from "vitest";
import {
  FormationKind,
  MemoryDimension,
  RevokeReason,
  ScopeClass,
  SourceKind,
  StorageTier,
  TransitionCausedBy,
  type EventLogEntry,
  type MemoryEntry,
  type ScopeClass as ScopeClassType
} from "@do-soul/alaya-protocol";
import {
  MemoryService,
  type MemoryEntryInput,
  type MemoryEntryRepoUpdateFields,
  type MemoryServiceDependencies
} from "../memory-service.js";
import type { TestMock } from "./mock-types.js";

function createMemoryInput(overrides: Partial<MemoryEntryInput> = {}): MemoryEntryInput {
  return {
    created_by: "user_action",
    dimension: MemoryDimension.PREFERENCE,
    source_kind: SourceKind.USER,
    formation_kind: FormationKind.EXPLICIT,
    scope_class: ScopeClass.PROJECT,
    content: "Use pnpm for all workspace commands.",
    domain_tags: ["tooling", "workflow"],
    evidence_refs: ["evidence-1", "evidence-2"],
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    storage_tier: StorageTier.HOT,
    ...overrides
  };
}

function createMemoryEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    object_id: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-21T00:00:00.000Z",
    updated_at: "2026-03-21T00:00:00.000Z",
    created_by: "user_action",
    dimension: MemoryDimension.PREFERENCE,
    source_kind: SourceKind.USER,
    formation_kind: FormationKind.EXPLICIT,
    scope_class: ScopeClass.PROJECT,
    content: "Use pnpm for all workspace commands.",
    domain_tags: ["tooling", "workflow"],
    evidence_refs: ["evidence-1", "evidence-2"],
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    storage_tier: StorageTier.HOT,
    activation_score: null,
    retention_score: null,
    manifestation_state: null,
    retention_state: null,
    decay_profile: null,
    confidence: null,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: null,
    contradiction_count: null,
    superseded_by: null,
    ...overrides
  };
}

function createEventLogHistory(maxRevision: number): readonly EventLogEntry[] {
  return [
    {
      event_id: "event-history",
      event_type: "soul.memory.created",
      entity_type: "memory_entry",
      entity_id: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
      workspace_id: "workspace-1",
      run_id: "run-1",
      caused_by: "user_action",
      revision: maxRevision,
      payload_json: {
        object_id: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
        object_kind: "memory_entry",
        workspace_id: "workspace-1",
        run_id: "run-1"
      },
      created_at: "2026-03-21T00:00:00.000Z"
    }
  ];
}

function createDependencies(overrides: Partial<MemoryServiceDependencies> = {}): {
  readonly dependencies: MemoryServiceDependencies;
  readonly appendSpy: TestMock;
  readonly queryByEntitySpy: TestMock;
  readonly evidenceFindByIdSpy: TestMock;
  readonly notifySpy: TestMock;
  readonly repoUpdateSpy: TestMock;
  readonly repoUpdateScopedSpy: TestMock;
  readonly repoArchiveSpy: TestMock;
  readonly repoFindByScopeClassSpy: TestMock;
} {
  const appendSpy = vi.fn((event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => ({
    event_id: `event-${event.event_type}`,
    created_at: "2026-03-21T00:00:00.000Z",
    revision: 0,
    ...event
  }));
  const queryByEntitySpy = vi.fn(async () => [] as readonly EventLogEntry[]);
  const evidenceFindByIdSpy = vi.fn(async () => ({ object_id: "evidence" }));
  const notifySpy = vi.fn(async () => {});
  const repoUpdateSpy = vi.fn(async (_objectId: string, fields: MemoryEntryRepoUpdateFields) =>
    Object.freeze(
      createMemoryEntry({
        updated_at: fields.updated_at,
        content: fields.content ?? "Use pnpm for all workspace commands.",
        domain_tags: fields.domain_tags ?? ["tooling", "workflow"],
        evidence_refs: fields.evidence_refs ?? ["evidence-1", "evidence-2"],
        storage_tier: fields.storage_tier ?? StorageTier.HOT,
        last_used_at: fields.last_used_at ?? null,
        last_hit_at: fields.last_hit_at ?? null
      })
    )
  );
  const repoUpdateScopedSpy = vi.fn(async (_objectId: string, workspaceId: string, fields: MemoryEntryRepoUpdateFields) =>
    Object.freeze(
      createMemoryEntry({
        workspace_id: workspaceId,
        updated_at: fields.updated_at,
        content: fields.content ?? "Use pnpm for all workspace commands.",
        domain_tags: fields.domain_tags ?? ["tooling", "workflow"],
        evidence_refs: fields.evidence_refs ?? ["evidence-1", "evidence-2"],
        storage_tier: fields.storage_tier ?? StorageTier.HOT,
        last_used_at: fields.last_used_at ?? null,
        last_hit_at: fields.last_hit_at ?? null
      })
    )
  );
  const repoArchiveSpy = vi.fn(async (_objectId: string, updatedAt: string) =>
    Object.freeze(createMemoryEntry({ lifecycle_state: "archived", updated_at: updatedAt }))
  );
  const repoFindByScopeClassSpy = vi.fn(async () => [Object.freeze(createMemoryEntry())]);

  const dependencies: MemoryServiceDependencies = {
    now: () => "2026-03-21T01:00:00.000Z",
    generateObjectId: () => "85b3671a-d8d8-4848-9e5c-07d0a89f5ae9",
    evidenceService: {
      findById: evidenceFindByIdSpy
    },
    eventLogRepo: {
      append: appendSpy,
      queryByEntity: queryByEntitySpy
    },
    memoryEntryRepo: {
      create: vi.fn(async (entry) => Object.freeze({ ...entry })),
      findById: vi.fn(async () => createMemoryEntry()),
      findByWorkspaceId: vi.fn(async () => []),
      findByRunId: vi.fn(async () => []),
      findByDimension: vi.fn(async () => []),
      findByScopeClass: repoFindByScopeClassSpy,
      update: repoUpdateSpy,
      updateScoped: repoUpdateScopedSpy,
      archive: repoArchiveSpy
    },
    runtimeNotifier: {
      notifyEntry: notifySpy
    },
    ...overrides
  };

  return {
    dependencies,
    appendSpy,
    queryByEntitySpy,
    evidenceFindByIdSpy,
    notifySpy,
    repoUpdateSpy,
    repoUpdateScopedSpy,
    repoArchiveSpy,
    repoFindByScopeClassSpy
  };
}

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
    const hardDeleteSpy = vi.fn(async () => true);
    const { dependencies, appendSpy, notifySpy } = createDependencies({
      memoryEntryRepo: {
        create: vi.fn(async (entry) => entry),
        findById: vi.fn(async () =>
          createMemoryEntry({
            lifecycle_state: "tombstone",
            retention_state: "tombstoned",
            forget_disposition: "judged_useless",
            forget_disposition_ref: null
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
    expect(appendSpy).toHaveBeenCalledTimes(1);
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

  it("writes archive and state_changed events before persistence with consecutive revisions", async () => {
    const order: string[] = [];
    const revisions: number[] = [];
    const existing = createMemoryEntry();

    const { dependencies } = createDependencies({
      eventLogRepo: {
        queryByEntity: vi.fn(async () => {
          order.push("event_query");
          return createEventLogHistory(6);
        }),
        append: vi.fn(async (event) => {
          const persistedRevision = revisions.length + 7;
          revisions.push(persistedRevision);
          order.push(`event:${event.event_type}`);
          return {
            event_id: `event-${event.event_type}`,
            created_at: "2026-03-21T03:00:00.000Z",
            revision: persistedRevision,
            ...event
          };
        })
      },
      memoryEntryRepo: {
        create: vi.fn(async (entry) => entry),
        findById: vi.fn(async () => existing),
        findByWorkspaceId: vi.fn(async () => []),
        findByRunId: vi.fn(async () => []),
        findByDimension: vi.fn(async () => []),
        findByScopeClass: vi.fn(async () => []),
        update: vi.fn(async () => {
          throw new Error("not used");
        }),
        archive: vi.fn(async (_objectId, updatedAt) => {
          order.push("repo_archive");
          return Object.freeze({
            ...existing,
            lifecycle_state: "archived",
            updated_at: updatedAt
          });
        })
      },
      runtimeNotifier: {
        notifyEntry: vi.fn(async () => {
          order.push("notify");
        })
      }
    });

    const service = new MemoryService(dependencies);

    const archived = await service.archive(
      existing.object_id,
      "user_archived",
      TransitionCausedBy.USER
    );

    expect(revisions).toEqual([7, 8]);
    expect(order).toEqual([
      "event:soul.memory.archived",
      "event:soul.memory.state_changed",
      "repo_archive",
      "notify",
      "notify"
    ]);
    expect(archived.lifecycle_state).toBe("archived");
  });

  it("rejects archive for missing memory entries", async () => {
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

    await expect(
      service.archive("missing", "user_archived", TransitionCausedBy.USER)
    ).rejects.toMatchObject({
      name: "CoreError",
      code: "NOT_FOUND",
      message: "Memory entry not found"
    });
  });

  it("rejects archive when memory is already archived", async () => {
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
      service.archive("70a0b18b-5f8b-4fd2-a1b0-97ce48113fca", "user_archived", TransitionCausedBy.USER)
    ).rejects.toMatchObject({
      name: "CoreError",
      code: "VALIDATION",
      message: "Memory entry is already archived"
    });
  });

  it("delegates findByScopeClass to memoryEntryRepo", async () => {
    const expected = [Object.freeze(createMemoryEntry({ object_id: "scope-row" }))];
    const findByScopeClass = vi.fn(async () => expected);
    const { dependencies } = createDependencies({
      memoryEntryRepo: {
        create: vi.fn(async (entry) => entry),
        findById: vi.fn(async () => null),
        findByWorkspaceId: vi.fn(async () => []),
        findByRunId: vi.fn(async () => []),
        findByDimension: vi.fn(async () => []),
        findByScopeClass,
        update: vi.fn(async () => {
          throw new Error("not used");
        }),
        archive: vi.fn(async () => {
          throw new Error("not used");
        })
      }
    });

    const service = new MemoryService(dependencies);
    const rows = await service.findByScopeClass("workspace-1", ScopeClass.PROJECT as ScopeClassType);

    expect(findByScopeClass).toHaveBeenCalledWith("workspace-1", ScopeClass.PROJECT);
    expect(rows).toEqual(expected);
  });

  it("validates factual policy boundary using explicit condition checks", () => {
    const { dependencies } = createDependencies();
    const service = new MemoryService(dependencies);

    const factEntry = createMemoryEntry({ dimension: MemoryDimension.FACT });

    expect(
      service.validateFactualPolicyBoundary(factEntry, {
        affects_execution_paths: false,
        affects_tool_choices: true,
        affects_write_permissions: false,
        affects_governance_decisions: false
      })
    ).toBe(true);

    expect(
      service.validateFactualPolicyBoundary(factEntry, {
        affects_execution_paths: false,
        affects_tool_choices: false,
        affects_write_permissions: false,
        affects_governance_decisions: false
      })
    ).toBe(false);

    expect(
      service.validateFactualPolicyBoundary(createMemoryEntry(), {
        affects_execution_paths: true,
        affects_tool_choices: false,
        affects_write_permissions: false,
        affects_governance_decisions: false
      })
    ).toBe(false);
  });
  it("notifies greenService after create", async () => {
    const reevaluateSpy = vi.fn(async () => undefined);
    const { dependencies } = createDependencies({
      greenService: {
        reevaluate: reevaluateSpy
      }
    });

    const service = new MemoryService(dependencies);
    const created = await service.create(createMemoryInput());

    await Promise.resolve();
    expect(reevaluateSpy).toHaveBeenCalledWith({
      targetObjectId: created.object_id,
      workspaceId: created.workspace_id
    });
  });


});
