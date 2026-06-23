import { describe, expect, it, vi } from "vitest";
import { AcceptedBy, ConfirmationPolicy, MemoryDimension, ObjectLifecycleState, ProjectMappingEventType, ProjectMappingState, type EventLogEntry } from "@do-soul/alaya-protocol";
import { ProjectMappingService, StrictConfirmationRequired } from "../../runs/project-mapping-service.js";
import { createAnchor, createDependencies, createMemoryEntry } from "./project-mapping-service-test-fixtures.js";

describe("ProjectMappingService", () => {
it("suggests a new anchor and appends the suggestion event before persisting it", async () => {
    const order: string[] = [];
    const append = vi.fn(async (event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => {
      order.push("event_log");
      return {
        event_id: "event-suggested",
        created_at: "2026-03-28T01:00:00.000Z",
        revision: 0,
        ...event
      };
    });
    const { dependencies, appendSpy, createdAnchors } = createDependencies({
      eventLogRepo: {
        append,
        queryByEntity: vi.fn(async () => {
          order.push("event_query");
          return [];
        })
      },
      projectMappingRepo: {
        ...createDependencies().dependencies.projectMappingRepo,
        create: vi.fn(async (anchor) => {
          order.push("repo_create");
          createdAnchors.push(anchor);
        })
      }
    });
    const service = new ProjectMappingService(dependencies);

    const anchor = await service.suggest("memory-1", "workspace-1", "user_action");

    expect(order).toEqual(["event_log", "repo_create"]);
    expect(anchor).toMatchObject({
      object_id: "mapping-generated",
      global_object_id: "memory-1",
      workspace_id: "workspace-1",
      project_id: "workspace-1",
      mapping_state: ProjectMappingState.SUGGESTED,
      accepted_by: null,
      last_transition_at: "2026-03-28T01:00:00.000Z"
    });
    expect(createdAnchors).toHaveLength(1);
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: ProjectMappingEventType.PROJECT_MAPPING_SUGGESTED,
        entity_type: "project_mapping_anchor",
        entity_id: "mapping-generated",
        payload_json: expect.objectContaining({
          mapping_id: "mapping-generated",
          global_object_id: "memory-1",
          workspace_id: "workspace-1",
          initial_state: ProjectMappingState.SUGGESTED,
          suggested_at: "2026-03-28T01:00:00.000Z"
        })
      })
    );
    expect(appendSpy).not.toHaveBeenCalled();
  });

it("re-suggests a rejected anchor instead of creating a duplicate", async () => {
    const rejectedAnchor = Object.freeze(
      createAnchor({
        object_id: "mapping-rejected",
        mapping_state: ProjectMappingState.REJECTED,
        accepted_by: AcceptedBy.REVIEW
      })
    );
    const updateState = vi.fn(async () => {});
    const create = vi.fn(async () => {});
    const { dependencies, appendSpy } = createDependencies({
      projectMappingRepo: {
        create,
        findById: vi.fn(async (objectId: string) =>
          objectId === rejectedAnchor.object_id
            ? Object.freeze({
                ...rejectedAnchor,
                mapping_state: ProjectMappingState.SUGGESTED,
                accepted_by: null,
                updated_at: "2026-03-28T01:00:00.000Z",
                last_transition_at: "2026-03-28T01:00:00.000Z"
              })
            : null
        ),
        findByIds: vi.fn(async (objectIds: readonly string[]) =>
          objectIds.flatMap((objectId) => (objectId === rejectedAnchor.object_id ? [rejectedAnchor] : []))
        ),
        findByWorkspace: vi.fn(async () => []),
        findByGlobalObjectId: vi.fn(async () => rejectedAnchor),
        updateState,
        listPending: vi.fn(async () => [])
      }
    });
    const service = new ProjectMappingService(dependencies);

    const anchor = await service.suggest("memory-1", "workspace-1", "user_action");

    expect(create).not.toHaveBeenCalled();
    expect(updateState).toHaveBeenCalledWith(
      rejectedAnchor.object_id,
      ProjectMappingState.SUGGESTED,
      null,
      "2026-03-28T01:00:00.000Z"
    );
    expect(anchor.mapping_state).toBe(ProjectMappingState.SUGGESTED);
    expect(anchor.accepted_by).toBeNull();
    expect(appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: ProjectMappingEventType.PROJECT_MAPPING_STATE_CHANGED,
        entity_id: rejectedAnchor.object_id,
        payload_json: expect.objectContaining({
          from_state: ProjectMappingState.REJECTED,
          to_state: ProjectMappingState.SUGGESTED,
          accepted_by: null
        })
      })
    );
  });

