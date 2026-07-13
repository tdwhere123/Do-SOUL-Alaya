import { afterEach, describe, expect, it } from "vitest";

import { EventPublisher, type RuntimeNotifier } from "@do-soul/alaya-core";
import {
  GardenEventType,
  GardenRole,
  GardenTaskKind,
  GardenTier,
  parseGardenEventPayload,
  type EventType,
  type GardenTaskDescriptor
} from "@do-soul/alaya-protocol";
import {
  initDatabase,
  SqliteEventLogRepo,
  SqliteGardenTaskRepo,
  type GardenTaskEventInput,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { GardenScheduler, type GardenSchedulerEventLogPort } from "@do-soul/alaya-soul";

const databases = new Set<StorageDatabase>();

function createHarness() {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);
  const eventLogRepo = new SqliteEventLogRepo(database);
  const runtimeNotifier: RuntimeNotifier = { notify: () => {}, notifyEntry: () => {} };
  const eventPublisher = new EventPublisher({
    eventLogRepo,
    runHotStateService: { apply: () => {} },
    runtimeNotifier
  });
  const repo = new SqliteGardenTaskRepo(database.connection, eventPublisher);
  return { database, eventLogRepo, eventPublisher, repo };
}

function createTask(overrides: Partial<GardenTaskDescriptor> = {}): GardenTaskDescriptor {
  return {
    task_id: "task-1",
    task_kind: GardenTaskKind.TTL_CLEANUP,
    required_tier: GardenTier.TIER_0,
    workspace_id: "workspace-1",
    run_id: null,
    target_object_refs: ["memory-1"],
    priority: 10,
    created_at: "2026-07-14T00:00:00.000Z",
    ...overrides
  };
}

function createFailureEvent(taskId: string): GardenTaskEventInput {
  return {
    event_type: GardenEventType.SOUL_GARDEN_TASK_COMPLETED,
    entity_type: "garden_task",
    entity_id: taskId,
    workspace_id: "workspace-1",
    run_id: null,
    caused_by: "garden-scheduler",
    payload_json: parseGardenEventPayload(GardenEventType.SOUL_GARDEN_TASK_COMPLETED, {
      task_id: taskId,
      task_kind: GardenTaskKind.TTL_CLEANUP,
      role: GardenRole.JANITOR,
      tier: GardenTier.TIER_0,
      success: false,
      objects_affected: [],
      workspace_id: "workspace-1",
      occurred_at: "2026-07-14T00:00:01.000Z"
    })
  };
}

function createSchedulerEventLog(eventPublisher: EventPublisher): GardenSchedulerEventLogPort {
  return {
    append: async (entry) => {
      await eventPublisher.publish({
        event_type: entry.event_type as EventType,
        entity_type: entry.entity_type,
        entity_id: entry.entity_id,
        workspace_id: entry.workspace_id,
        run_id: entry.run_id,
        caused_by: "garden-scheduler",
        payload_json: entry.payload
      });
    }
  };
}

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

