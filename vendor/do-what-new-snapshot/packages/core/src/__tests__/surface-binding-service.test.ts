import { describe, expect, it, vi } from "vitest";
import {
  BindingState,
  CrossCuttingState,
  Phase2BEventType,
  type CrossCuttingPermission,
  type GovernanceDriftLease,
  type SurfaceBinding
} from "@do-what/protocol";
import { SurfaceBindingService, type SurfaceBindingServiceDependencies } from "../surface-binding-service.js";

const BINDING_ID_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BINDING_ID_2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

type BindingRecord = { readonly binding_id: string; readonly binding: SurfaceBinding };

function createBinding(overrides: Partial<SurfaceBinding> = {}): SurfaceBinding {
  return {
    object_id: "claim://object-1",
    object_kind: "surface_binding",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-22T00:00:00.000Z",
    updated_at: "2026-03-22T00:00:00.000Z",
    created_by: "user",
    surface_id: "surface://main",
    is_primary: true,
    binding_state: BindingState.ACTIVE,
    workspace_id: "workspace-1",
    ...overrides
  };
}

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

function createDriftLease(
  overrides: Partial<GovernanceDriftLease> = {}
): GovernanceDriftLease {
  return {
    lease_id: "drift-lease-1",
    workspace_id: "workspace-1",
    operation_type: "surface.bind_object",
    granted_to: "user",
    drift_id: null,
    expires_at: "2026-03-22T01:05:00.000Z",
    granted_at: "2026-03-22T01:00:00.000Z",
    ...overrides
  };
}

