import { describe, expect, it, vi } from "vitest";
import {
  MemoryDimension,
  ScopeClass,
  TransitionCausedBy,
  type ScopeClass as ScopeClassType
} from "@do-soul/alaya-protocol";
import { MemoryService } from "../../memory/memory-service.js";
import {
  createDependencies,
  createEventLogHistory,
  createMemoryEntry,
  createMemoryInput
} from "./memory-service-test-fixtures.js";

describe("MemoryService", () => {
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
        append: vi.fn((event) => {
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
        archive: vi.fn(async (_objectId, updatedAt, onArchived?: () => void) => {
          onArchived?.();
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
