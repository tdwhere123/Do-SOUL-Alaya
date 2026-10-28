import { expect, it, vi } from "vitest";
import { SqliteEventLogRepo } from "@do-soul/alaya-storage";
import { MemoryService } from "../../memory/memory-service.js";
import { ResolutionService, type ResolutionServiceDependencies } from "../../governance/proposals/resolution-service.js";
import { EventPublisher } from "../../runtime/event-publisher.js";
import { createRecallRealStorage } from "../shared/real-sqlite.test-support.js";
import { createMemoryEntry } from "../health/green-service.test-support.js";

it("commits the stale transition with its typed resolution audit or rolls both back", async () => {
  const { database, memoryEntryRepo } = await createRecallRealStorage(() => undefined);
  try {
    const memory = await memoryEntryRepo.create(createMemoryEntry({ evidence_refs: [] }));
    const eventLogRepo = new SqliteEventLogRepo(database);
    const notifier = { notify: () => undefined, notifyEntry: () => undefined };
    const publisher = new EventPublisher({ eventLogRepo, runtimeNotifier: notifier, runHotStateService: { apply: () => undefined } });
    const memoryService = new MemoryService({ memoryEntryRepo, eventLogRepo, runtimeNotifier: notifier,
      evidenceService: { findById: async () => null }, now: () => "2026-05-17T00:00:00.000Z" });
    const service = new ResolutionService({ eventPublisher: publisher, resolutionAuditRepo: eventLogRepo, memoryRepo: memoryEntryRepo, memoryService,
      claimRepo: { findById: async () => null }, claimService: {} as ResolutionServiceDependencies["claimService"],
      deferredObligationService: {} as ResolutionServiceDependencies["deferredObligationService"],
      deliveryAuthority: { authorize: vi.fn(async () => ({ deliveredAt: "2026-05-16T00:00:00.000Z" })) },
      effectAuthority: {} as ResolutionServiceDependencies["effectAuthority"], now: () => "2026-05-17T00:00:00.000Z" });
    const request = { targetObjectId: memory.object_id, resolution: "stale" as const,
      workspaceId: "workspace-1", runId: "run-1", agentTarget: "codex", deliveryId: "delivery-1" };
    database.connection.exec(`CREATE TRIGGER reject_resolution_audit BEFORE INSERT ON event_log
      WHEN NEW.entity_type = 'soul_resolution' BEGIN SELECT RAISE(ABORT, 'audit refused'); END;`);
    await expect(service.resolve(request)).rejects.toThrow();
    expect((await memoryEntryRepo.findById(memory.object_id))?.lifecycle_state).toBe("active");
    expect(await eventLogRepo.queryByEntity("memory_entry", memory.object_id)).toEqual([]);
    expect(await eventLogRepo.queryByEntity("soul_resolution", memory.object_id)).toEqual([]);
    database.connection.exec("DROP TRIGGER reject_resolution_audit");
    await expect(service.resolve(request)).resolves.toMatchObject({ status: "applied" });
    expect((await memoryEntryRepo.findById(memory.object_id))?.lifecycle_state).toBe("dormant");
    expect(await eventLogRepo.queryByEntity("memory_entry", memory.object_id)).toHaveLength(1);
    expect(await eventLogRepo.queryByEntity("soul_resolution", memory.object_id)).toHaveLength(1);
  } finally { database.close(); }
});