function createDependencies(seed?: {
  readonly bindings?: readonly BindingRecord[];
  readonly permissions?: readonly {
    readonly permission_id: string;
    readonly permission: CrossCuttingPermission;
  }[];
}): {
  readonly dependencies: SurfaceBindingServiceDependencies;
  readonly order: string[];
  readonly publishedEvents: {
    readonly single: unknown[];
    readonly many: unknown[][];
  };
  readonly eventPublisher: {
    readonly publishWithMutation: ReturnType<typeof vi.fn>;
    readonly publishManyWithMutation: ReturnType<typeof vi.fn>;
  };
  readonly broadcastSpy: ReturnType<typeof vi.fn>;
  readonly warnSpy: ReturnType<typeof vi.fn>;
  readonly driftService: {
    readonly acquireLease: ReturnType<typeof vi.fn>;
    readonly releaseLease: ReturnType<typeof vi.fn>;
    readonly classifyDrift: ReturnType<typeof vi.fn>;
    readonly alertOnCriticalDrift: ReturnType<typeof vi.fn>;
  };
} {
  const bindingStore = new Map(
    (seed?.bindings ?? []).map((record) => [record.binding_id, Object.freeze({ ...record })])
  );
  const permissionStore = new Map(
    (seed?.permissions ?? []).map((record) => [record.permission_id, Object.freeze({ ...record })])
  );

  const order: string[] = [];
  const publishedEvents = {
    single: [] as unknown[],
    many: [] as unknown[][]
  };
  const broadcastSpy = vi.fn(async () => {});
  const warnSpy = vi.fn();
  const driftService = {
    acquireLease: vi.fn(async () => createDriftLease()),
    releaseLease: vi.fn(async () => {}),
    classifyDrift: vi.fn(async () => ({
      drift_id: "drift-1",
      workspace_id: "workspace-1",
      drift_type: "scope_change" as const,
      severity: "governance_critical" as const,
      affected_subject: "surface_governance::entity=binding",
      description: "Surface binding changed",
      detected_at: "2026-03-22T01:00:00.000Z"
    })),
    alertOnCriticalDrift: vi.fn(async () => ({
      alert_id: "alert-1",
      workspace_id: "workspace-1",
      drift_id: "drift-1",
      severity: "governance_critical" as const,
      message: "governance drift",
      alerted_at: "2026-03-22T01:00:00.000Z"
    }))
  };
  const eventPublisher = {
    publishWithMutation: vi.fn(async (event, mutate) => {
      order.push("event_publish");
      publishedEvents.single.push(event);
      const result = await mutate();
      order.push("event_propagate");
      return result;
    }),
    publishManyWithMutation: vi.fn(async (events, mutate) => {
      order.push("event_publish_many");
      publishedEvents.many.push([...events]);
      const result = await mutate();
      order.push("event_propagate_many");
      return result;
    })
  };

  const dependencies: SurfaceBindingServiceDependencies = {
    generateObjectId: (() => {
      const ids = [BINDING_ID_1, BINDING_ID_2];
      let cursor = seed?.bindings?.length ?? 0;
      return () => {
        const value = ids[cursor] ?? `generated-${cursor}`;
        cursor += 1;
        return value;
      };
    })(),
    now: () => "2026-03-22T01:00:00.000Z",
    surfaceBindingRepo: {
      create: vi.fn(async (binding, bindingId) => {
        order.push("binding_create");
        const record = Object.freeze({ binding_id: bindingId, binding: Object.freeze({ ...binding }) });
        bindingStore.set(bindingId, record);
        return record;
      }),
      findByBindingId: vi.fn(async (bindingId) => bindingStore.get(bindingId) ?? null),
      findByObjectId: vi.fn(async (objectId, workspaceId) =>
        [...bindingStore.values()].filter(
          (record) =>
            record.binding.object_id === objectId && record.binding.workspace_id === workspaceId
        )
      ),
      findPrimaryBinding: vi.fn(async (objectId, workspaceId) =>
        [...bindingStore.values()].find(
          (record) =>
            record.binding.object_id === objectId &&
            record.binding.workspace_id === workspaceId &&
            record.binding.is_primary &&
            record.binding.binding_state !== BindingState.DETACHED
        ) ?? null
      ),
      findBySurfaceId: vi.fn(async (surfaceId, workspaceId) =>
        [...bindingStore.values()].filter(
          (record) =>
            record.binding.surface_id === surfaceId &&
            record.binding.workspace_id === workspaceId
        )
      ),
      findDetachableBySurfaceId: vi.fn(async (surfaceId, workspaceId) =>
        [...bindingStore.values()].filter(
          (record) =>
            record.binding.surface_id === surfaceId &&
            record.binding.workspace_id === workspaceId &&
            record.binding.binding_state !== BindingState.DETACHED
        )
      ),
      findByWorkspace: vi.fn(async (workspaceId) =>
        [...bindingStore.values()].filter((record) => record.binding.workspace_id === workspaceId)
      ),
      updateState: vi.fn(async (bindingId, bindingState, updatedAt) => {
        order.push("binding_update");
        const existing = bindingStore.get(bindingId);

        if (existing === undefined) {
          throw new Error(`missing binding ${bindingId}`);
        }

        const updated = Object.freeze({
          binding_id: bindingId,
          binding: Object.freeze({
            ...existing.binding,
            binding_state: bindingState,
            updated_at: updatedAt
          })
        });
        bindingStore.set(bindingId, updated);
        return updated;
      }),
      cascadeDetachBySurfaceId: vi.fn(async (surfaceId, workspaceId, updatedAt) => {
        order.push("binding_cascade_detach");

        const detached: BindingRecord[] = [];

        for (const [bindingId, existing] of bindingStore.entries()) {
          if (
            existing.binding.surface_id === surfaceId &&
            existing.binding.workspace_id === workspaceId &&
            existing.binding.binding_state !== BindingState.DETACHED
          ) {
            const updated = Object.freeze({
              binding_id: bindingId,
              binding: Object.freeze({
                ...existing.binding,
                binding_state: BindingState.DETACHED,
                updated_at: updatedAt
              })
            });
            bindingStore.set(bindingId, updated);
            detached.push(updated);
          }
        }

        return detached;
      })
    },
    crossCuttingPermissionLookup: {
      findByObjectId: vi.fn(async (objectId, workspaceId) =>
        [...permissionStore.values()].find(
          (record) =>
            record.permission.object_id === objectId &&
            record.permission.workspace_id === workspaceId
        ) ?? null
      )
    },
    sseBroadcaster: {
      broadcastEntry: broadcastSpy
    },
    eventPublisher,
    surfaceDriftService: driftService,
    warn: warnSpy
  };

  return { dependencies, order, publishedEvents, eventPublisher, broadcastSpy, warnSpy, driftService };
}

