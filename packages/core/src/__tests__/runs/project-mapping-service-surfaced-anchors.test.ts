import { describe, expect, it, vi } from "vitest";
import {
  AcceptedBy,
  ProjectMappingEventType,
  ProjectMappingState,
  type ProjectMappingAnchor
} from "@do-soul/alaya-protocol";
import { ProjectMappingService } from "../../runs/project-mapping-service.js";
import {
  createAnchor,
  createDependencies
} from "./project-mapping-service-test-fixtures.js";

describe("ProjectMappingService", () => {
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
