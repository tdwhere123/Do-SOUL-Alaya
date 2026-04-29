import { describe, expect, it, vi } from "vitest";
import {
  PhaseCEventType,
  type EventLogEntry,
  type DriftClassification,
  type GovernanceDriftLease
} from "@do-soul/alaya-protocol";
import { EventPublisherPropagationError } from "../event-publisher.js";
import { SurfaceDriftService } from "../surface-drift-service.js";

function createEventLogEntry(event: Omit<EventLogEntry, "event_id" | "created_at">): EventLogEntry {
  return {
    event_id: `event-${event.event_type}-${event.entity_id}`,
    created_at: "2026-04-20T08:00:00.000Z",
    ...event
  };
}

function createLease(overrides: Partial<GovernanceDriftLease> = {}): GovernanceDriftLease {
  return {
    lease_id: "lease-1",
    workspace_id: "workspace-1",
    operation_type: "surface.bind_object",
    granted_to: "user",
    drift_id: null,
    expires_at: "2026-04-20T08:05:00.000Z",
    granted_at: "2026-04-20T08:00:00.000Z",
    ...overrides
  };
}

describe("SurfaceDriftService", () => {
  it("classifies governance-critical drift and appends drift_detected event", async () => {
    const publishSpy = vi.fn(async (event: Omit<EventLogEntry, "event_id" | "created_at">) =>
      createEventLogEntry(event)
    );
    const service = new SurfaceDriftService({
      now: () => "2026-04-20T08:00:00.000Z",
      generateId: () => "drift-1",
      leaseRepo: createLeaseRepo(),
      eventPublisher: createEventPublisher({ publish: publishSpy })
    });

    const classification = await service.classifyDrift({
      workspaceId: "workspace-1",
      driftType: "scope_change",
      affectedSubject: "surface_binding",
      description: "Surface binding moved to detached"
    });

    expect(classification).toMatchObject({
      drift_id: "drift-1",
      workspace_id: "workspace-1",
      drift_type: "scope_change",
      severity: "governance_critical",
      affected_subject: "surface_binding"
    });
    expect(publishSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: PhaseCEventType.SURFACE_DRIFT_DETECTED,
        entity_type: "surface_drift",
        entity_id: "drift-1",
        workspace_id: "workspace-1",
        revision: 0
      })
    );
  });

  it("acquires lease with EventLog-first mutation ordering", async () => {
    const order: string[] = [];
    const repo = createLeaseRepo({
      deleteExpired: vi.fn(async () => {
        order.push("repo_delete_expired");
        return 0;
      }),
      create: vi.fn(async (lease) => {
        order.push("repo_create");
        return lease;
      })
    });

    const service = new SurfaceDriftService({
      now: () => "2026-04-20T08:00:00.000Z",
      generateId: () => "lease-1",
      leaseRepo: repo,
      eventPublisher: createEventPublisher({
        publishWithMutation: vi.fn(async (event, mutate) => {
          order.push("event_log");
          createEventLogEntry(event);
          return await mutate();
        })
      })
    });

    const lease = await service.acquireLease({
      workspaceId: "workspace-1",
      operationType: "surface.bind_object",
      grantedTo: "user",
      ttlMs: 60_000
    });

    expect(order).toEqual(["event_log", "repo_delete_expired", "repo_create"]);
    expect(lease).toMatchObject({
      lease_id: "lease-1",
      workspace_id: "workspace-1",
      operation_type: "surface.bind_object",
      granted_to: "user",
      granted_at: "2026-04-20T08:00:00.000Z",
      expires_at: "2026-04-20T08:01:00.000Z"
    });
  });

  it("releases lease via durable repo", async () => {
    const deleteSpy = vi.fn(async () => {});
    const service = new SurfaceDriftService({
      leaseRepo: createLeaseRepo({
        findActiveById: vi.fn(async () => createLease()),
        delete: deleteSpy
      }),
      eventPublisher: createEventPublisher()
    });

    await service.releaseLease("lease-1", "workspace-1", "user");

    expect(deleteSpy).toHaveBeenCalledWith("lease-1");
  });

  it("releases an existing lease with EventLog-first mutation ordering", async () => {
    const order: string[] = [];
    const repo = createLeaseRepo({
      findActiveById: vi.fn(async () => createLease()),
      delete: vi.fn(async () => {
        order.push("repo_delete");
      })
    });
    const publishWithMutationSpy = vi.fn(async (event, mutate) => {
      order.push("event_log");
      createEventLogEntry(event);
      return await mutate();
    });
    const service = new SurfaceDriftService({
      now: () => "2026-04-20T08:01:00.000Z",
      leaseRepo: repo,
      eventPublisher: createEventPublisher({ publishWithMutation: publishWithMutationSpy })
    });

    await service.releaseLease("lease-1", "workspace-1", "user");

    expect(order).toEqual(["event_log", "repo_delete"]);
    expect(repo.findActiveById).toHaveBeenCalledWith("workspace-1", "lease-1");
    expect(repo.delete).toHaveBeenCalledWith("lease-1");
    expect(publishWithMutationSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: PhaseCEventType.SURFACE_DRIFT_LEASE_RELEASED,
        entity_type: "surface_drift_lease",
        entity_id: "lease-1",
        workspace_id: "workspace-1",
        caused_by: "user",
        revision: 0,
        payload_json: {
          lease_id: "lease-1",
          workspace_id: "workspace-1",
          operation_type: "surface.bind_object",
          granted_to: "user",
          released_by: "user",
          released_at: "2026-04-20T08:01:00.000Z"
        }
      }),
      expect.any(Function)
    );
  });

  it("returns without event when the lease is already missing", async () => {
    const repo = createLeaseRepo({
      findActiveById: vi.fn(async () => null),
      delete: vi.fn(async () => {})
    });
    const publishWithMutationSpy = vi.fn(async (_event, mutate) => await mutate());
    const service = new SurfaceDriftService({
      leaseRepo: repo,
      eventPublisher: createEventPublisher({ publishWithMutation: publishWithMutationSpy })
    });

    await service.releaseLease("lease-1", "workspace-1", "user");

    expect(repo.findActiveById).toHaveBeenCalledTimes(1);
    expect(repo.delete).not.toHaveBeenCalled();
    expect(publishWithMutationSpy).not.toHaveBeenCalled();
  });

  it("records a lease release failure witness instead of throwing when durable cleanup fails", async () => {
    const publishSpy = vi.fn(async (event: Omit<EventLogEntry, "event_id" | "created_at">) =>
      createEventLogEntry(event)
    );
    const repo = createLeaseRepo({
      findActiveById: vi.fn(async () => createLease()),
      delete: vi.fn(async () => {
        throw new Error("delete failed");
      })
    });
    const service = new SurfaceDriftService({
      now: () => "2026-04-20T08:01:00.000Z",
      leaseRepo: repo,
      eventPublisher: createEventPublisher({
        publish: publishSpy,
        publishWithMutation: vi.fn(async (_event, mutate) => await mutate())
      })
    });

    await expect(service.releaseLease("lease-1", "workspace-1", "user")).resolves.toBeUndefined();
    expect(publishSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: PhaseCEventType.SURFACE_DRIFT_LEASE_RELEASE_FAILED,
        entity_type: "surface_drift_lease",
        entity_id: "lease-1",
        workspace_id: "workspace-1",
        caused_by: "user",
        payload_json: {
          lease_id: "lease-1",
          workspace_id: "workspace-1",
          operation_type: "surface.bind_object",
          granted_to: "user",
          released_by: "user",
          failed_at: "2026-04-20T08:01:00.000Z"
        }
      })
    );
  });

  it("preserves propagation failures without emitting a false lease release failure witness", async () => {
    const publishSpy = vi.fn(async (event: Omit<EventLogEntry, "event_id" | "created_at">) =>
      createEventLogEntry(event)
    );
    const propagatedReleaseEntry = createEventLogEntry({
      event_type: PhaseCEventType.SURFACE_DRIFT_LEASE_RELEASED,
      entity_type: "surface_drift_lease",
      entity_id: "lease-1",
      workspace_id: "workspace-1",
      run_id: null,
      caused_by: "user",
      revision: 0,
      payload_json: {
        lease_id: "lease-1",
        workspace_id: "workspace-1",
        operation_type: "surface.bind_object",
        granted_to: "user",
        released_by: "user",
        released_at: "2026-04-20T08:01:00.000Z"
      }
    });
    const repo = createLeaseRepo({
      findActiveById: vi.fn(async () => createLease()),
      delete: vi.fn(async () => undefined)
    });
    const service = new SurfaceDriftService({
      now: () => "2026-04-20T08:01:00.000Z",
      leaseRepo: repo,
      eventPublisher: createEventPublisher({
        publish: publishSpy,
        publishWithMutation: vi.fn(async (_event, mutate) => {
          await mutate();
          throw new EventPublisherPropagationError(
            propagatedReleaseEntry,
            new Error("notify failed")
          );
        })
      })
    });

    await expect(service.releaseLease("lease-1", "workspace-1", "user")).rejects.toThrow(
      "appended but propagation failed"
    );
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it("rejects release attempts from actors other than the lease grantee", async () => {
    const repo = createLeaseRepo({
      findActiveById: vi.fn(async () => createLease())
    });
    const publishWithMutationSpy = vi.fn(async (_event, mutate) => await mutate());
    const service = new SurfaceDriftService({
      leaseRepo: repo,
      eventPublisher: createEventPublisher({ publishWithMutation: publishWithMutationSpy })
    });

    await expect(service.releaseLease("lease-1", "workspace-1", "other-user")).rejects.toMatchObject({
      code: "OBLIGATION_VIOLATION",
      message: "Only user may release drift lease lease-1."
    });
    expect(repo.delete).not.toHaveBeenCalled();
    expect(publishWithMutationSpy).not.toHaveBeenCalled();
  });

  it("uses direct lease lookup during release instead of scanning the workspace lease list", async () => {
    const repo = createLeaseRepo({
      findActive: vi.fn(async () => {
        throw new Error("workspace-wide scan should not run");
      }),
      findActiveById: vi.fn(async () => createLease())
    });
    const service = new SurfaceDriftService({
      leaseRepo: repo,
      eventPublisher: createEventPublisher()
    });

    await expect(service.releaseLease("lease-1", "workspace-1", "user")).resolves.toBeUndefined();

    expect(repo.findActive).not.toHaveBeenCalled();
    expect(repo.findActiveById).toHaveBeenCalledWith("workspace-1", "lease-1");
  });

  it("alerts only on governance-critical drift", async () => {
    const publishSpy = vi.fn(async (event: Omit<EventLogEntry, "event_id" | "created_at">) =>
      createEventLogEntry(event)
    );
    const service = new SurfaceDriftService({
      now: () => "2026-04-20T08:00:00.000Z",
      generateId: () => "alert-1",
      leaseRepo: createLeaseRepo(),
      eventPublisher: createEventPublisher({ publish: publishSpy })
    });

    const ordinary: DriftClassification = {
      drift_id: "drift-ordinary",
      workspace_id: "workspace-1",
      drift_type: "theme_change",
      severity: "ordinary",
      affected_subject: "surface_theme",
      description: "Theme changed to solarized",
      detected_at: "2026-04-20T08:00:00.000Z"
    };

    const ordinaryAlert = await service.alertOnCriticalDrift(ordinary);
    expect(ordinaryAlert).toBeNull();
    expect(publishSpy).not.toHaveBeenCalled();

    const critical: DriftClassification = {
      drift_id: "drift-1",
      workspace_id: "workspace-1",
      drift_type: "policy_override",
      severity: "governance_critical",
      affected_subject: "surface_policy",
      description: "Surface policy changed",
      detected_at: "2026-04-20T08:00:00.000Z"
    };

    const alert = await service.alertOnCriticalDrift(critical);
    expect(alert).toMatchObject({
      alert_id: "alert-1",
      workspace_id: "workspace-1",
      drift_id: "drift-1",
      severity: "governance_critical"
    });
    expect(publishSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: PhaseCEventType.SURFACE_DRIFT_ALERT,
        entity_type: "surface_drift_alert",
        entity_id: "alert-1",
        workspace_id: "workspace-1"
      })
    );
  });

  it("surfaces lease acquisition contention as a conflict", async () => {
    const repoConflict = Object.assign(new Error("duplicate active lease"), { code: "CONFLICT" as const });
    const service = new SurfaceDriftService({
      now: () => "2026-04-20T08:00:00.000Z",
      generateId: () => "lease-1",
      leaseRepo: createLeaseRepo({
        create: vi.fn(async () => {
          throw repoConflict;
        })
      }),
      eventPublisher: createEventPublisher({
        publishWithMutation: vi.fn(async (_event, mutate) => await mutate())
      })
    });

    await expect(
      service.acquireLease({
        workspaceId: "workspace-1",
        operationType: "surface.bind_object",
        grantedTo: "user",
        ttlMs: 60_000
      })
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Active drift lease already exists for workspace workspace-1 and operation surface.bind_object."
    });
  });
});