describe("Garden invalid-task quarantine", () => {
  it("atomically audits a bad row and continues to a later legal matching task", async () => {
    const { eventLogRepo, eventPublisher, repo } = createHarness();
    const scheduler = new GardenScheduler(
      createSchedulerEventLog(eventPublisher),
      { now: () => "2026-07-14T00:00:01.000Z", warn: () => {} },
      null,
      repo
    );
    const invalid = createTask({
      task_id: "task-invalid-routing",
      required_tier: GardenTier.TIER_1,
      priority: 50
    });
    repo.enqueue({
      id: invalid.task_id,
      workspace_id: invalid.workspace_id,
      role: GardenRole.JANITOR,
      kind: invalid.task_kind,
      payload: invalid,
      created_at: invalid.created_at
    });
    scheduler.enqueue(createTask({ task_id: "task-valid-routing", priority: 40 }));

    await expect(
      scheduler.dispatchNextMatchingTaskKind(GardenRole.JANITOR, [GardenTaskKind.TTL_CLEANUP])
    ).resolves.toMatchObject({ task_id: "task-valid-routing" });
    expect(repo.findById(invalid.task_id)).toMatchObject({
      status: "failed",
      claimed_by: null,
      last_error_text: expect.stringContaining("does not match required tier")
    });
    const events = await eventLogRepo.queryByEntity("garden_task", invalid.task_id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event_type: GardenEventType.SOUL_GARDEN_TASK_COMPLETED,
      payload_json: {
        task_id: invalid.task_id,
        task_kind: GardenTaskKind.TTL_CLEANUP,
        role: GardenRole.JANITOR,
        tier: GardenTier.TIER_0,
        success: false,
        objects_affected: [],
        workspace_id: "workspace-1",
        occurred_at: "2026-07-14T00:00:01.000Z"
      }
    });
  });

  it("allows only one concurrent pending-to-failed quarantine", async () => {
    const { eventLogRepo, repo } = createHarness();
    const task = createTask({ task_id: "task-concurrent-quarantine" });
    repo.enqueue({
      id: task.task_id,
      workspace_id: task.workspace_id,
      role: GardenRole.JANITOR,
      kind: task.task_kind,
      payload: task,
      created_at: task.created_at
    });

    const outcomes = await Promise.all([
      repo.failPendingWithCompletionEvent(
        task.task_id,
        "2026-07-14T00:00:01.000Z",
        "invalid envelope",
        createFailureEvent(task.task_id)
      ),
      repo.failPendingWithCompletionEvent(
        task.task_id,
        "2026-07-14T00:00:01.000Z",
        "invalid envelope",
        createFailureEvent(task.task_id)
      )
    ]);

    expect(outcomes.filter(Boolean)).toHaveLength(1);
    await expect(eventLogRepo.queryByEntity("garden_task", task.task_id)).resolves.toHaveLength(1);
  });

  it("rolls an event append failure back to pending", async () => {
    const { database, eventLogRepo, repo } = createHarness();
    const task = createTask({ task_id: "task-audit-failure" });
    repo.enqueue({
      id: task.task_id,
      workspace_id: task.workspace_id,
      role: GardenRole.JANITOR,
      kind: task.task_kind,
      payload: task,
      created_at: task.created_at
    });
    database.connection.exec(`
      CREATE TRIGGER reject_quarantine_audit
      BEFORE INSERT ON event_log
      WHEN NEW.entity_id = 'task-audit-failure'
      BEGIN
        SELECT RAISE(ABORT, 'quarantine audit rejected');
      END
    `);

    await expect(
      repo.failPendingWithCompletionEvent(
        task.task_id,
        "2026-07-14T00:00:01.000Z",
        "invalid envelope",
        createFailureEvent(task.task_id)
      )
    ).rejects.toThrow();
    expect(repo.findById(task.task_id)).toMatchObject({
      status: "pending",
      completed_at: null,
      last_error_text: null
    });
    await expect(eventLogRepo.queryByEntity("garden_task", task.task_id)).resolves.toEqual([]);
  });

  it("rolls back a preceding tier audit when the completion event fails", async () => {
    const { database, eventLogRepo, eventPublisher, repo } = createHarness();
    const scheduler = new GardenScheduler(
      createSchedulerEventLog(eventPublisher),
      { now: () => "2026-07-14T00:00:01.000Z", warn: () => {} },
      null,
      repo
    );
    const task = createTask({
      task_id: "task-tier-audit-failure",
      task_kind: GardenTaskKind.GREEN_MAINTENANCE,
      required_tier: GardenTier.TIER_1
    });
    repo.enqueue({
      id: task.task_id,
      workspace_id: task.workspace_id,
      role: GardenRole.JANITOR,
      kind: task.task_kind,
      payload: task,
      created_at: task.created_at
    });
    database.connection.exec(`
      CREATE TRIGGER reject_tier_failure_completion
      BEFORE INSERT ON event_log
      WHEN NEW.entity_id = 'task-tier-audit-failure'
        AND NEW.event_type = 'soul.garden.task_completed'
      BEGIN
        SELECT RAISE(ABORT, 'tier completion audit rejected');
      END
    `);

    await expect(scheduler.dispatchNext(GardenRole.JANITOR)).rejects.toThrow();
    expect(repo.findById(task.task_id)).toMatchObject({
      status: "pending",
      completed_at: null,
      last_error_text: null
    });
    await expect(eventLogRepo.queryByEntity("garden_task", task.task_id)).resolves.toEqual([]);
  });
});