describe("SurfaceBindingService", () => {
  it("binds first surface with EventLog-first order", async () => {
    const { dependencies, order, publishedEvents, eventPublisher, broadcastSpy, driftService } =
      createDependencies();
    const service = new SurfaceBindingService(dependencies);

    const created = await service.bindObject({
      object_id: "claim://object-1",
      surface_id: "surface://main",
      is_primary: true,
      workspace_id: "workspace-1",
      created_by: "user"
    });

    expect(order).toEqual(["event_publish", "binding_create", "event_propagate"]);
    expect(created.binding_id).toBe(BINDING_ID_1);
    expect(created.binding.binding_state).toBe(BindingState.ACTIVE);
    expect(eventPublisher.publishWithMutation).toHaveBeenCalledTimes(1);
    expect(publishedEvents.single[0]).toMatchObject({
      event_type: Phase2BEventType.SOUL_SURFACE_BINDING_CREATED,
      entity_type: "surface_binding",
      entity_id: BINDING_ID_1,
      workspace_id: "workspace-1",
      caused_by: "user"
    });
    expect(broadcastSpy).not.toHaveBeenCalled();
    expect(driftService.acquireLease).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      operationType: "surface.bind_object",
      grantedTo: "user",
      ttlMs: 300_000
    });
    expect(driftService.classifyDrift).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        driftType: "scope_change",
        affectedSubject: "surface_governance::entity=binding"
      })
    );
    expect(driftService.alertOnCriticalDrift).toHaveBeenCalledTimes(1);
    expect(driftService.releaseLease).toHaveBeenCalledWith(
      "drift-lease-1",
      "workspace-1",
      "user"
    );
  });

  it("rejects invalid surface_id when service is called directly", async () => {
    const { dependencies } = createDependencies();
    const service = new SurfaceBindingService(dependencies);

    await expect(
      service.bindObject({
        object_id: "claim://object-1",
        surface_id: "not-a-surface-uri",
        is_primary: true,
        workspace_id: "workspace-1",
        created_by: "user"
      })
    ).rejects.toMatchObject({ code: "VALIDATION", message: "surface_id must be a surface:// URI" });
  });

  it("rejects second binding when cross_cutting is not active", async () => {
    const { dependencies } = createDependencies({
      bindings: [{ binding_id: BINDING_ID_1, binding: createBinding() }],
      permissions: [{ permission_id: "perm-1", permission: createPermission() }]
    });
    const service = new SurfaceBindingService(dependencies);

    await expect(
      service.bindObject({
        object_id: "claim://object-1",
        surface_id: "surface://secondary",
        is_primary: false,
        workspace_id: "workspace-1",
        created_by: "user"
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rejects second binding when surface is not in allowed_surfaces", async () => {
    const { dependencies } = createDependencies({
      bindings: [{ binding_id: BINDING_ID_1, binding: createBinding() }],
      permissions: [
        {
          permission_id: "perm-1",
          permission: createPermission({
            cross_cutting_state: CrossCuttingState.ACTIVE,
            allowed_surfaces: ["surface://main"]
          })
        }
      ]
    });
    const service = new SurfaceBindingService(dependencies);

    await expect(
      service.bindObject({
        object_id: "claim://object-1",
        surface_id: "surface://secondary",
        is_primary: false,
        workspace_id: "workspace-1",
        created_by: "user"
      })
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("allows second binding when cross_cutting is active and allowed", async () => {
    const { dependencies } = createDependencies({
      bindings: [{ binding_id: BINDING_ID_1, binding: createBinding() }],
      permissions: [
        {
          permission_id: "perm-1",
          permission: createPermission({
            cross_cutting_state: CrossCuttingState.ACTIVE,
            allowed_surfaces: ["surface://secondary"]
          })
        }
      ]
    });
    const service = new SurfaceBindingService(dependencies);

    const created = await service.bindObject({
      object_id: "claim://object-1",
      surface_id: "surface://secondary",
      is_primary: false,
      workspace_id: "workspace-1",
      created_by: "user"
    });

    expect(created.binding.surface_id).toBe("surface://secondary");
    expect(created.binding.is_primary).toBe(false);
  });

  it("allows first binding when is_primary is false", async () => {
    const { dependencies } = createDependencies();
    const service = new SurfaceBindingService(dependencies);

    const created = await service.bindObject({
      object_id: "claim://object-1",
      surface_id: "surface://main",
      is_primary: false,
      workspace_id: "workspace-1",
      created_by: "user"
    });

    expect(created.binding.is_primary).toBe(false);
    expect(created.binding.surface_id).toBe("surface://main");
  });

  it("allows rebinding when the only primary binding is detached", async () => {
    const { dependencies } = createDependencies({
      bindings: [
        {
          binding_id: BINDING_ID_1,
          binding: createBinding({
            surface_id: "surface://main",
            binding_state: BindingState.DETACHED
          })
        }
      ]
    });
    const service = new SurfaceBindingService(dependencies);

    const created = await service.bindObject({
      object_id: "claim://object-1",
      surface_id: "surface://secondary",
      is_primary: true,
      workspace_id: "workspace-1",
      created_by: "user"
    });

    expect(created.binding_id).toBe(BINDING_ID_2);
    expect(created.binding.surface_id).toBe("surface://secondary");
    expect(created.binding.is_primary).toBe(true);
  });

  it("maps unique constraint errors to CONFLICT when binding", async () => {
    const { dependencies } = createDependencies();
    const uniqueConstraintError = {
      cause: {
        message: "UNIQUE constraint failed: surface_bindings.object_id, surface_bindings.workspace_id"
      }
    };

    (dependencies.surfaceBindingRepo.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      uniqueConstraintError as unknown as Error
    );

    const service = new SurfaceBindingService(dependencies);

    await expect(
      service.bindObject({
        object_id: "claim://object-1",
        surface_id: "surface://main",
        is_primary: true,
        workspace_id: "workspace-1",
        created_by: "user"
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("transitions binding state with EventLog-first order", async () => {
    const { dependencies, order, publishedEvents, eventPublisher, broadcastSpy } = createDependencies({
      bindings: [{ binding_id: BINDING_ID_1, binding: createBinding({ binding_state: BindingState.ACTIVE }) }]
    });
    const service = new SurfaceBindingService(dependencies);

    const updated = await service.transitionBindingState(BINDING_ID_1, BindingState.STALE, "anchor_degradation", "reviewer-1");

    expect(order).toEqual(["event_publish", "binding_update", "event_propagate"]);
    expect(updated.binding.binding_state).toBe(BindingState.STALE);
    expect(eventPublisher.publishWithMutation).toHaveBeenCalledTimes(1);
    expect(publishedEvents.single[0]).toMatchObject({
      event_type: Phase2BEventType.SOUL_SURFACE_BINDING_STATE_CHANGED,
      entity_type: "surface_binding",
      entity_id: BINDING_ID_1,
      caused_by: "reviewer-1",
      payload_json: expect.objectContaining({
        from_state: BindingState.ACTIVE,
        to_state: BindingState.STALE,
        reason: "anchor_degradation"
      })
    });
    expect(broadcastSpy).not.toHaveBeenCalled();
  });

  it("keeps bind success when drift classification throws after durable write", async () => {
    const { dependencies, driftService, warnSpy } = createDependencies();
    driftService.classifyDrift.mockRejectedValueOnce(new Error("classification failed"));
    const service = new SurfaceBindingService(dependencies);

    const created = await service.bindObject({
      object_id: "claim://object-1",
      surface_id: "surface://main",
      is_primary: true,
      workspace_id: "workspace-1",
      created_by: "user"
    });

    expect(created.binding_id).toBe(BINDING_ID_1);
    await expect(service.findBindingsByObject("claim://object-1", "workspace-1")).resolves.toHaveLength(1);
    expect(driftService.releaseLease).toHaveBeenCalledWith(
      "drift-lease-1",
      "workspace-1",
      "user"
    );
    expect(warnSpy).toHaveBeenCalledWith(
      "Surface binding drift telemetry failed after durable mutation",
      expect.objectContaining({
        operationType: "surface.bind_object",
        workspaceId: "workspace-1",
        driftType: "scope_change"
      })
    );
  });

  it("keeps transition success when drift lease release throws after durable write", async () => {
    const { dependencies, driftService, warnSpy } = createDependencies({
      bindings: [{ binding_id: BINDING_ID_1, binding: createBinding({ binding_state: BindingState.ACTIVE }) }]
    });
    driftService.releaseLease.mockRejectedValueOnce(new Error("release failed"));
    const service = new SurfaceBindingService(dependencies);

    const updatedDuringMutation = await service.transitionBindingState(
      BINDING_ID_1,
      BindingState.STALE,
      "anchor_degradation",
      "user"
    );

    const [updated] = await service.findBindingsByObject("claim://object-1", "workspace-1");

    expect(updatedDuringMutation.binding.binding_state).toBe(BindingState.STALE);
    expect(updated?.binding.binding_state).toBe(BindingState.STALE);
    expect(warnSpy).toHaveBeenCalledWith(
      "Surface binding drift lease release failed after durable mutation",
      expect.objectContaining({
        operationType: "surface.transition_binding_state",
        workspaceId: "workspace-1",
        leaseId: "drift-lease-1"
      })
    );
  });

  it("keeps bind success when drift lease release throws after durable write", async () => {
    const { dependencies, driftService, warnSpy } = createDependencies();
    driftService.releaseLease.mockRejectedValueOnce(new Error("release failed"));
    const service = new SurfaceBindingService(dependencies);

    const created = await service.bindObject({
      object_id: "claim://object-1",
      surface_id: "surface://main",
      is_primary: true,
      workspace_id: "workspace-1",
      created_by: "user"
    });

    const [stored] = await service.findBindingsByObject("claim://object-1", "workspace-1");
    expect(created.binding_id).toBe(BINDING_ID_1);
    expect(stored?.binding.surface_id).toBe("surface://main");
    expect(warnSpy).toHaveBeenCalledWith(
      "Surface binding drift lease release failed after durable mutation",
      expect.objectContaining({
        operationType: "surface.bind_object",
        workspaceId: "workspace-1",
        leaseId: "drift-lease-1"
      })
    );
  });

  it("rejects detached -> active binding transition", async () => {
    const { dependencies } = createDependencies({
      bindings: [{ binding_id: BINDING_ID_1, binding: createBinding({ binding_state: BindingState.DETACHED }) }]
    });
    const service = new SurfaceBindingService(dependencies);

    await expect(
      service.transitionBindingState(BINDING_ID_1, BindingState.ACTIVE, "re_attach", "user")
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("returns binding by id", async () => {
    const { dependencies } = createDependencies({
      bindings: [{ binding_id: BINDING_ID_1, binding: createBinding({ binding_state: BindingState.ACTIVE }) }]
    });
    const service = new SurfaceBindingService(dependencies);

    await expect(service.findBindingById(BINDING_ID_1)).resolves.toMatchObject({
      binding_id: BINDING_ID_1,
      binding: { object_id: "claim://object-1" }
    });
  });

  it("cascades detach for all non-detached bindings on a revoked surface", async () => {
    const { dependencies, order, publishedEvents, eventPublisher, broadcastSpy } = createDependencies({
      bindings: [
        { binding_id: BINDING_ID_1, binding: createBinding({ binding_state: BindingState.ACTIVE }) },
        {
          binding_id: BINDING_ID_2,
          binding: createBinding({
            object_id: "claim://object-2",
            is_primary: false,
            binding_state: BindingState.STALE
          })
        }
      ]
    });
    const service = new SurfaceBindingService(dependencies);

    await service.cascadeDetachBySurfaceId("surface://main", "workspace-1");

    expect(dependencies.surfaceBindingRepo.findDetachableBySurfaceId).toHaveBeenCalledWith(
      "surface://main",
      "workspace-1"
    );
    expect(dependencies.surfaceBindingRepo.findBySurfaceId).not.toHaveBeenCalled();
    expect(order).toEqual(["event_publish_many", "binding_cascade_detach", "event_propagate_many"]);
    expect(eventPublisher.publishManyWithMutation).toHaveBeenCalledTimes(1);
    expect(publishedEvents.many).toHaveLength(1);
    expect(publishedEvents.many[0]).toHaveLength(2);
    expect(
      publishedEvents.many[0].every(
        (event) =>
          (event as { readonly event_type?: string }).event_type ===
          Phase2BEventType.SOUL_SURFACE_BINDING_STATE_CHANGED
      )
    ).toBe(true);
    expect(broadcastSpy).not.toHaveBeenCalled();

    const listed = await service.findBindingsBySurface("surface://main", "workspace-1");
    for (const record of listed) {
      expect(record.binding.binding_state).toBe(BindingState.DETACHED);
    }
  });
});
