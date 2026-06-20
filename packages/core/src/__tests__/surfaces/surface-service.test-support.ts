import { vi } from "vitest";
import { SurfaceAnchorKind, SurfaceStatus, type EventLogEntry, type GovernanceDriftLease, type SurfaceAnchor, type SurfaceIdentity } from "@do-soul/alaya-protocol";
import { type SurfaceServiceDependencies } from "../../surfaces/surface-service.js";

export const SURFACE_OBJECT_ID = "11111111-1111-4111-8111-111111111111";

export const ANCHOR_OBJECT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

export type SurfaceEventDraft = Omit<EventLogEntry, "event_id" | "created_at" | "revision">;

export function createSurface(overrides: Partial<SurfaceIdentity> = {}): SurfaceIdentity {
  return {
    object_id: SURFACE_OBJECT_ID,
    object_kind: "surface_identity",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-21T00:00:00.000Z",
    updated_at: "2026-03-21T00:00:00.000Z",
    created_by: "user",
    surface_id: "surface://main",
    surface_kind: "conversation",
    surface_status: SurfaceStatus.ACTIVE,
    workspace_id: "workspace-1",
    ...overrides
  };
}

export function createAnchor(overrides: Partial<SurfaceAnchor> = {}): SurfaceAnchor {
  return {
    object_id: ANCHOR_OBJECT_ID,
    object_kind: "surface_anchor",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-21T00:00:00.000Z",
    updated_at: "2026-03-21T00:00:00.000Z",
    created_by: "user",
    surface_id: "surface://main",
    anchor_kind: SurfaceAnchorKind.PATH_FRAGMENT,
    anchor_value: "apps/core-daemon/src",
    workspace_id: "workspace-1",
    ...overrides
  };
}

export function createDriftLease(
  overrides: Partial<GovernanceDriftLease> = {}
): GovernanceDriftLease {
  return {
    lease_id: "drift-lease-1",
    workspace_id: "workspace-1",
    operation_type: "surface.transition_status",
    granted_to: "system",
    drift_id: null,
    expires_at: "2026-03-21T01:05:00.000Z",
    granted_at: "2026-03-21T01:00:00.000Z",
    ...overrides
  };
}