it("transitions a suggested anchor to probationary", async () => {
    const suggestedAnchor = Object.freeze(createAnchor({ object_id: "mapping-probationary" }));
    const updateState = vi.fn(async () => {});
    const { dependencies, appendSpy } = createDependencies({
      projectMappingRepo: {
        create: vi.fn(async () => {}),
        findById: vi.fn(async (objectId: string) =>
          objectId === suggestedAnchor.object_id
            ? Object.freeze({
                ...suggestedAnchor,
                mapping_state: ProjectMappingState.PROBATIONARY,
                updated_at: "2026-03-28T01:00:00.000Z",
                last_transition_at: "2026-03-28T01:00:00.000Z"
              })
            : null
        ),
        findByIds: vi.fn(async (objectIds: readonly string[]) =>
          objectIds.flatMap((objectId) => (objectId === suggestedAnchor.object_id ? [suggestedAnchor] : []))
        ),
        findByWorkspace: vi.fn(async () => []),
        findByGlobalObjectId: vi.fn(async () => suggestedAnchor),
        updateState,
        listPending: vi.fn(async () => [])
      }
    });
    const service = new ProjectMappingService(dependencies);

    const anchor = await service.setProbationary(suggestedAnchor.object_id);

    expect(updateState).toHaveBeenCalledWith(
      suggestedAnchor.object_id,
      ProjectMappingState.PROBATIONARY,
      null,
      "2026-03-28T01:00:00.000Z"
    );
    expect(anchor.mapping_state).toBe(ProjectMappingState.PROBATIONARY);
    expect(appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: ProjectMappingEventType.PROJECT_MAPPING_STATE_CHANGED,
        payload_json: expect.objectContaining({
          from_state: ProjectMappingState.SUGGESTED,
          to_state: ProjectMappingState.PROBATIONARY
        })
      })
    );
  });

