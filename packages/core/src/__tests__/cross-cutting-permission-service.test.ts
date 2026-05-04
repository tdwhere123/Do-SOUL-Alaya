import { describe, expect, it, vi } from "vitest";
import {
  CrossCuttingState,
  SurfaceEventType,
  type CrossCuttingPermission,
  type EventLogEntry
} from "@do-soul/alaya-protocol";
import {
  CrossCuttingPermissionService,
  type CrossCuttingPermissionServiceDependencies
} from "../cross-cutting-permission-service.js";

const PERMISSION_ID_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

type CrossCuttingRecord = { readonly permission_id: string; readonly permission: CrossCuttingPermission };
type CrossCuttingEventDraft = Omit<EventLogEntry, "event_id" | "created_at" | "revision">;

function createPermission(overrides: Partial<CrossCuttingPermission> = {}): CrossCuttingPermission {
  return {
    object_id: "claim://object-1",
    object_kind: "cross_cutting_permission",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-22T00:00:00.000Z",
    updated_at: "2026-03-22T00:00:00.000Z",
    created_by: "user",
    cross_cutting_state: CrossCuttingState.NONE,
    allowed_surfaces: [],
    workspace_id: "workspace-1",
    ...overrides
  };
}

function createDependencies(seed?: {
  readonly permissions?: readonly CrossCuttingRecord[];
}): {
  readonly dependencies: CrossCuttingPermissionServiceDependencies;
  readonly events: EventLogEntry[];
  readonly order: string[];
  readonly notifySpy: ReturnType<typeof vi.fn>;
} {
  const permissionStore = new Map(
    (seed?.permissions ?? []).map((record) => [record.permission_id, Object.freeze({ ...record })])
  );

  const events: EventLogEntry[] = [];
  const order: string[] = [];
  const notifySpy = vi.fn(async () => {});

  const createStoredEvent = (event: CrossCuttingEventDraft): EventLogEntry =>
    Object.freeze({
      event_id: `event-${events.length + 1}`,
      created_at: "2026-03-22T01:00:00.000Z",
      revision: events.filter(
        (entry) => entry.entity_type === event.entity_type && entry.entity_id === event.entity_id
      ).length,
      ...event
    });

  const dependencies: CrossCuttingPermissionServiceDependencies = {
    generateObjectId: () => PERMISSION_ID_1,
    now: () => "2026-03-22T01:00:00.000Z",
    crossCuttingRepo: {
      create: vi.fn(async (permission, permissionId) => {
        order.push("permission_create");
        const record = Object.freeze({
          permission_id: permissionId,
          permission: Object.freeze({ ...permission })
        });
        permissionStore.set(permissionId, record);
        return record;
      }),
      createWithEvent: vi.fn(async (permission, permissionId, event) => {
        order.push("event_log");
        const storedEvent = createStoredEvent(event);
        events.push(storedEvent);
        order.push("permission_create");
        const record = Object.freeze({
          permission_id: permissionId,
          permission: Object.freeze({ ...permission })
        });
        permissionStore.set(permissionId, record);
        return Object.freeze({ record, event: storedEvent });
      }),
      findByPermissionId: vi.fn(async (permissionId) => permissionStore.get(permissionId) ?? null),
      findByObjectId: vi.fn(async (objectId, workspaceId) =>
        [...permissionStore.values()].find(
          (record) =>
            record.permission.object_id === objectId &&
            record.permission.workspace_id === workspaceId
        ) ?? null
      ),
      findByWorkspace: vi.fn(async (workspaceId) =>
        [...permissionStore.values()].filter((record) => record.permission.workspace_id === workspaceId)
      ),
      updateState: vi.fn(async (permissionId, state, allowedSurfaces, updatedAt) => {
        order.push("permission_update");
        const existing = permissionStore.get(permissionId);

        if (existing === undefined) {
          throw new Error(`missing permission ${permissionId}`);
        }

        const updated = Object.freeze({
          permission_id: permissionId,
          permission: Object.freeze({
            ...existing.permission,
            cross_cutting_state: state,
            allowed_surfaces: [...allowedSurfaces],
            updated_at: updatedAt
          })
        });

        permissionStore.set(permissionId, updated);
        return updated;
      }),
      updateStateWithEvent: vi.fn(async (permissionId, state, allowedSurfaces, updatedAt, event) => {
        order.push("event_log");
        const storedEvent = createStoredEvent(event);
        events.push(storedEvent);
        order.push("permission_update");
        const existing = permissionStore.get(permissionId);

        if (existing === undefined) {
          throw new Error(`missing permission ${permissionId}`);
        }

        const updated = Object.freeze({
          permission_id: permissionId,
          permission: Object.freeze({
            ...existing.permission,
            cross_cutting_state: state,
            allowed_surfaces: [...allowedSurfaces],
            updated_at: updatedAt
          })
        });

        permissionStore.set(permissionId, updated);
        return Object.freeze({ record: updated, event: storedEvent });
      })
    },
    runtimeNotifier: {
      notifyEntry: notifySpy
    }
  };

  return { dependencies, events, order, notifySpy };
}

