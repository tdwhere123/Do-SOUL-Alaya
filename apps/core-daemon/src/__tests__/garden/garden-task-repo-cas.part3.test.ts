import { afterEach, describe, expect, it } from "vitest";

import { EventPublisher, type RuntimeNotifier } from "@do-soul/alaya-core";

import {
  GardenEventType,
  GardenRole,
  GardenTaskKind,
  GardenTier,
  parseGardenEventPayload,
  type EventLogEntry,
  type EventType,
  type GardenRoleValue,
  type GardenTaskDescriptor,
  type GardenTaskKindValue,
  type GardenTaskResult
} from "@do-soul/alaya-protocol";

import {
  initDatabase,
  SqliteEventLogRepo,
  SqliteGardenTaskRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";

import { GardenScheduler, type GardenSchedulerEventLogPort } from "@do-soul/alaya-soul";

const databases = new Set<StorageDatabase>();

function createHarness(): Readonly<{
  readonly database: StorageDatabase;
  readonly eventLogRepo: SqliteEventLogRepo;
  readonly eventPublisher: EventPublisher;
  readonly repo: SqliteGardenTaskRepo;
}> {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);
  const eventLogRepo = new SqliteEventLogRepo(database);
  const runtimeNotifier: RuntimeNotifier = {
    notify: () => {},
    notifyEntry: () => {}
  };
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
    created_at: "2026-05-07T00:00:00.000Z",
    ...overrides
  };
}

function createResult(overrides: Partial<GardenTaskResult> = {}): GardenTaskResult {
  return {
    task_id: "task-1",
    task_kind: GardenTaskKind.TTL_CLEANUP,
    role: GardenRole.JANITOR,
    tier: GardenTier.TIER_0,
    workspace_id: "workspace-1",
    success: true,
    objects_affected: [],
    audit_entries: [],
    error_message: null,
    completed_at: "2026-05-07T00:00:01.000Z",
    ...overrides
  };
}

function createTaskCompletedEvent(input: {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly taskKind: GardenTaskKindValue;
  readonly role: GardenRoleValue;
  readonly success: boolean;
  readonly occurredAt: string;
}): Omit<EventLogEntry, "event_id" | "created_at" | "revision"> {
  const tier =
    input.role === GardenRole.JANITOR
      ? GardenTier.TIER_0
      : input.role === GardenRole.AUDITOR
        ? GardenTier.TIER_1
        : GardenTier.TIER_2;
  return {
    event_type: GardenEventType.SOUL_GARDEN_TASK_COMPLETED,
    entity_type: "garden_task",
    entity_id: input.taskId,
    workspace_id: input.workspaceId,
    run_id: null,
    caused_by: "garden-task-repo-test",
    payload_json: parseGardenEventPayload(GardenEventType.SOUL_GARDEN_TASK_COMPLETED, {
      task_id: input.taskId,
      task_kind: input.taskKind,
      role: input.role,
      tier,
      success: input.success,
      objects_affected: [],
      workspace_id: input.workspaceId,
      occurred_at: input.occurredAt
    })
  };
}

function createTaskReclaimedEvent(input: {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly taskKind: GardenTaskKindValue;
  readonly role: GardenRoleValue;
  readonly previousClaimedBy: string;
  readonly claimedAt: string;
  readonly occurredAt: string;
  readonly staleAfterMs: number;
}): Omit<EventLogEntry, "event_id" | "created_at" | "revision"> {
  const tier =
    input.role === GardenRole.JANITOR
      ? GardenTier.TIER_0
      : input.role === GardenRole.AUDITOR
        ? GardenTier.TIER_1
        : GardenTier.TIER_2;
  return {
    event_type: GardenEventType.SOUL_GARDEN_TASK_CLAIM_RECLAIMED,
    entity_type: "garden_task",
    entity_id: input.taskId,
    workspace_id: input.workspaceId,
    run_id: null,
    caused_by: "garden-task-repo-test",
    payload_json: parseGardenEventPayload(GardenEventType.SOUL_GARDEN_TASK_CLAIM_RECLAIMED, {
      task_id: input.taskId,
      task_kind: input.taskKind,
      role: input.role,
      tier,
      workspace_id: input.workspaceId,
      run_id: null,
      previous_claimed_by: input.previousClaimedBy,
      claimed_at: input.claimedAt,
      stale_after_ms: input.staleAfterMs,
      occurred_at: input.occurredAt
    })
  };
}

function createSchedulerEventLogPort(eventPublisher: EventPublisher): GardenSchedulerEventLogPort {
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

interface GardenTaskDbRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly status: string;
  readonly claimed_by: string | null;
  readonly claimed_at: string | null;
  readonly completed_at: string | null;
  readonly last_error_text: string | null;
}

function getGardenTask(database: StorageDatabase, taskId: string): GardenTaskDbRow {
  const row = database.connection
    .prepare(
      `SELECT id, workspace_id, status, claimed_by, claimed_at, completed_at, last_error_text
       FROM garden_tasks
       WHERE id = ?`
    )
    .get(taskId) as GardenTaskDbRow | undefined;
  if (row === undefined) {
    throw new Error(`Missing garden task ${taskId}`);
  }
  return row;
}

function listGardenTasks(database: StorageDatabase): readonly GardenTaskDbRow[] {
  return database.connection
    .prepare(
      `SELECT id, workspace_id, status, claimed_by, claimed_at, completed_at, last_error_text
       FROM garden_tasks
       ORDER BY id ASC`
    )
    .all() as GardenTaskDbRow[];
}

