import { describe, expect, it, vi } from "vitest";
import {
  AcceptedBy,
  ConfirmationPolicy,
  MemoryDimension,
  ObjectLifecycleState,
  ProjectMappingEventType,
  ProjectMappingState,
  ScopeClass,
  type EventLogEntry,
  type MemoryEntry,
  type ProjectMappingAnchor
} from "@do-soul/alaya-protocol";
import {
  ProjectMappingService,
  StrictConfirmationRequired,
  type ProjectMappingServiceDependencies
} from "../project-mapping-service.js";

function createMemoryEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    object_id: "memory-1",
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: ObjectLifecycleState.ACTIVE,
    created_at: "2026-03-28T00:00:00.000Z",
    updated_at: "2026-03-28T00:00:00.000Z",
    created_by: "system",
    dimension: MemoryDimension.PROCEDURE,
    source_kind: "user",
    formation_kind: "explicit",
    scope_class: ScopeClass.GLOBAL_DOMAIN,
    content: "Global procedure memory",
    domain_tags: ["repo"],
    evidence_refs: ["evidence-1"],
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    storage_tier: "hot",
    activation_score: 0.7,
    retention_score: 0.8,
    manifestation_state: null,
    retention_state: "working",
    decay_profile: "stable",
    confidence: 0.9,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: 1,
    contradiction_count: 0,
    superseded_by: null,
    ...overrides
  };
}

function createAnchor(overrides: Partial<ProjectMappingAnchor> = {}): ProjectMappingAnchor {
  return {
    object_id: "mapping-1",
    object_kind: "project_mapping_anchor",
    schema_version: 1,
    lifecycle_state: ObjectLifecycleState.ACTIVE,
    created_at: "2026-03-28T00:00:00.000Z",
    updated_at: "2026-03-28T00:00:00.000Z",
    created_by: "user_action",
    global_object_id: "memory-1",
    project_id: "workspace-1",
    workspace_id: "workspace-1",
    mapping_state: ProjectMappingState.SUGGESTED,
    accepted_by: null,
    last_transition_at: "2026-03-28T00:00:00.000Z",
    ...overrides
  };
}

