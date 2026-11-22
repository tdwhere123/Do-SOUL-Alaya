import { expect, it, vi } from "vitest";
import { RuntimeGovernanceEventType } from "@do-soul/alaya-protocol";
import { SqliteDriftLeaseRepo } from "@do-soul/alaya-storage";
import { EventPublisher } from "../../runtime/event-publisher.js";
import { SurfaceDriftService } from "../../surfaces/surface-drift-service.js";
import { createResolutionServiceRealStorage } from "../shared/real-sqlite.test-support.js";

it("commits one release audit when both callers observe the same SQLite lease", async () => {
  const { database, eventLogRepo } = await createResolutionServiceRealStorage(() => undefined);
  try {
    const now = () => "2026-04-20T08:00:00.000Z";
    const leaseRepo = new SqliteDriftLeaseRepo(database, { now });
    const service = new SurfaceDriftService({
      leaseRepo,
      now,
      eventPublisher: new EventPublisher({
        eventLogRepo,
        runHotStateService: { apply: () => undefined },
        runtimeNotifier: { notify: () => undefined, notifyEntry: () => undefined }
      })
    });
    const lease = await service.acquireLease({
      workspaceId: "workspace-1",
      operationType: "surface.bind_object",
      grantedTo: "user",
      ttlMs: 60_000
    });
    const findActive = vi.spyOn(leaseRepo, "findActiveById");
    await Promise.all([
      service.releaseLease(lease.lease_id, lease.workspace_id, lease.granted_to),
      service.releaseLease(lease.lease_id, lease.workspace_id, lease.granted_to)
    ]);
    expect(findActive).toHaveBeenCalledTimes(2);
    for (const observation of findActive.mock.results) {
      await expect(observation.value).resolves.toEqual(lease);
    }
    await expect(leaseRepo.findActiveById(lease.workspace_id, lease.lease_id)).resolves.toBeNull();
    const events = await eventLogRepo.queryByEntityAll("surface_drift_lease", lease.lease_id);
    expect(events.map((event) => event.event_type)).toEqual([
      RuntimeGovernanceEventType.SURFACE_DRIFT_LEASE_ACQUIRED,
      RuntimeGovernanceEventType.SURFACE_DRIFT_LEASE_RELEASED
    ]);
  } finally {
    database.close();
  }
});
