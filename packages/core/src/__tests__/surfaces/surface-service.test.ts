import { describe, expect, it } from "vitest";
import { SurfaceEventType, SurfaceAnchorKind, SurfaceStatus, TransitionCausedBy } from "@do-soul/alaya-protocol";
import { CoreError } from "../../shared/errors.js";
import { SurfaceService } from "../../surfaces/surface-service.js";

import { ANCHOR_OBJECT_ID, SURFACE_OBJECT_ID, createAnchor, createDependencies, createSurface } from "./surface-service.test-support.js";

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
    expect(events.map((event) => event.event_type)).toEqual([SurfaceEventType.SOUL_SURFACE_CREATED]);
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
    expect(events[0]?.event_type).toBe(SurfaceEventType.SOUL_SURFACE_STATUS_CHANGED);
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
    expect(events[0]?.event_type).toBe(SurfaceEventType.SOUL_SURFACE_ANCHOR_CREATED);
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
    expect(events[0]?.event_type).toBe(SurfaceEventType.SOUL_SURFACE_ANCHOR_DELETED);
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