function createDependencies(overrides: Partial<ProjectMappingServiceDependencies> = {}): {
  readonly dependencies: ProjectMappingServiceDependencies;
  readonly appendSpy: ReturnType<typeof vi.fn>;
  readonly queryByEntitySpy: ReturnType<typeof vi.fn>;
  readonly createdAnchors: ProjectMappingAnchor[];
  readonly stateUpdates: Array<{
    readonly objectId: string;
    readonly newState: ProjectMappingAnchor["mapping_state"];
    readonly acceptedBy: ProjectMappingAnchor["accepted_by"];
    readonly transitionedAt: string;
  }>;
} {
  const anchors = new Map<string, ProjectMappingAnchor>();
  const memoryEntries = new Map<string, MemoryEntry>([["memory-1", createMemoryEntry()]]);
  const createdAnchors: ProjectMappingAnchor[] = [];
  let appendedEventCount = 0;
  const stateUpdates: Array<{
    readonly objectId: string;
    readonly newState: ProjectMappingAnchor["mapping_state"];
    readonly acceptedBy: ProjectMappingAnchor["accepted_by"];
    readonly transitionedAt: string;
  }> = [];
  const appendSpy = vi.fn(async (event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => {
    appendedEventCount += 1;
    return {
      event_id: `event-${event.entity_id}-${appendedEventCount}`,
      created_at: "2026-03-28T01:00:00.000Z",
      revision: appendedEventCount,
      ...event
    };
  });
  const queryByEntitySpy = vi.fn(async () => [] as readonly EventLogEntry[]);

  const dependencies: ProjectMappingServiceDependencies = {
    now: () => "2026-03-28T01:00:00.000Z",
    generateObjectId: () => "mapping-generated",
    projectMappingRepo: {
      create: vi.fn(async (anchor) => {
        anchors.set(anchor.object_id, anchor);
        createdAnchors.push(anchor);
      }),
      findById: vi.fn(async (objectId: string) => anchors.get(objectId) ?? null),
      findByIds: vi.fn(async (objectIds: readonly string[]) =>
        [...new Set(objectIds)].flatMap((objectId) => {
          const anchor = anchors.get(objectId);
          return anchor === undefined ? [] : [anchor];
        })
      ),
      findByWorkspace: vi.fn(async (workspaceId: string, state: ProjectMappingAnchor["mapping_state"] | undefined) =>
        [...anchors.values()].filter(
          (anchor) =>
            anchor.workspace_id === workspaceId &&
            (state === undefined || anchor.mapping_state === state)
        )
      ),
      findByGlobalObjectId: vi.fn(async (globalObjectId: string, workspaceId: string) =>
        [...anchors.values()].find(
          (anchor) =>
            anchor.global_object_id === globalObjectId && anchor.workspace_id === workspaceId
        ) ?? null
      ),
      updateState: vi.fn(
        async (
          objectId: string,
          newState: ProjectMappingAnchor["mapping_state"],
          acceptedBy: ProjectMappingAnchor["accepted_by"],
          transitionedAt: string
        ) => {
          const anchor = anchors.get(objectId);
          if (anchor === undefined) {
            throw new Error(`missing anchor ${objectId}`);
          }

          stateUpdates.push({ objectId, newState, acceptedBy, transitionedAt });
          anchors.set(
            objectId,
            Object.freeze({
              ...anchor,
              mapping_state: newState,
              accepted_by: acceptedBy,
              updated_at: transitionedAt,
              last_transition_at: transitionedAt
            })
          );
        }
      ),
      listPending: vi.fn(async (workspaceId: string) =>
        [...anchors.values()].filter(
          (anchor) =>
            anchor.workspace_id === workspaceId &&
            (anchor.mapping_state === ProjectMappingState.SUGGESTED ||
              anchor.mapping_state === ProjectMappingState.PROBATIONARY)
        )
      )
    },
    memoryRepo: {
      findById: vi.fn(async (objectId: string) => memoryEntries.get(objectId) ?? null),
      findByIds: vi.fn(async (objectIds: readonly string[]) =>
        [...new Set(objectIds)].flatMap((objectId) => {
          const entry = memoryEntries.get(objectId);
          return entry === undefined ? [] : [entry];
        })
      )
    },
    eventLogRepo: {
      append: appendSpy,
      queryByEntity: queryByEntitySpy
    },
    ...overrides
  };

  return {
    dependencies,
    appendSpy,
    queryByEntitySpy,
    createdAnchors,
    stateUpdates
  };
}

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
    const findMemoryByIds = vi.fn(async (objectIds: readonly string[]) =>
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
    expect(findMemoryByIds).toHaveBeenCalledWith([secondAnchor.global_object_id, firstAnchor.global_object_id]);
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

  it("keeps the suggestion event when persistence fails after EventLog append", async () => {
    const append = vi.fn(async (event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => ({
      event_id: "event-suggested",
      created_at: "2026-03-28T01:00:00.000Z",
      revision: 0,
      ...event
    }));
    const { dependencies } = createDependencies({
      eventLogRepo: {
        append,
        queryByEntity: vi.fn(async () => [] as readonly EventLogEntry[])
      },
      projectMappingRepo: {
        ...createDependencies().dependencies.projectMappingRepo,
        create: vi.fn(async () => {
          throw new Error("insert failed");
        })
      }
    });
    const service = new ProjectMappingService(dependencies);

    await expect(service.suggest("memory-1", "workspace-1", "user_action")).rejects.toThrow("insert failed");
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: ProjectMappingEventType.PROJECT_MAPPING_SUGGESTED
      })
    );
  });

  it("keeps the transition event when state persistence fails after EventLog append", async () => {
    const anchor = Object.freeze(createAnchor({ object_id: "mapping-transition-fail" }));
    const append = vi.fn(async (event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => ({
      event_id: "event-transition",
      created_at: "2026-03-28T01:00:00.000Z",
      revision: 0,
      ...event
    }));
    const { dependencies } = createDependencies({
      eventLogRepo: {
        append,
        queryByEntity: vi.fn(async () => [] as readonly EventLogEntry[])
      },
      projectMappingRepo: {
        ...createDependencies().dependencies.projectMappingRepo,
        findById: vi.fn(async (objectId: string) => (objectId === anchor.object_id ? anchor : null)),
        updateState: vi.fn(async () => {
          throw new Error("update failed");
        })
      }
    });
    const service = new ProjectMappingService(dependencies);

    await expect(service.reject(anchor.object_id)).rejects.toThrow("update failed");
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: ProjectMappingEventType.PROJECT_MAPPING_STATE_CHANGED,
        entity_id: anchor.object_id
      })
    );
  });

  it("ensures surfaced global anchors idempotently without requiring local memory rows", async () => {
    const acceptedAnchor = Object.freeze(
      createAnchor({
        object_id: "mapping-accepted",
        global_object_id: "global-accepted",
        mapping_state: ProjectMappingState.ACCEPTED
      })
    );
    const rejectedAnchor = Object.freeze(
      createAnchor({
        object_id: "mapping-rejected",
        global_object_id: "global-rejected",
        mapping_state: ProjectMappingState.REJECTED
      })
    );
    const anchorsByGlobalObjectId = new Map<string, ProjectMappingAnchor>([
      [acceptedAnchor.global_object_id, acceptedAnchor],
      [rejectedAnchor.global_object_id, rejectedAnchor]
    ]);
    const create = vi.fn(async (anchor: ProjectMappingAnchor) => {
      anchorsByGlobalObjectId.set(anchor.global_object_id, anchor);
    });
    const findByGlobalObjectId = vi.fn(async (globalObjectId: string) =>
      anchorsByGlobalObjectId.get(globalObjectId) ?? null
    );
    const memoryFindById = vi.fn(async () => {
      throw new Error("ensureSuggestedAnchors must not require local memory lookups");
    });
    const { dependencies, appendSpy } = createDependencies({
      projectMappingRepo: {
        ...createDependencies().dependencies.projectMappingRepo,
        create,
        findByGlobalObjectId
      },
      memoryRepo: {
        findById: memoryFindById,
        findByIds: vi.fn(async () => [])
      }
    });
    const service = new ProjectMappingService(dependencies);

    const firstPass = await service.ensureSuggestedAnchors(
      ["global-accepted", "global-created", "global-created", "global-rejected"],
      "workspace-1",
      "system"
    );
    const secondPass = await service.ensureSuggestedAnchors(
      ["global-created", "global-accepted"],
      "workspace-1",
      "system"
    );

    expect(memoryFindById).not.toHaveBeenCalled();
    expect(findByGlobalObjectId).toHaveBeenCalledTimes(6);
    expect(create).toHaveBeenCalledTimes(1);
    expect(appendSpy).toHaveBeenCalledTimes(1);
    expect(firstPass.map((anchor) => anchor.global_object_id)).toEqual([
      "global-accepted",
      "global-created",
      "global-rejected"
    ]);
    expect(firstPass[0].mapping_state).toBe(ProjectMappingState.ACCEPTED);
    expect(firstPass[1].mapping_state).toBe(ProjectMappingState.SUGGESTED);
    expect(firstPass[2].mapping_state).toBe(ProjectMappingState.REJECTED);
    expect(secondPass.map((anchor) => anchor.global_object_id)).toEqual([
      "global-created",
      "global-accepted"
    ]);
    expect(appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: ProjectMappingEventType.PROJECT_MAPPING_SUGGESTED,
        payload_json: expect.objectContaining({
          global_object_id: "global-created",
          workspace_id: "workspace-1",
          initial_state: ProjectMappingState.SUGGESTED
        })
      })
    );
  });

  it("dedupes overlapping first-seen surfaced-anchor creation", async () => {
    let releaseCreate!: () => void;
    const createBarrier = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const anchorsByGlobalObjectId = new Map<string, ProjectMappingAnchor>();
    const create = vi.fn(async (anchor: ProjectMappingAnchor) => {
      await createBarrier;
      anchorsByGlobalObjectId.set(anchor.global_object_id, anchor);
    });
    const findByGlobalObjectId = vi.fn(async (globalObjectId: string) =>
      anchorsByGlobalObjectId.get(globalObjectId) ?? null
    );
    const memoryFindById = vi.fn(async () => {
      throw new Error("ensureSuggestedAnchors must not require local memory lookups");
    });
    const { dependencies, appendSpy } = createDependencies({
      projectMappingRepo: {
        ...createDependencies().dependencies.projectMappingRepo,
        create,
        findByGlobalObjectId
      },
      memoryRepo: {
        findById: memoryFindById,
        findByIds: vi.fn(async () => [])
      }
    });
    const service = new ProjectMappingService(dependencies);

    const firstPassPromise = service.ensureSuggestedAnchors(["global-created"], "workspace-1", "system");
    await Promise.resolve();
    const secondPassPromise = service.ensureSuggestedAnchors(["global-created"], "workspace-1", "system");
    releaseCreate();
    const [firstPass, secondPass] = await Promise.all([firstPassPromise, secondPassPromise]);

    expect(memoryFindById).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
    expect(appendSpy).toHaveBeenCalledTimes(1);
    expect(firstPass).toHaveLength(1);
    expect(secondPass).toHaveLength(1);
    expect(firstPass[0]).toEqual(secondPass[0]);
    expect(firstPass[0]).toMatchObject({
      global_object_id: "global-created",
      mapping_state: ProjectMappingState.SUGGESTED
    });
  });

  it("reopens rejected anchors for explicit adoption without requiring local memory rows", async () => {
    const rejectedAnchor = Object.freeze(
      createAnchor({
        object_id: "mapping-rejected-adopt",
        global_object_id: "global-rejected",
        mapping_state: ProjectMappingState.REJECTED,
        accepted_by: AcceptedBy.REVIEW
      })
    );
    const updateState = vi.fn(async () => {});
    const memoryFindById = vi.fn(async () => {
      throw new Error("ensureAdoptableAnchor must not require local memory lookups");
    });
    const { dependencies, appendSpy } = createDependencies({
      projectMappingRepo: {
        ...createDependencies().dependencies.projectMappingRepo,
        findByGlobalObjectId: vi.fn(async () => rejectedAnchor),
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
        updateState
      },
      memoryRepo: {
        findById: memoryFindById,
        findByIds: vi.fn(async () => [])
      }
    });
    const service = new ProjectMappingService(dependencies);

    const anchor = await service.ensureAdoptableAnchor("global-rejected", "workspace-1", AcceptedBy.USER);

    expect(memoryFindById).not.toHaveBeenCalled();
    expect(updateState).toHaveBeenCalledWith(
      rejectedAnchor.object_id,
      ProjectMappingState.SUGGESTED,
      null,
      "2026-03-28T01:00:00.000Z"
    );
    expect(anchor).toMatchObject({
      object_id: rejectedAnchor.object_id,
      global_object_id: rejectedAnchor.global_object_id,
      mapping_state: ProjectMappingState.SUGGESTED,
      accepted_by: null
    });
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

  it("lets explicit adopt revive a rejected anchor even while a passive surfaced-anchor ensure is in flight", async () => {
    let releaseFirstLookup!: () => void;
    const firstLookupGate = new Promise<void>((resolve) => {
      releaseFirstLookup = resolve;
    });
    const rejectedAnchor = Object.freeze(
      createAnchor({
        object_id: "mapping-mixed-overlap",
        global_object_id: "global-rejected-overlap",
        mapping_state: ProjectMappingState.REJECTED,
        accepted_by: AcceptedBy.REVIEW
      })
    );
    const anchorsByGlobalObjectId = new Map<string, ProjectMappingAnchor>([
      [rejectedAnchor.global_object_id, rejectedAnchor]
    ]);
    let lookupCount = 0;
    const findByGlobalObjectId = vi.fn(async (globalObjectId: string) => {
      lookupCount += 1;

      if (lookupCount === 1) {
        await firstLookupGate;
      }

      return anchorsByGlobalObjectId.get(globalObjectId) ?? null;
    });
    const updateState = vi.fn(
      async (
        objectId: string,
        newState: ProjectMappingAnchor["mapping_state"],
        acceptedBy: ProjectMappingAnchor["accepted_by"],
        transitionedAt: string
      ) => {
        const current = anchorsByGlobalObjectId.get(rejectedAnchor.global_object_id);

        if (current === undefined || current.object_id !== objectId) {
          throw new Error(`missing anchor ${objectId}`);
        }

        anchorsByGlobalObjectId.set(
          rejectedAnchor.global_object_id,
          Object.freeze({
            ...current,
            mapping_state: newState,
            accepted_by: acceptedBy,
            updated_at: transitionedAt,
            last_transition_at: transitionedAt
          })
        );
      }
    );
    const memoryFindById = vi.fn(async () => {
      throw new Error("global surfaced/adopt overlap must not require local memory lookups");
    });
    const { dependencies, appendSpy } = createDependencies({
      projectMappingRepo: {
        ...createDependencies().dependencies.projectMappingRepo,
        findByGlobalObjectId,
        updateState
      },
      memoryRepo: {
        findById: memoryFindById,
        findByIds: vi.fn(async () => [])
      }
    });
    const service = new ProjectMappingService(dependencies);

    const passiveEnsurePromise = service.ensureSuggestedAnchors(
      [rejectedAnchor.global_object_id],
      "workspace-1",
      "system"
    );
    await Promise.resolve();
    const adoptablePromise = service.ensureAdoptableAnchor(
      rejectedAnchor.global_object_id,
      "workspace-1",
      AcceptedBy.USER
    );
    const adoptableAnchor = await adoptablePromise;
    releaseFirstLookup();
    const passiveAnchors = await passiveEnsurePromise;

    expect(memoryFindById).not.toHaveBeenCalled();
    expect(updateState).toHaveBeenCalledTimes(1);
    expect(adoptableAnchor).toMatchObject({
      object_id: rejectedAnchor.object_id,
      global_object_id: rejectedAnchor.global_object_id,
      mapping_state: ProjectMappingState.SUGGESTED,
      accepted_by: null
    });
    expect(passiveAnchors[0]).toMatchObject({
      object_id: rejectedAnchor.object_id,
      global_object_id: rejectedAnchor.global_object_id,
      mapping_state: ProjectMappingState.SUGGESTED,
      accepted_by: null
    });
    expect(appendSpy).toHaveBeenCalledTimes(1);
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
});
