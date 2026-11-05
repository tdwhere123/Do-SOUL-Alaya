import { describe, expect, it, vi } from "vitest";
import { EventPublisher } from "@do-soul/alaya-core";
import { GardenEventType, GardenRole, GardenTaskKind, GardenTier,
  type GardenTaskDescriptor, type GardenTaskKindValue } from "@do-soul/alaya-protocol";
import { GardenScheduler } from "@do-soul/alaya-soul";
import { initDatabase, SqliteEventLogRepo, SqliteGardenTaskRepo } from "@do-soul/alaya-storage";
import { createConsolidationCycleRunner } from "../../garden/scheduler/scheduler-runtime-consolidation.js";
import type { CreateGardenSchedulerRuntimeSupportInput } from "../../garden/scheduler/scheduler-runtime-types.js";
import { createBulkEnrichReporter, runBulkEnrichTask } from "../../garden/bulk-enrich/bulk-enrich-runtime-runner.js";

const now = () => "2026-07-17T00:00:00.000Z";

function task(id: string, kind: GardenTaskKindValue): GardenTaskDescriptor {
  return { task_id: id, task_kind: kind, required_tier: GardenTier.TIER_2,
    workspace_id: "workspace-1", run_id: null, target_object_refs: ["workspace-1"],
    priority: 10, created_at: now() };
}

