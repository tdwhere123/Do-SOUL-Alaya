import { describe, expect, it, vi } from "vitest";
import {
  Phase2BEventType,
  SurfaceAnchorKind,
  SurfaceStatus,
  TransitionCausedBy,
  type EventLogEntry,
  type GovernanceDriftLease,
  type SurfaceAnchor,
  type SurfaceIdentity
} from "@do-soul/alaya-protocol";
import { CoreError } from "../errors.js";
import { SurfaceService, type SurfaceServiceDependencies } from "../surface-service.js";

const SURFACE_OBJECT_ID = "11111111-1111-4111-8111-111111111111";
const ANCHOR_OBJECT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

type SurfaceEventDraft = Omit<EventLogEntry, "event_id" | "created_at" | "revision">;

function createSurface(overrides: Partial<SurfaceIdentity> = {}): SurfaceIdentity {
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

function createAnchor(overrides: Partial<SurfaceAnchor> = {}): SurfaceAnchor {
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

function createDriftLease(
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

function createDependencies(seed?: {
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

describe("SurfaceService", () => {
  it("writes EventLog before creating surface", async () => {
    const { dependencies, order, events, notifySpy } = createDependencies();
    const service = new SurfaceService(dependencies);

    const created = await service.createSurface({
      surface_id: "surface://main",
      surface_kind: "conversation",
      workspace_id: "workspace-1",
      created_by: "user"
    });

    expect(order).toEqual(["event_log", "repo_create"]);
    expect(created.surface_id).toBe("surface://main");
    expect(events.map((event) => event.event_type)).toEqual([Phase2BEventType.SOUL_SURFACE_CREATED]);
    expect(events[0]?.revision).toBe(0);
    expect(notifySpy).toHaveBeenCalledTimes(1);
  });

  it("throws CONFLICT for duplicate surface_id in workspace", async () => {
    const { dependencies } = createDependencies({
      surfaces: [createSurface({ surface_id: "surface://main" })]
    });
    const service = new SurfaceService(dependencies);

    await expect(
      service.createSurface({
        surface_id: "surface://main",
        surface_kind: "conversation",
        workspace_id: "workspace-1",
        created_by: "user"
      })
    ).rejects.toMatchObject({
      code: "CONFLICT"
    });
  });

  it("transitions status with EventLog-first order", async () => {
    const { dependencies, order, events, notifySpy, cascaderSpy } = createDependencies({
      surfaces: [createSurface({ object_id: SURFACE_OBJECT_ID, surface_status: SurfaceStatus.ACTIVE })]
    });
    const service = new SurfaceService(dependencies);

    const updated = await service.transitionStatus(
      SURFACE_OBJECT_ID,
      SurfaceStatus.WEAKLY_BOUND,
      "anchor_degradation",
      TransitionCausedBy.SYSTEM
    );

    expect(order).toEqual(["event_log", "repo_update"]);
    expect(updated.surface_status).toBe(SurfaceStatus.WEAKLY_BOUND);
    expect(events[0]?.event_type).toBe(Phase2BEventType.SOUL_SURFACE_STATUS_CHANGED);
    expect(events[0]?.revision).toBe(0);
    expect(notifySpy).toHaveBeenCalledTimes(1);
    expect(cascaderSpy).not.toHaveBeenCalled();
  });

  it("cascades binding detach when status transitions to revoked", async () => {
    const { dependencies, cascaderSpy, notifySpy, driftService } = createDependencies({
      surfaces: [createSurface({ object_id: SURFACE_OBJECT_ID, surface_status: SurfaceStatus.ACTIVE })]
    });
    const service = new SurfaceService(dependencies);

    const updated = await service.transitionStatus(
      SURFACE_OBJECT_ID,
      SurfaceStatus.REVOKED,
      "policy_revoked",
      TransitionCausedBy.REVIEW
    );

    expect(updated.surface_status).toBe(SurfaceStatus.REVOKED);
    expect(notifySpy).toHaveBeenCalledTimes(1);
    expect(cascaderSpy).toHaveBeenCalledTimes(1);
    expect(cascaderSpy).toHaveBeenCalledWith("surface://main", "workspace-1");
    expect(driftService.acquireLease).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      operationType: "surface.transition_status",
      grantedTo: TransitionCausedBy.REVIEW,
      ttlMs: 300_000
    });
    expect(driftService.classifyDrift).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        driftType: "policy_override",
        affectedSubject: "surface_governance::entity=status"
      })
    );
    expect(driftService.alertOnCriticalDrift).toHaveBeenCalledTimes(1);
    expect(driftService.releaseLease).toHaveBeenCalledWith(
      "drift-lease-1",
      "workspace-1",
      TransitionCausedBy.REVIEW
    );
  });

  it("keeps status transition success when drift alerting throws after durable write", async () => {
    const { dependencies, driftService, warnSpy } = createDependencies({
      surfaces: [createSurface({ object_id: SURFACE_OBJECT_ID, surface_status: SurfaceStatus.ACTIVE })]
    });
    driftService.alertOnCriticalDrift.mockRejectedValueOnce(new Error("alert failed"));
    const service = new SurfaceService(dependencies);

    const updated = await service.transitionStatus(
      SURFACE_OBJECT_ID,
      SurfaceStatus.WEAKLY_BOUND,
      "anchor_degradation",
      TransitionCausedBy.SYSTEM
    );

    expect(updated.surface_status).toBe(SurfaceStatus.WEAKLY_BOUND);
    expect(warnSpy).toHaveBeenCalledWith(
      "Surface drift telemetry failed after durable mutation",
      expect.objectContaining({
        operationType: "surface.transition_status",
        workspaceId: "workspace-1",
        surfaceId: "surface://main",
        fromStatus: SurfaceStatus.ACTIVE,
        toStatus: SurfaceStatus.WEAKLY_BOUND
      })
    );
  });

  it("keeps status transition success when drift lease release throws after durable write", async () => {
    const { dependencies, driftService, warnSpy } = createDependencies({
      surfaces: [createSurface({ object_id: SURFACE_OBJECT_ID, surface_status: SurfaceStatus.ACTIVE })]
    });
    driftService.releaseLease.mockRejectedValueOnce(new Error("release failed"));
    const service = new SurfaceService(dependencies);

    const updatedDuringMutation = await service.transitionStatus(
      SURFACE_OBJECT_ID,
      SurfaceStatus.WEAKLY_BOUND,
      "anchor_degradation",
      TransitionCausedBy.SYSTEM
    );

    const updated = await service.findById(SURFACE_OBJECT_ID);

    expect(updatedDuringMutation.surface_status).toBe(SurfaceStatus.WEAKLY_BOUND);
    expect(updated.surface_status).toBe(SurfaceStatus.WEAKLY_BOUND);
    expect(warnSpy).toHaveBeenCalledWith(
      "Surface drift lease release failed after durable mutation",
      expect.objectContaining({
        operationType: "surface.transition_status",
        workspaceId: "workspace-1",
        leaseId: "drift-lease-1"
      })
    );
  });

  it("still fails closed on runtime notifier failure even when drift lease release also fails after the durable write", async () => {
    const { dependencies, driftService, warnSpy, notifySpy } = createDependencies({
      surfaces: [createSurface({ object_id: SURFACE_OBJECT_ID, surface_status: SurfaceStatus.ACTIVE })]
    });
    notifySpy.mockRejectedValueOnce(new Error("notify failed"));
    driftService.releaseLease.mockRejectedValueOnce(new Error("release failed"));
    const service = new SurfaceService(dependencies);

    await expect(
      service.transitionStatus(
        SURFACE_OBJECT_ID,
        SurfaceStatus.WEAKLY_BOUND,
        "anchor_degradation",
        TransitionCausedBy.SYSTEM
      )
    ).rejects.toThrow("notify failed");

    const updated = await service.findById(SURFACE_OBJECT_ID);
    expect(updated.surface_status).toBe(SurfaceStatus.WEAKLY_BOUND);
    expect(warnSpy).toHaveBeenCalledWith(
      "Surface drift lease release failed after durable mutation",
      expect.objectContaining({
        operationType: "surface.transition_status",
        workspaceId: "workspace-1",
        leaseId: "drift-lease-1"
      })
    );
  });

  it("rejects all transitions from revoked (terminal)", async () => {
    const { dependencies } = createDependencies({
      surfaces: [createSurface({ object_id: SURFACE_OBJECT_ID, surface_status: SurfaceStatus.REVOKED })]
    });
    const service = new SurfaceService(dependencies);

    const forbiddenTargets = [
      SurfaceStatus.ACTIVE,
      SurfaceStatus.WEAKLY_BOUND,
      SurfaceStatus.ORPHANED
    ] as const;

    for (const target of forbiddenTargets) {
      await expect(
        service.transitionStatus(
          SURFACE_OBJECT_ID,
          target,
          "re_anchor",
          TransitionCausedBy.SYSTEM
        )
      ).rejects.toMatchObject({
        code: "VALIDATION"
      });
    }
  });

  it("writes EventLog before adding anchor", async () => {
    const { dependencies, order, events } = createDependencies({
      surfaces: [createSurface({ object_id: SURFACE_OBJECT_ID })]
    });
    const service = new SurfaceService(dependencies);

    const anchor = await service.addAnchor({
      surface_id: "surface://main",
      anchor_kind: SurfaceAnchorKind.PATH_FRAGMENT,
      anchor_value: "apps/core-daemon/src",
      workspace_id: "workspace-1",
      created_by: "user"
    });

    expect(order).toEqual(["event_log", "anchor_create"]);
    expect(anchor.surface_id).toBe("surface://main");
    expect(events[0]?.event_type).toBe(Phase2BEventType.SOUL_SURFACE_ANCHOR_CREATED);
    expect(events[0]?.revision).toBe(0);
  });

  it("emits delete event and removes anchor with explicit actor", async () => {
    const { dependencies, order, events } = createDependencies({
      surfaces: [createSurface({ object_id: SURFACE_OBJECT_ID })],
      anchors: [createAnchor({ object_id: ANCHOR_OBJECT_ID })]
    });
    const service = new SurfaceService(dependencies);

    await service.removeAnchor(ANCHOR_OBJECT_ID, "reviewer-1");

    expect(order).toEqual(["event_log", "anchor_delete"]);
    expect(events[0]?.event_type).toBe(Phase2BEventType.SOUL_SURFACE_ANCHOR_DELETED);
    expect(events[0]?.caused_by).toBe("reviewer-1");
    await expect(dependencies.surfaceAnchorRepo.findById(ANCHOR_OBJECT_ID)).resolves.toBeNull();
  });

  it("returns null when findBySurfaceId does not exist", async () => {
    const { dependencies } = createDependencies();
    const service = new SurfaceService(dependencies);

    await expect(service.findBySurfaceId("surface://missing", "workspace-1")).resolves.toBeNull();
  });

  it("throws NOT_FOUND when findById misses", async () => {
    const { dependencies } = createDependencies();
    const service = new SurfaceService(dependencies);

    await expect(service.findById(SURFACE_OBJECT_ID)).rejects.toBeInstanceOf(CoreError);
    await expect(service.findById(SURFACE_OBJECT_ID)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
