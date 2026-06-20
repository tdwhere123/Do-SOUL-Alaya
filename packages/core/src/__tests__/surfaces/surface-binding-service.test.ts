import { describe, expect, it, vi } from "vitest";
import { BindingState, CrossCuttingState, SurfaceEventType } from "@do-soul/alaya-protocol";
import { SurfaceBindingService } from "../../surfaces/surface-binding-service.js";

import { BINDING_ID_1, BINDING_ID_2, createBinding, createDependencies, createPermission } from "./surface-binding-service.test-support.js";

describe("SurfaceBindingService", () => {
  it("binds first surface with EventLog-first order", async () => {
    const { dependencies, order, publishedEvents, eventPublisher, driftService } =
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
    expect(eventPublisher.appendManyWithMutation).toHaveBeenCalledTimes(1);
    expect(publishedEvents.single[0]).toMatchObject({
      event_type: SurfaceEventType.SOUL_SURFACE_BINDING_CREATED,
      entity_type: "surface_binding",
      entity_id: BINDING_ID_1,
      workspace_id: "workspace-1",
      caused_by: "user"
    });
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

    (dependencies.surfaceBindingRepo.create as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw uniqueConstraintError as unknown as Error;
    });

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
    const { dependencies, order, publishedEvents, eventPublisher } = createDependencies({
      bindings: [{ binding_id: BINDING_ID_1, binding: createBinding({ binding_state: BindingState.ACTIVE }) }]
    });
    const service = new SurfaceBindingService(dependencies);

    const updated = await service.transitionBindingState(BINDING_ID_1, BindingState.STALE, "anchor_degradation", "reviewer-1");

    expect(order).toEqual(["event_publish", "binding_update", "event_propagate"]);
    expect(updated.binding.binding_state).toBe(BindingState.STALE);
    expect(eventPublisher.appendManyWithMutation).toHaveBeenCalledTimes(1);
    expect(publishedEvents.single[0]).toMatchObject({
      event_type: SurfaceEventType.SOUL_SURFACE_BINDING_STATE_CHANGED,
      entity_type: "surface_binding",
      entity_id: BINDING_ID_1,
      caused_by: "reviewer-1",
      payload_json: expect.objectContaining({
        from_state: BindingState.ACTIVE,
        to_state: BindingState.STALE,
        reason: "anchor_degradation"
      })
    });
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
    const { dependencies, order, publishedEvents, eventPublisher } = createDependencies({
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
    expect(eventPublisher.appendManyWithMutation).toHaveBeenCalledTimes(1);
    expect(publishedEvents.many).toHaveLength(1);
    expect(publishedEvents.many[0]).toHaveLength(2);
    expect(
      publishedEvents.many[0].every(
        (event) =>
          (event as { readonly event_type?: string }).event_type ===
          SurfaceEventType.SOUL_SURFACE_BINDING_STATE_CHANGED
      )
    ).toBe(true);

    const listed = await service.findBindingsBySurface("surface://main", "workspace-1");
    for (const record of listed) {
      expect(record.binding.binding_state).toBe(BindingState.DETACHED);
    }
  });
});