describe("Garden completion outcomes through scheduler and EventLog", () => {
  it("exposes a skipped outcome through the in-process scheduler", async () => {
    const events: Record<string, unknown>[] = [];
    const scheduler = new GardenScheduler({ append: async entry => { events.push(entry.payload); } }, { now });
    const disabled = task("in-process-skip", GardenTaskKind.CONSOLIDATION_CYCLE);
    scheduler.enqueue(disabled);
    await scheduler.dispatchNext(GardenRole.LIBRARIAN);
    const runner = createConsolidationCycleRunner({ now, gardenScheduler: scheduler,
      consolidationExecutor: null, warn: vi.fn() } as unknown as CreateGardenSchedulerRuntimeSupportInput);
    await runner.runConsolidationCycleTask(disabled);
    expect(events.at(-1)).toMatchObject({ task_id: disabled.task_id, success: true, outcome: "skipped" });
  });

  it("rejects a legacy success value that contradicts a measured outcome", async () => {
    const events: Record<string, unknown>[] = [];
    const scheduler = new GardenScheduler({ append: async entry => { events.push(entry.payload); } }, { now });
    const disabled = task("contradictory-result", GardenTaskKind.CONSOLIDATION_CYCLE);
    scheduler.enqueue(disabled);
    await scheduler.dispatchNext(GardenRole.LIBRARIAN);
    const before = events.length;
    await expect(scheduler.reportCompletion({ task_id: disabled.task_id, task_kind: disabled.task_kind,
      role: GardenRole.LIBRARIAN, tier: GardenTier.TIER_2, workspace_id: disabled.workspace_id,
      success: false, outcome: "skipped", objects_affected: [], audit_entries: [],
      error_message: null, completed_at: now() })).rejects.toThrow(/conflicts/);
    expect(events).toHaveLength(before);
  });

  it("separates disabled maintenance, missing configuration, completed work and unknown history", async () => {
    const db = initDatabase({ filename: ":memory:" });
    try {
      const eventLogRepo = new SqliteEventLogRepo(db);
      const publisher = new EventPublisher({ eventLogRepo, runHotStateService: { apply: () => undefined },
        runtimeNotifier: { notify: () => undefined, notifyEntry: () => undefined } });
      const repo = new SqliteGardenTaskRepo(db.connection, publisher);
      const scheduler = new GardenScheduler({ append: async () => undefined }, { now }, null, repo);
      const dispatch = async (descriptor: GardenTaskDescriptor) => {
        scheduler.enqueue(descriptor);
        expect((await scheduler.dispatchNext(GardenRole.LIBRARIAN))?.task_id).toBe(descriptor.task_id);
      };
      const consolidation = (overrides: Record<string, unknown>) => createConsolidationCycleRunner({
        now, gardenScheduler: scheduler, consolidationExecutor: null, warn: vi.fn(), ...overrides
      } as unknown as CreateGardenSchedulerRuntimeSupportInput);

      const disabled = task("consolidation-disabled", GardenTaskKind.CONSOLIDATION_CYCLE);
      await dispatch(disabled);
      await consolidation({ legacyTopologyMutationsEnabled: true,
        configService: { getSoulConfig: async () => ({ memory_consolidation_enabled: false }) } })
        .runConsolidationCycleTask(disabled);
      const deferred = task("consolidation-deferred", GardenTaskKind.CONSOLIDATION_CYCLE);
      await dispatch(deferred);
      await consolidation({}).runConsolidationCycleTask(deferred);
      const missing = task("consolidation-missing", GardenTaskKind.CONSOLIDATION_CYCLE);
      await dispatch(missing);
      await consolidation({ legacyTopologyMutationsEnabled: true }).runConsolidationCycleTask(missing);

      const reporter = createBulkEnrichReporter({ eventPublisher: publisher, gardenScheduler: scheduler, warn: vi.fn() });
      const bulkDisabled = task("bulk-disabled", GardenTaskKind.BULK_ENRICH);
      await dispatch(bulkDisabled);
      await runBulkEnrichTask({ now, task: bulkDisabled, availability: { kind: "disabled" }, reporter });
      const bulkMissing = task("bulk-missing", GardenTaskKind.BULK_ENRICH);
      await dispatch(bulkMissing);
      await runBulkEnrichTask({ now, task: bulkMissing, availability: { kind: "missing_repo" }, reporter });

      const completed = task("performed", GardenTaskKind.BULK_ENRICH);
      await dispatch(completed);
      await scheduler.reportCompletion({ task_id: completed.task_id, task_kind: completed.task_kind,
        role: GardenRole.LIBRARIAN, tier: GardenTier.TIER_2, workspace_id: completed.workspace_id,
        success: true, outcome: "completed", objects_affected: [], audit_entries: [],
        error_message: null, completed_at: now() });
      const historical = task("historical", GardenTaskKind.BULK_ENRICH);
      await dispatch(historical);
      await scheduler.reportCompletion({ task_id: historical.task_id, task_kind: historical.task_kind,
        role: GardenRole.LIBRARIAN, tier: GardenTier.TIER_2, workspace_id: historical.workspace_id,
        success: true, objects_affected: [], audit_entries: [], error_message: null, completed_at: now() });

      expect(repo.findById(disabled.task_id)).toMatchObject({ status: "completed", outcome: "skipped" });
      expect(repo.findById(deferred.task_id)).toMatchObject({ status: "completed", outcome: "skipped" });
      expect(repo.findById(missing.task_id)).toMatchObject({ status: "failed", outcome: "failed" });
      expect(repo.findById(bulkDisabled.task_id)).toMatchObject({ status: "completed", outcome: "skipped" });
      expect(repo.findById(bulkMissing.task_id)).toMatchObject({ status: "failed", outcome: "failed" });
      expect(repo.findById(completed.task_id)).toMatchObject({ status: "completed", outcome: "completed" });
      expect(repo.findById(historical.task_id)).toMatchObject({ status: "completed", outcome: null });

      const events = (await eventLogRepo.queryByType(GardenEventType.SOUL_GARDEN_TASK_COMPLETED)).events;
      const event = (id: string) => events.find(entry => entry.entity_id === id)?.payload_json;
      expect(event(disabled.task_id)).toMatchObject({ success: true, outcome: "skipped" });
      expect(event(bulkDisabled.task_id)).toMatchObject({ success: true, outcome: "skipped" });
      expect(event(missing.task_id)).toMatchObject({ success: false, outcome: "failed" });
      expect(event(bulkMissing.task_id)).toMatchObject({ success: false, outcome: "failed" });
      expect(event(completed.task_id)).toMatchObject({ success: true, outcome: "completed" });
      expect(event(historical.task_id)).not.toHaveProperty("outcome");
      expect(repo.countBacklog()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("does not append a duplicate completion audit when the same committed completion is retried", async () => {
    const db = initDatabase({ filename: ":memory:" });
    try {
      const eventLogRepo = new SqliteEventLogRepo(db);
      const publisher = new EventPublisher({ eventLogRepo, runHotStateService: { apply: () => undefined },
        runtimeNotifier: { notify: () => undefined, notifyEntry: () => undefined } });
      const repo = new SqliteGardenTaskRepo(db.connection, publisher);
      const scheduler = new GardenScheduler({ append: async () => undefined }, { now }, null, repo);
      const work = task("completion-retry", GardenTaskKind.CONSOLIDATION_CYCLE);
      scheduler.enqueue(work);
      await scheduler.dispatchNext(GardenRole.LIBRARIAN);
      const result = { task_id: work.task_id, task_kind: work.task_kind, role: GardenRole.LIBRARIAN,
        tier: GardenTier.TIER_2, workspace_id: work.workspace_id, success: true, outcome: "skipped" as const,
        objects_affected: [], audit_entries: [], error_message: null, completed_at: now() };
      await scheduler.reportCompletion(result);
      await scheduler.reportCompletion(result);
      expect((await eventLogRepo.queryByType(GardenEventType.SOUL_GARDEN_TASK_COMPLETED)).events).toHaveLength(1);
      await expect(scheduler.reportCompletion({ ...result, outcome: "completed" })).rejects.toThrow();
      expect(repo.findById(work.task_id)).toMatchObject({ status: "completed", outcome: "skipped" });
      expect((await eventLogRepo.queryByType(GardenEventType.SOUL_GARDEN_TASK_COMPLETED)).events).toHaveLength(1);
    } finally { db.close(); }
  });

  it("rolls back the outcome and completion audit together when the SQLite update fails", async () => {
    const db = initDatabase({ filename: ":memory:" });
    try {
      const eventLogRepo = new SqliteEventLogRepo(db);
      const publisher = new EventPublisher({ eventLogRepo, runHotStateService: { apply: () => undefined },
        runtimeNotifier: { notify: () => undefined, notifyEntry: () => undefined } });
      const repo = new SqliteGardenTaskRepo(db.connection, publisher);
      const scheduler = new GardenScheduler({ append: async () => undefined }, { now }, null, repo);
      const disabled = task("outcome-write-fails", GardenTaskKind.CONSOLIDATION_CYCLE);
      scheduler.enqueue(disabled);
      await scheduler.dispatchNext(GardenRole.LIBRARIAN);
      db.connection.exec(`CREATE TRIGGER reject_garden_outcome BEFORE UPDATE OF outcome ON garden_tasks
        WHEN NEW.id = 'outcome-write-fails' BEGIN SELECT RAISE(ABORT, 'outcome write failed'); END`);
      await expect(scheduler.reportCompletion({ task_id: disabled.task_id, task_kind: disabled.task_kind,
        role: GardenRole.LIBRARIAN, tier: GardenTier.TIER_2, workspace_id: disabled.workspace_id,
        success: true, outcome: "skipped", objects_affected: [], audit_entries: [],
        error_message: null, completed_at: now() })).rejects.toThrow();
      expect(repo.findById(disabled.task_id)).toMatchObject({ status: "claimed", outcome: null });
      const events = (await eventLogRepo.queryByType(GardenEventType.SOUL_GARDEN_TASK_COMPLETED)).events;
      expect(events.filter(entry => entry.entity_id === disabled.task_id)).toEqual([]);
    } finally {
      db.close();
    }
  });
});