afterEach(() => {
  for (const database of databases) {
    database.close();
  }
  databases.clear();
});

describe("SqliteGardenTaskRepo — CAS-backed Garden queue", () => {

  it("keeps the in-process scheduler on the SQLite CAS path", async () => {
    const { database, eventPublisher, repo } = createHarness();
    const scheduler = new GardenScheduler(
      createSchedulerEventLogPort(eventPublisher),
      { now: () => "2026-05-07T00:00:00.000Z" },
      null,
      repo
    );

    scheduler.enqueue(
      createTask({
        task_id: "task-scheduler-cas",
        workspace_id: "workspace-scheduler"
      })
    );

    const dispatched = await scheduler.dispatchNext(GardenRole.JANITOR);
    expect(dispatched?.task_id).toBe("task-scheduler-cas");

    await scheduler.reportCompletion(
      createResult({
        task_id: "task-scheduler-cas",
        workspace_id: "workspace-scheduler"
      })
    );

    const row = getGardenTask(database, "task-scheduler-cas");
    expect(row.status).toBe("completed");
    expect(row.claimed_by).toBe("in-process");
  });

  it("filters pending tasks by workspace when requested", () => {
    const { repo } = createHarness();
    repo.enqueue({
      id: "task-workspace-a-1",
      workspace_id: "workspace-a",
      role: GardenRole.JANITOR,
      kind: GardenTaskKind.TTL_CLEANUP,
      payload: createTask({ task_id: "task-workspace-a-1", workspace_id: "workspace-a" }),
      created_at: "2026-05-07T00:00:00.000Z"
    });
    repo.enqueue({
      id: "task-workspace-a-2",
      workspace_id: "workspace-a",
      role: GardenRole.JANITOR,
      kind: GardenTaskKind.TTL_CLEANUP,
      payload: createTask({ task_id: "task-workspace-a-2", workspace_id: "workspace-a" }),
      created_at: "2026-05-07T00:00:01.000Z"
    });
    repo.enqueue({
      id: "task-workspace-b-1",
      workspace_id: "workspace-b",
      role: GardenRole.JANITOR,
      kind: GardenTaskKind.TTL_CLEANUP,
      payload: createTask({ task_id: "task-workspace-b-1", workspace_id: "workspace-b" }),
      created_at: "2026-05-07T00:00:02.000Z"
    });

    expect(repo.peekPending(GardenRole.JANITOR, "workspace-a").map((row) => row.workspace_id)).toEqual([
      "workspace-a",
      "workspace-a"
    ]);
    expect(repo.peekPending(GardenRole.JANITOR).map((row) => row.workspace_id).sort()).toEqual([
      "workspace-a",
      "workspace-a",
      "workspace-b"
    ]);
  });

  it("records failed completion status and failure audit event atomically", async () => {
    const { database, eventLogRepo, repo } = createHarness();
    repo.enqueue({
      id: "task-failed",
      workspace_id: "workspace-failed",
      role: GardenRole.AUDITOR,
      kind: GardenTaskKind.EVIDENCE_STALENESS_CHECK,
      payload: createTask({
        task_id: "task-failed",
        task_kind: GardenTaskKind.EVIDENCE_STALENESS_CHECK,
        required_tier: GardenTier.TIER_1,
        workspace_id: "workspace-failed"
      }),
      created_at: "2026-05-07T00:00:00.000Z"
    });
    expect(repo.claimAtomic("task-failed", "agent-target-failed", "2026-05-07T00:00:01.000Z")).toBe(
      "claimed"
    );

    await repo.completeWithEvents(
      "task-failed",
      {
        status: "failed",
        completed_at: "2026-05-07T00:00:02.000Z",
        last_error_text: "boom"
      },
      [
        createTaskCompletedEvent({
          taskId: "task-failed",
          workspaceId: "workspace-failed",
          taskKind: GardenTaskKind.EVIDENCE_STALENESS_CHECK,
          role: GardenRole.AUDITOR,
          success: false,
          occurredAt: "2026-05-07T00:00:02.000Z"
        })
      ],
      "agent-target-failed"
    );

    const row = getGardenTask(database, "task-failed");
    expect(row.status).toBe("failed");
    expect(row.last_error_text).toBe("boom");

    const events = await eventLogRepo.queryByEntity("garden_task", "task-failed");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event_type: GardenEventType.SOUL_GARDEN_TASK_COMPLETED,
      entity_id: "task-failed"
    });
    expect(events[0]?.payload_json).toMatchObject({ success: false });
  });

  // invariant: duplicate task ids surface as StorageError code
  // "DUPLICATE_KEY"; callers must not parse better-sqlite3 message text.
  it("surfaces DUPLICATE_KEY when an explicit task_id is reused", () => {
    const { repo } = createHarness();
    const baseInput = {
      id: "task-duplicate",
      workspace_id: "workspace-a",
      role: GardenRole.JANITOR,
      kind: GardenTaskKind.TTL_CLEANUP,
      payload: {
        task_id: "task-duplicate",
        task_kind: GardenTaskKind.TTL_CLEANUP,
        required_tier: GardenTier.TIER_0,
        workspace_id: "workspace-a",
        run_id: "run-a",
        target_object_refs: ["memory-1"],
        priority: 10,
        created_at: "2026-05-07T00:00:00.000Z"
      } as GardenTaskDescriptor
    };
    repo.enqueue(baseInput);

    let captured: unknown;
    try {
      repo.enqueue(baseInput);
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeDefined();
    expect((captured as { readonly code?: unknown }).code).toBe("DUPLICATE_KEY");
  });
});
