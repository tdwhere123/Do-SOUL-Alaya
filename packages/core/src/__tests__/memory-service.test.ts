import { describe, expect, it, vi } from "vitest";
import {
  FormationKind,
  MemoryDimension,
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
  readonly repoArchiveSpy: TestMock;
  readonly repoFindByScopeClassSpy: TestMock;
} {
  const appendSpy = vi.fn(async (event: Omit<EventLogEntry, "event_id" | "created_at">) => ({
    event_id: `event-${event.event_type}`,
    created_at: "2026-03-21T00:00:00.000Z",
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
        storage_tier: fields.storage_tier ?? StorageTier.HOT
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
    repoArchiveSpy,
    repoFindByScopeClassSpy
  };
}

describe("MemoryService", () => {
  it("writes soul.memory.created before persistence and runtime notification with computed revision", async () => {
    const order: string[] = [];
    const appendEvents: Array<Omit<EventLogEntry, "event_id" | "created_at">> = [];

    const { dependencies, queryByEntitySpy } = createDependencies({
      eventLogRepo: {
        append: vi.fn(async (event) => {
          order.push("event_log");
          appendEvents.push(event);
          return {
            event_id: "event-1",
            created_at: "2026-03-21T01:00:00.000Z",
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

    expect(order).toEqual(["event_query", "event_log", "repo_create", "notify"]);
    expect(created.object_id).toBe("85b3671a-d8d8-4848-9e5c-07d0a89f5ae9");
    expect(appendEvents[0]).toMatchObject({
      event_type: "soul.memory.created",
      revision: 0
    });
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

  it("writes soul.memory.updated before persistence and runtime notification with computed revision", async () => {
    const order: string[] = [];
    const existing = createMemoryEntry();

    const updateAppendSpy = vi.fn(async (event: Omit<EventLogEntry, "event_id" | "created_at">) => {
      order.push("event_log");
      return {
        event_id: "event-updated",
        created_at: "2026-03-21T02:00:00.000Z",
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

    expect(order).toEqual(["event_query", "event_log", "repo_update", "notify"]);
    expect(updated.content).toBe("Updated content");
    expect(updated.storage_tier).toBe(StorageTier.COLD);

    const emitted = updateAppendSpy.mock.calls[0][0];
    expect(emitted.revision).toBe(5);
    expect(emitted.event_type).toBe("soul.memory.updated");
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
          revisions.push(event.revision);
          order.push(`event:${event.event_type}`);
          return {
            event_id: `event-${event.event_type}`,
            created_at: "2026-03-21T03:00:00.000Z",
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
      "event_query",
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