it("blocks batch acceptance when any anchor requires strict confirmation", async () => {
    const safeAnchor = Object.freeze(
      createAnchor({ object_id: "mapping-safe", global_object_id: "memory-safe" })
    );
    const strictAnchor = Object.freeze(
      createAnchor({ object_id: "mapping-strict", global_object_id: "memory-strict" })
    );
    const updateState = vi.fn(async () => {});
    const append = vi.fn(async (event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => ({
      event_id: `event-${event.entity_id}`,
      created_at: "2026-03-28T01:00:00.000Z",
      revision: 0,
      ...event
    }));
    const { dependencies } = createDependencies({
      projectMappingRepo: {
        create: vi.fn(async () => {}),
        findById: vi.fn(async (objectId: string) => {
          if (objectId === safeAnchor.object_id) {
            return safeAnchor;
          }

          if (objectId === strictAnchor.object_id) {
            return strictAnchor;
          }

          return null;
        }),
        findByIds: vi.fn(async (objectIds: readonly string[]) =>
          objectIds.flatMap((objectId) => {
            if (objectId === safeAnchor.object_id) {
              return [safeAnchor];
            }

            if (objectId === strictAnchor.object_id) {
              return [strictAnchor];
            }

            return [];
          })
        ),
        findByWorkspace: vi.fn(async () => []),
        findByGlobalObjectId: vi.fn(async () => null),
        updateState,
        listPending: vi.fn(async () => [])
      },
      memoryRepo: {
        findById: vi.fn(async (objectId: string) => {
          if (objectId === safeAnchor.global_object_id) {
            return createMemoryEntry({ object_id: objectId, dimension: MemoryDimension.PREFERENCE });
          }

          if (objectId === strictAnchor.global_object_id) {
            return createMemoryEntry({ object_id: objectId, dimension: MemoryDimension.HAZARD });
          }

          return null;
        }),
        findByIds: vi.fn(async (objectIds: readonly string[]) =>
          objectIds.flatMap((objectId) => {
            if (objectId === safeAnchor.global_object_id) {
              return [createMemoryEntry({ object_id: objectId, dimension: MemoryDimension.PREFERENCE })];
            }

            if (objectId === strictAnchor.global_object_id) {
              return [createMemoryEntry({ object_id: objectId, dimension: MemoryDimension.HAZARD })];
            }

            return [];
          })
        )
      },
      eventLogRepo: {
        append,
        queryByEntity: vi.fn(async () => [])
      }
    });
    const service = new ProjectMappingService(dependencies);

    await expect(
      service.batchAccept([safeAnchor.object_id, strictAnchor.object_id], AcceptedBy.USER)
    ).rejects.toEqual(new StrictConfirmationRequired([strictAnchor.object_id]));
    expect(updateState).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });

it("treats missing and tombstoned memories as per-item safe defaults for batch accept", async () => {
    const missingAnchor = Object.freeze(
      createAnchor({ object_id: "mapping-missing", global_object_id: "memory-missing" })
    );
    const tombstonedAnchor = Object.freeze(
      createAnchor({ object_id: "mapping-tombstoned", global_object_id: "memory-tombstoned" })
    );
    const acceptedAnchor = (objectId: string) =>
      Object.freeze(
        createAnchor({
          object_id: objectId,
          global_object_id:
            objectId === missingAnchor.object_id ? missingAnchor.global_object_id : tombstonedAnchor.global_object_id,
          mapping_state: ProjectMappingState.ACCEPTED,
          accepted_by: AcceptedBy.USER,
          updated_at: "2026-03-28T01:00:00.000Z",
          last_transition_at: "2026-03-28T01:00:00.000Z"
        })
      );
    const updateState = vi.fn(async () => {});
    const { dependencies } = createDependencies({
      projectMappingRepo: {
        create: vi.fn(async () => {}),
        findById: vi.fn(async (objectId: string) => {
          if (objectId === missingAnchor.object_id) {
            return acceptedAnchor(objectId);
          }

          if (objectId === tombstonedAnchor.object_id) {
            return acceptedAnchor(objectId);
          }

          return null;
        }),
        findByIds: vi.fn(async (objectIds: readonly string[]) =>
          objectIds.flatMap((objectId) => {
            if (objectId === missingAnchor.object_id || objectId === tombstonedAnchor.object_id) {
              return [acceptedAnchor(objectId)];
            }

            return [];
          })
        ),
        findByWorkspace: vi.fn(async () => []),
        findByGlobalObjectId: vi.fn(async () => null),
        updateState,
        listPending: vi.fn(async () => [])
      },
      memoryRepo: {
        findById: vi.fn(async (objectId: string) => {
          if (objectId === missingAnchor.global_object_id) {
            return null;
          }

          if (objectId === tombstonedAnchor.global_object_id) {
            return createMemoryEntry({
              object_id: objectId,
              dimension: MemoryDimension.HAZARD,
              lifecycle_state: ObjectLifecycleState.TOMBSTONE
            });
          }

          return null;
        }),
        findByIds: vi.fn(async (objectIds: readonly string[]) =>
          objectIds.flatMap((objectId) => {
            if (objectId === missingAnchor.global_object_id) {
              return [];
            }

            if (objectId === tombstonedAnchor.global_object_id) {
              return [
                createMemoryEntry({
                  object_id: objectId,
                  dimension: MemoryDimension.HAZARD,
                  lifecycle_state: ObjectLifecycleState.TOMBSTONE
                })
              ];
            }

            return [];
          })
        )
      }
    });
    const service = new ProjectMappingService(dependencies);

    const anchors = await service.batchAccept(
      [missingAnchor.object_id, tombstonedAnchor.object_id],
      AcceptedBy.USER
    );

    expect(updateState).toHaveBeenNthCalledWith(
      1,
      missingAnchor.object_id,
      ProjectMappingState.ACCEPTED,
      AcceptedBy.USER,
      "2026-03-28T01:00:00.000Z"
    );
    expect(updateState).toHaveBeenNthCalledWith(
      2,
      tombstonedAnchor.object_id,
      ProjectMappingState.ACCEPTED,
      AcceptedBy.USER,
      "2026-03-28T01:00:00.000Z"
    );
    expect(anchors).toHaveLength(2);
    expect(anchors.every((anchor) => anchor.mapping_state === ProjectMappingState.ACCEPTED)).toBe(true);
  });

it("derives strict policy from the underlying memory dimension and defaults tombstones to per-item", async () => {
    const strictAnchor = Object.freeze(
      createAnchor({ object_id: "mapping-policy-strict", global_object_id: "memory-policy-strict" })
    );
    const tombstonedAnchor = Object.freeze(
      createAnchor({
        object_id: "mapping-policy-tombstone",
        global_object_id: "memory-policy-tombstone"
      })
    );
    const { dependencies } = createDependencies({
      projectMappingRepo: {
        create: vi.fn(async () => {}),
        findById: vi.fn(async (objectId: string) => {
          if (objectId === strictAnchor.object_id) {
            return strictAnchor;
          }

          if (objectId === tombstonedAnchor.object_id) {
            return tombstonedAnchor;
          }

          return null;
        }),
        findByIds: vi.fn(async (objectIds: readonly string[]) =>
          objectIds.flatMap((objectId) => {
            if (objectId === strictAnchor.object_id) {
              return [strictAnchor];
            }

            if (objectId === tombstonedAnchor.object_id) {
              return [tombstonedAnchor];
            }

            return [];
          })
        ),
        findByWorkspace: vi.fn(async () => []),
        findByGlobalObjectId: vi.fn(async () => null),
        updateState: vi.fn(async () => {}),
        listPending: vi.fn(async () => [])
      },
      memoryRepo: {
        findById: vi.fn(async (objectId: string) => {
          if (objectId === strictAnchor.global_object_id) {
            return createMemoryEntry({ object_id: objectId, dimension: MemoryDimension.HAZARD });
          }

          if (objectId === tombstonedAnchor.global_object_id) {
            return createMemoryEntry({
              object_id: objectId,
              dimension: MemoryDimension.HAZARD,
              lifecycle_state: ObjectLifecycleState.TOMBSTONE
            });
          }

          return null;
        }),
        findByIds: vi.fn(async (objectIds: readonly string[]) =>
          objectIds.flatMap((objectId) => {
            if (objectId === strictAnchor.global_object_id) {
              return [createMemoryEntry({ object_id: objectId, dimension: MemoryDimension.HAZARD })];
            }

            if (objectId === tombstonedAnchor.global_object_id) {
              return [
                createMemoryEntry({
                  object_id: objectId,
                  dimension: MemoryDimension.HAZARD,
                  lifecycle_state: ObjectLifecycleState.TOMBSTONE
                })
              ];
            }

            return [];
          })
        )
      }
    });
    const service = new ProjectMappingService(dependencies);

    await expect(service.getConfirmationPolicy(strictAnchor.object_id)).resolves.toBe(
      ConfirmationPolicy.STRICT
    );
    await expect(service.getConfirmationPolicy(tombstonedAnchor.object_id)).resolves.toBe(
      ConfirmationPolicy.PER_ITEM
    );
  });

  it("reject returns NOT_FOUND for an anchor bound to a different workspace and does not transition", async () => {
    const anchor = Object.freeze(createAnchor({ object_id: "mapping-foreign", workspace_id: "workspace-1" }));
    const updateState = vi.fn(async () => {});
    const { dependencies, appendSpy } = createDependencies({
      projectMappingRepo: {
        create: vi.fn(async () => {}),
        findById: vi.fn(async (objectId: string) => (objectId === anchor.object_id ? anchor : null)),
        findByIds: vi.fn(async () => []),
        findByWorkspace: vi.fn(async () => []),
        findByGlobalObjectId: vi.fn(async () => anchor),
        updateState,
        listPending: vi.fn(async () => [])
      }
    });
    const service = new ProjectMappingService(dependencies);

    await expect(service.reject(anchor.object_id, "workspace-b")).rejects.toMatchObject({
      code: "NOT_FOUND"
    });
    expect(updateState).not.toHaveBeenCalled();
    expect(appendSpy).not.toHaveBeenCalled();
  });
});
