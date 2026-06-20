import { describe, expect, it, vi } from "vitest";
import { RevokeReason, StorageTier, type EventLogEntry } from "@do-soul/alaya-protocol";
import { MemoryService } from "../../memory/memory-service.js";
import { createDependencies, createEventLogHistory, createMemoryEntry } from "./memory-service-test-fixtures.js";

describe("MemoryService", () => {
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
