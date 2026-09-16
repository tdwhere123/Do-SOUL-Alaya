import { describe, expect, it, vi } from "vitest";
import { AcceptedBy, MemoryDimension, type EventLogEntry, type ProjectMappingAnchor } from "@do-soul/alaya-protocol";
import { ProjectMappingService } from "../../../runtime/runs/project-mapping-service.js";
import { createAnchor, createDependencies, createMemoryEntry } from "./project-mapping-service-test-fixtures.js";

describe("ProjectMappingService", () => {
it("loads anchors and memories in batches during batchAccept", async () => {
    const firstAnchor = Object.freeze(
      createAnchor({ object_id: "mapping-batch-1", global_object_id: "memory-batch-1" })
    );
    const secondAnchor = Object.freeze(
      createAnchor({ object_id: "mapping-batch-2", global_object_id: "memory-batch-2" })
    );
    const anchorsById = new Map<string, ProjectMappingAnchor>([
      [firstAnchor.object_id, firstAnchor],
      [secondAnchor.object_id, secondAnchor]
    ]);
    const findById = vi.fn(async () => {
      throw new Error("batchAccept should not call projectMappingRepo.findById");
    });
    const findByIds = vi.fn(async (objectIds: readonly string[]) =>
      objectIds.flatMap((objectId) => {
        const anchor = anchorsById.get(objectId);
        return anchor === undefined ? [] : [anchor];
      })
    );
    const updateState = vi.fn(
      async (
        objectId: string,
        newState: ProjectMappingAnchor["mapping_state"],
        nextAcceptedBy: ProjectMappingAnchor["accepted_by"],
        transitionedAt: string
      ) => {
        const anchor = anchorsById.get(objectId);

        if (anchor === undefined) {
          throw new Error(`missing anchor ${objectId}`);
        }

      anchorsById.set(
        objectId,
        Object.freeze({
          ...anchor,
          mapping_state: newState,
          accepted_by: nextAcceptedBy,
          updated_at: transitionedAt,
          last_transition_at: transitionedAt
          })
        );
      }
    );
    const findMemoryById = vi.fn(async () => {
      throw new Error("batchAccept should not call memoryRepo.findById");
    });
    const findMemoryByIds = vi.fn(async (_workspaceId: string, objectIds: readonly string[]) =>
      objectIds.flatMap((objectId) => {
        if (objectId === firstAnchor.global_object_id) {
          return [createMemoryEntry({ object_id: objectId, dimension: MemoryDimension.PREFERENCE })];
        }

        if (objectId === secondAnchor.global_object_id) {
          return [createMemoryEntry({ object_id: objectId, dimension: MemoryDimension.GLOSSARY })];
        }

        return [];
      })
    );
    const { dependencies } = createDependencies({
      projectMappingRepo: {
        ...createDependencies().dependencies.projectMappingRepo,
        findById,
        findByIds,
        updateState
      },
      memoryRepo: {
        findById: findMemoryById,
        findByIds: findMemoryByIds
      }
    });
    const service = new ProjectMappingService(dependencies);

    const anchors = await service.batchAccept(
      [secondAnchor.object_id, firstAnchor.object_id],
      AcceptedBy.USER
    );

    expect(findByIds).toHaveBeenCalledWith([secondAnchor.object_id, firstAnchor.object_id]);
    expect(findMemoryByIds).toHaveBeenCalledWith("workspace-1", [secondAnchor.global_object_id, firstAnchor.global_object_id]);
    expect(findById).not.toHaveBeenCalled();
    expect(findMemoryById).not.toHaveBeenCalled();
    expect(anchors.map((anchor) => anchor.object_id)).toEqual([secondAnchor.object_id, firstAnchor.object_id]);
  });

it("fails batchAccept when a requested anchor is missing from the batch lookup", async () => {
    const anchor = Object.freeze(createAnchor({ object_id: "mapping-present", global_object_id: "memory-present" }));
    const { dependencies } = createDependencies({
      projectMappingRepo: {
        ...createDependencies().dependencies.projectMappingRepo,
        findByIds: vi.fn(async () => [anchor])
      }
    });
    const service = new ProjectMappingService(dependencies);

    await expect(service.batchAccept([anchor.object_id, "mapping-missing"], AcceptedBy.USER)).rejects.toMatchObject({
      code: "NOT_FOUND"
    });
  });

it("rolls back the suggestion EventLog row when mapping create throws", async () => {
    const appended: EventLogEntry[] = [];
    const { dependencies } = createDependencies({
      eventLogRepo: {
        append: (event) => {
          const entry = {
            event_id: `event-${appended.length + 1}`,
            created_at: "2026-03-28T01:00:00.000Z",
            revision: appended.length,
            ...event
          };
          appended.push(entry);
          return entry;
        },
        queryByEntity: vi.fn(async () => appended),
        transactional: <T>(fn: () => T): T => {
          const snapshot = appended.length;
          try {
            return fn();
          } catch (error) {
            appended.length = snapshot;
            throw error;
          }
        }
      },
      projectMappingRepo: {
        ...createDependencies().dependencies.projectMappingRepo,
        create: () => {
          throw new Error("insert failed");
        }
      }
    });
    const service = new ProjectMappingService(dependencies);

    await expect(service.suggest("memory-1", "workspace-1", "user_action")).rejects.toThrow("insert failed");
    expect(appended).toEqual([]);
  });

it("rolls back the transition EventLog row when mapping update throws", async () => {
    const anchor = Object.freeze(createAnchor({ object_id: "mapping-transition-fail" }));
    const appended: EventLogEntry[] = [];
    const { dependencies } = createDependencies({
      eventLogRepo: {
        append: (event) => {
          const entry = {
            event_id: `event-${appended.length + 1}`,
            created_at: "2026-03-28T01:00:00.000Z",
            revision: appended.length,
            ...event
          };
          appended.push(entry);
          return entry;
        },
        queryByEntity: vi.fn(async () => appended),
        transactional: <T>(fn: () => T): T => {
          const snapshot = appended.length;
          try {
            return fn();
          } catch (error) {
            appended.length = snapshot;
            throw error;
          }
        }
      },
      projectMappingRepo: {
        ...createDependencies().dependencies.projectMappingRepo,
        findById: vi.fn(async (objectId: string) => (objectId === anchor.object_id ? anchor : null)),
        updateState: () => {
          throw new Error("update failed");
        }
      }
    });
    const service = new ProjectMappingService(dependencies);

    await expect(service.reject(anchor.object_id)).rejects.toThrow("update failed");
    expect(appended).toEqual([]);
  });
});