describe("CrossCuttingPermissionService", () => {
  it("creates cross_cutting permission with EventLog-first order", async () => {
    const { dependencies, events, order, notifySpy } = createDependencies();
    const service = new CrossCuttingPermissionService(dependencies);

    const created = await service.createCrossCuttingPermission({
      object_id: "claim://object-1",
      workspace_id: "workspace-1",
      created_by: "user"
    });

    expect(order).toEqual(["event_log", "permission_create"]);
    expect(created.permission_id).toBe(PERMISSION_ID_1);
    expect(created.permission.cross_cutting_state).toBe(CrossCuttingState.NONE);
    expect(events[0]?.event_type).toBe(SurfaceEventType.SOUL_CROSS_CUTTING_STATE_CHANGED);
    expect(events[0]?.payload_json).toMatchObject({ from_state: null, to_state: CrossCuttingState.NONE });
    expect(events[0]?.revision).toBe(0);
    expect(notifySpy).toHaveBeenCalledTimes(1);
  });

  it("rejects duplicate permission for same object", async () => {
    const { dependencies } = createDependencies({
      permissions: [{ permission_id: PERMISSION_ID_1, permission: createPermission() }]
    });
    const service = new CrossCuttingPermissionService(dependencies);

    await expect(
      service.createCrossCuttingPermission({
        object_id: "claim://object-1",
        workspace_id: "workspace-1",
        created_by: "user"
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("transitions states and records caused_by", async () => {
    const { dependencies, events } = createDependencies({
      permissions: [
        {
          permission_id: PERMISSION_ID_1,
          permission: createPermission({ cross_cutting_state: CrossCuttingState.CANDIDATE })
        }
      ]
    });
    const service = new CrossCuttingPermissionService(dependencies);

    const updated = await service.transitionCrossCuttingState(
      PERMISSION_ID_1,
      CrossCuttingState.ACTIVE,
      ["surface://main"],
      "review_accepted",
      "reviewer-1"
    );

    expect(updated.permission.cross_cutting_state).toBe(CrossCuttingState.ACTIVE);
    expect(updated.permission.allowed_surfaces).toEqual(["surface://main"]);
    expect(events[0]?.caused_by).toBe("reviewer-1");
    expect(events[0]?.revision).toBe(0);
  });

  it("requires non-empty allowed_surfaces when transitioning to active", async () => {
    const { dependencies } = createDependencies({
      permissions: [
        {
          permission_id: PERMISSION_ID_1,
          permission: createPermission({ cross_cutting_state: CrossCuttingState.CANDIDATE })
        }
      ]
    });
    const service = new CrossCuttingPermissionService(dependencies);

    await expect(
      service.transitionCrossCuttingState(
        PERMISSION_ID_1,
        CrossCuttingState.ACTIVE,
        [],
        "review_accepted",
        "user"
      )
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("rejects non-surface URI entries in allowed_surfaces", async () => {
    const { dependencies } = createDependencies({
      permissions: [
        {
          permission_id: PERMISSION_ID_1,
          permission: createPermission({ cross_cutting_state: CrossCuttingState.CANDIDATE })
        }
      ]
    });
    const service = new CrossCuttingPermissionService(dependencies);

    await expect(
      service.transitionCrossCuttingState(
        PERMISSION_ID_1,
        CrossCuttingState.ACTIVE,
        ["not-a-uri"],
        "review_accepted",
        "user"
      )
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("rejects control characters in allowed_surfaces", async () => {
    const { dependencies } = createDependencies({
      permissions: [
        {
          permission_id: PERMISSION_ID_1,
          permission: createPermission({ cross_cutting_state: CrossCuttingState.CANDIDATE })
        }
      ]
    });
    const service = new CrossCuttingPermissionService(dependencies);

    await expect(
      service.transitionCrossCuttingState(
        PERMISSION_ID_1,
        CrossCuttingState.ACTIVE,
        ["surface://main\u0000bad"],
        "review_accepted",
        "user"
      )
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("treats revoked as terminal", async () => {
    const { dependencies } = createDependencies({
      permissions: [
        {
          permission_id: PERMISSION_ID_1,
          permission: createPermission({ cross_cutting_state: CrossCuttingState.REVOKED })
        }
      ]
    });
    const service = new CrossCuttingPermissionService(dependencies);

    await expect(
      service.transitionCrossCuttingState(
        PERMISSION_ID_1,
        CrossCuttingState.CANDIDATE,
        [],
        "reopen",
        "user"
      )
    ).rejects.toMatchObject({ code: "VALIDATION" });

    await expect(
      service.transitionCrossCuttingState(
        PERMISSION_ID_1,
        CrossCuttingState.ACTIVE,
        ["surface://main"],
        "reopen",
        "user"
      )
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });
});