export function createDependencies(seed?: {
  readonly surfaces?: readonly SurfaceIdentity[];
  readonly anchors?: readonly SurfaceAnchor[];
}): {
  readonly dependencies: SurfaceServiceDependencies;
  readonly order: string[];
  readonly events: EventLogEntry[];
  readonly notifySpy: ReturnType<typeof vi.fn>;
  readonly cascaderSpy: ReturnType<typeof vi.fn>;
  readonly warnSpy: ReturnType<typeof vi.fn>;
  readonly driftService: {
    readonly acquireLease: ReturnType<typeof vi.fn>;
    readonly releaseLease: ReturnType<typeof vi.fn>;
    readonly classifyDrift: ReturnType<typeof vi.fn>;
    readonly alertOnCriticalDrift: ReturnType<typeof vi.fn>;
  };
} {
  const surfaces = new Map((seed?.surfaces ?? []).map((surface) => [surface.object_id, Object.freeze({ ...surface })]));
  const anchors = new Map((seed?.anchors ?? []).map((anchor) => [anchor.object_id, Object.freeze({ ...anchor })]));
  const events: EventLogEntry[] = [];
  const order: string[] = [];
  const notifySpy = vi.fn(async () => {});
  const cascaderSpy = vi.fn(async () => {});
  const warnSpy = vi.fn();
  const driftService = {
    acquireLease: vi.fn(async () => createDriftLease()),
    releaseLease: vi.fn(async () => {}),
    classifyDrift: vi.fn(async () => ({
      drift_id: "drift-1",
      workspace_id: "workspace-1",
      drift_type: "scope_change" as const,
      severity: "governance_critical" as const,
      affected_subject: "surface_governance::entity=status",
      description: "Surface status changed",
      detected_at: "2026-03-21T01:00:00.000Z"
    })),
    alertOnCriticalDrift: vi.fn(async () => ({
      alert_id: "alert-1",
      workspace_id: "workspace-1",
      drift_id: "drift-1",
      severity: "governance_critical" as const,
      message: "governance drift",
      alerted_at: "2026-03-21T01:00:00.000Z"
    }))
  };

  const createStoredEvent = (event: SurfaceEventDraft): EventLogEntry =>
    Object.freeze({
      event_id: `event-${events.length + 1}`,
      created_at: "2026-03-21T01:00:00.000Z",
      revision: events.filter(
        (entry) => entry.entity_type === event.entity_type && entry.entity_id === event.entity_id
      ).length,
      ...event
    });

  const dependencies: SurfaceServiceDependencies = {
    generateObjectId: () => (surfaces.size + anchors.size === 0 ? SURFACE_OBJECT_ID : ANCHOR_OBJECT_ID),
    now: () => "2026-03-21T01:00:00.000Z",
    surfaceIdentityRepo: {
      create: vi.fn(async (identity) => {
        order.push("repo_create");
        surfaces.set(identity.object_id, Object.freeze({ ...identity }));
        return Object.freeze({ ...identity });
      }),
      createWithEvent: vi.fn(async (identity, event) => {
        order.push("event_log");
        const storedEvent = createStoredEvent(event);
        events.push(storedEvent);
        order.push("repo_create");
        surfaces.set(identity.object_id, Object.freeze({ ...identity }));
        return Object.freeze({
          identity: Object.freeze({ ...identity }),
          event: storedEvent
        });
      }),
      findById: vi.fn(async (objectId) => surfaces.get(objectId) ?? null),
      findBySurfaceId: vi.fn(async (surfaceId, workspaceId) => {
        for (const surface of surfaces.values()) {
          if (surface.surface_id === surfaceId && surface.workspace_id === workspaceId) {
            return surface;
          }
        }

        return null;
      }),
      findByWorkspace: vi.fn(async (workspaceId) =>
        [...surfaces.values()]
          .filter((surface) => surface.workspace_id === workspaceId)
          .sort((left, right) => left.object_id.localeCompare(right.object_id))
      ),
      updateStatus: vi.fn(async (objectId, status, updatedAt) => {
        order.push("repo_update");
        const existing = surfaces.get(objectId);

        if (existing === undefined) {
          throw new Error(`missing surface ${objectId}`);
        }

        const updated = Object.freeze({
          ...existing,
          surface_status: status,
          updated_at: updatedAt
        });
        surfaces.set(objectId, updated);
        return updated;
      }),
      updateStatusWithEvent: vi.fn(async (objectId, status, updatedAt, event) => {
        order.push("event_log");
        const storedEvent = createStoredEvent(event);
        events.push(storedEvent);
        order.push("repo_update");
        const existing = surfaces.get(objectId);

        if (existing === undefined) {
          throw new Error(`missing surface ${objectId}`);
        }

        const updated = Object.freeze({
          ...existing,
          surface_status: status,
          updated_at: updatedAt
        });
        surfaces.set(objectId, updated);
        return Object.freeze({
          identity: updated,
          event: storedEvent
        });
      })
    },
    surfaceAnchorRepo: {
      create: vi.fn(async (anchor) => {
        order.push("anchor_create");
        anchors.set(anchor.object_id, Object.freeze({ ...anchor }));
        return Object.freeze({ ...anchor });
      }),
      createWithEvent: vi.fn(async (anchor, event) => {
        order.push("event_log");
        const storedEvent = createStoredEvent(event);
        events.push(storedEvent);
        order.push("anchor_create");
        anchors.set(anchor.object_id, Object.freeze({ ...anchor }));
        return Object.freeze({
          anchor: Object.freeze({ ...anchor }),
          event: storedEvent
        });
      }),
      findById: vi.fn(async (objectId) => anchors.get(objectId) ?? null),
      findBySurfaceId: vi.fn(async (surfaceId, workspaceId) =>
        [...anchors.values()].filter(
          (anchor) => anchor.surface_id === surfaceId && anchor.workspace_id === workspaceId
        )
      ),
      delete: vi.fn(async (objectId) => {
        order.push("anchor_delete");
        anchors.delete(objectId);
      }),
      deleteWithEvent: vi.fn(async (objectId, event) => {
        order.push("event_log");
        const storedEvent = createStoredEvent(event);
        events.push(storedEvent);
        order.push("anchor_delete");
        anchors.delete(objectId);
        return storedEvent;
      })
    },
    runtimeNotifier: {
      notifyEntry: notifySpy
    },
    surfaceBindingCascader: {
      cascadeDetachBySurfaceId: cascaderSpy
    },
    surfaceDriftService: driftService,
    warn: warnSpy
  };

  return { dependencies, order, events, notifySpy, cascaderSpy, warnSpy, driftService };
}
