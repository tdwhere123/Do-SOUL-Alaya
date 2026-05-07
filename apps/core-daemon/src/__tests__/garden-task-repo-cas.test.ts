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

afterEach(() => {
  for (const database of databases) {
    database.close();
  }
  databases.clear();
});

describe("SqliteGardenTaskRepo — CAS-backed Garden queue", () => {
  it("allows exactly one claimant to win a single pending task", async () => {
    const { database, repo } = createHarness();
    repo.enqueue({
      id: "task-single-claim",
      workspace_id: "workspace-claim",
      role: GardenRole.JANITOR,
      kind: GardenTaskKind.TTL_CLEANUP,
      payload: createTask({
        task_id: "task-single-claim",
        workspace_id: "workspace-claim"
      }),
      created_at: "2026-05-07T00:00:00.000Z"
    });

    const results = await Promise.all([
      Promise.resolve().then(() =>
        repo.claimAtomic("task-single-claim", "agent-target-a", "2026-05-07T00:00:01.000Z")
      ),
      Promise.resolve().then(() =>
        repo.claimAtomic("task-single-claim", "agent-target-b", "2026-05-07T00:00:01.000Z")
      )
    ]);

    expect(results.filter((result) => result === "claimed")).toHaveLength(1);
    expect(results.filter((result) => result === "already-claimed")).toHaveLength(1);

    const row = getGardenTask(database, "task-single-claim");
    expect(row.status).toBe("claimed");
    expect(["agent-target-a", "agent-target-b"]).toContain(row.claimed_by);
  });

  // Wave-end M7 (Reviewer I6): better-sqlite3 is single-threaded
  // synchronous, so this Promise.all does NOT exercise true OS-level
  // concurrency — JavaScript serialises the 800 claim attempts on one
  // thread. The test still proves something useful: the SQL CAS
  // predicate `UPDATE garden_tasks SET status='claimed' WHERE
  // status='pending'` is intrinsically self-atomic at the row level,
  // and the overall invariant `every task ends with exactly one
  // completed row + at most one claim winner` holds across whatever
  // interleaving the runtime produces. We assert the invariant
  // directly via SQL aggregation below so the test makes its claim
  // explicit rather than relying on Promise.all to imply concurrency.
  it("completes 100 tasks once each under an 8-claimer race", async () => {
    const { database, eventLogRepo, repo } = createHarness();
    const taskIds = Array.from({ length: 100 }, (_, index) => `task-race-${index + 1}`);

    for (const taskId of taskIds) {
      repo.enqueue({
        id: taskId,
        workspace_id: "workspace-race",
        role: GardenRole.JANITOR,
        kind: GardenTaskKind.TTL_CLEANUP,
        payload: createTask({ task_id: taskId, workspace_id: "workspace-race" }),
        created_at: "2026-05-07T00:00:00.000Z"
      });
    }

    await Promise.all(
      Array.from({ length: 8 }, (_, claimerIndex) =>
        Promise.resolve().then(async () => {
          for (const taskId of taskIds) {
            const result = repo.claimAtomic(
              taskId,
              `agent-target-${claimerIndex + 1}`,
              `2026-05-07T00:00:0${claimerIndex}.000Z`
            );
            if (result !== "claimed") {
              continue;
            }
            await repo.completeWithEvents(
              taskId,
              {
                status: "completed",
                completed_at: "2026-05-07T00:01:00.000Z"
              },
              [
                createTaskCompletedEvent({
                  taskId,
                  workspaceId: "workspace-race",
                  taskKind: GardenTaskKind.TTL_CLEANUP,
                  role: GardenRole.JANITOR,
                  success: true,
                  occurredAt: "2026-05-07T00:01:00.000Z"
                })
              ]
            );
          }
        })
      )
    );

    const rows = listGardenTasks(database);
    expect(rows.filter((row) => row.status === "completed")).toHaveLength(100);
    expect(rows.filter((row) => row.status === "claimed")).toHaveLength(0);
    expect(new Set(rows.filter((row) => row.status === "completed").map((row) => row.id)).size).toBe(100);

    const completionEvents = await eventLogRepo.queryByType(
      GardenEventType.SOUL_GARDEN_TASK_COMPLETED
    );
    expect(completionEvents).toHaveLength(100);

    // M7 (with Codex re-review N1 calibration): the load-bearing
    // invariant for "no double-claim" is the count of distinct
    // entity_ids across SOUL_GARDEN_TASK_COMPLETED events — if two
    // claimers had both succeeded for the same task, we would have
    // appended two completion events with the same entity_id and
    // either the count of distinct entity_ids would be < 100 OR the
    // total completionEvents count would be > 100. We assert both.
    expect(new Set(completionEvents.map((event) => event.entity_id)).size).toBe(100);
    expect(completionEvents.length).toBe(100);
    // The garden_tasks row count grouped by id is a weaker smoke check
    // (it primarily proves the PK constraint held, which SQLite would
    // do regardless of the CAS contract). Kept as a defensive scan.
    const idCountRows = (
      database.connection
        .prepare(
          "SELECT id, COUNT(*) AS row_count FROM garden_tasks GROUP BY id ORDER BY id"
        )
        .all() as readonly { readonly id: string; readonly row_count: number }[]
    );
    expect(idCountRows).toHaveLength(100);
    for (const row of idCountRows) {
      expect(row.row_count).toBe(1);
    }
  });

  it("reclaims stale claimed tasks through gcAbandonedClaims", () => {
    const { database, repo } = createHarness();
    repo.enqueue({
      id: "task-stale-claim",
      workspace_id: "workspace-gc",
      role: GardenRole.JANITOR,
      kind: GardenTaskKind.TTL_CLEANUP,
      payload: createTask({
        task_id: "task-stale-claim",
        workspace_id: "workspace-gc"
      }),
      created_at: "2026-05-07T00:00:00.000Z"
    });
    expect(
      repo.claimAtomic("task-stale-claim", "agent-target-a", "2026-05-07T00:00:00.000Z")
    ).toBe("claimed");

    const reclaimed = repo.gcAbandonedClaims("2026-05-07T00:10:00.000Z", 5 * 60 * 1000);

    expect(reclaimed).toBe(1);
    const row = getGardenTask(database, "task-stale-claim");
    expect(row.status).toBe("pending");
    expect(row.claimed_by).toBeNull();
    expect(row.claimed_at).toBeNull();
  });

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
      ]
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

  // Wave-end M3: enqueue surfaces a structured StorageError with
  // code === "DUPLICATE_KEY" on PK collision. Callers (H3 dedupe) walk
  // the cause chain on the structured code instead of scanning
  // better-sqlite3's error message text. Mirrors workspace-repo's
  // I3 contract from commit aacb4f2.
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