function createLeaseRepo(overrides: Partial<{
  create: (lease: Readonly<GovernanceDriftLease>) => Promise<Readonly<GovernanceDriftLease>>;
  findActive: (workspaceId: string) => Promise<readonly Readonly<GovernanceDriftLease>[]>;
  findActiveById: (
    workspaceId: string,
    leaseId: string
  ) => Promise<Readonly<GovernanceDriftLease> | null>;
  delete: (leaseId: string) => Promise<void>;
  deleteExpired: (beforeDate: string) => Promise<number>;
}> = {}) {
  return {
    create: overrides.create ?? vi.fn(async (lease) => lease),
    findActive: overrides.findActive ?? vi.fn(async () => []),
    findActiveById: overrides.findActiveById ?? vi.fn(async () => null),
    delete: overrides.delete ?? vi.fn(async () => {}),
    deleteExpired: overrides.deleteExpired ?? vi.fn(async () => 0)
  };
}

function createEventPublisher(overrides: Partial<{
  publish: (event: Omit<EventLogEntry, "event_id" | "created_at">) => Promise<EventLogEntry>;
  publishWithMutation: <T>(
    event: Omit<EventLogEntry, "event_id" | "created_at">,
    mutate: () => Promise<T>
  ) => Promise<T>;
}> = {}) {
  return {
    publish:
      overrides.publish ??
      (vi.fn(async (event: Omit<EventLogEntry, "event_id" | "created_at">) => createEventLogEntry(event)) as (
        event: Omit<EventLogEntry, "event_id" | "created_at">
      ) => Promise<EventLogEntry>),
    publishWithMutation:
      overrides.publishWithMutation ??
      (vi.fn(async <T>(
        event: Omit<EventLogEntry, "event_id" | "created_at">,
        mutate: () => Promise<T>
      ) => {
        createEventLogEntry(event);
        return await mutate();
      }) as <T>(
        event: Omit<EventLogEntry, "event_id" | "created_at">,
        mutate: () => Promise<T>
      ) => Promise<T>)
  };
}
