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

  // invariant: Promise.all over these synchronous repo calls is a same-thread
  // stress probe, not OS-level parallelism. The durable contract is the row-level
  // SQL CAS: every task reaches exactly one completed row with at most one claim
  // winner, verified below by SQL aggregation.
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
            const result = await repo.claimAtomic(
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
              ],
              `agent-target-${claimerIndex + 1}`
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

    // invariant: no double-claim means one completion event per task id.
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

  it("reclaims stale claimed tasks with an audit event", async () => {
    const { database, eventLogRepo, repo } = createHarness();
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
    await expect(
      repo.claimAtomic("task-stale-claim", "agent-target-a", "2026-05-07T00:00:00.000Z")
    ).resolves.toBe("claimed");

    const abandoned = repo.peekAbandonedClaims("2026-05-07T00:10:00.000Z", 5 * 60 * 1000);
    const reclaimed = await repo.gcAbandonedClaims(
      abandoned.map((row) => ({
        task_id: row.id,
        claimed_by: row.claimed_by!,
        claimed_at: row.claimed_at!,
        event: createTaskReclaimedEvent({
          taskId: row.id,
          workspaceId: row.workspace_id,
          taskKind: row.kind,
          role: row.role,
          previousClaimedBy: row.claimed_by!,
          claimedAt: row.claimed_at!,
          occurredAt: "2026-05-07T00:10:00.000Z",
          staleAfterMs: 5 * 60 * 1000
        })
      }))
    );

    expect(reclaimed).toBe(1);
    const row = getGardenTask(database, "task-stale-claim");
    expect(row.status).toBe("pending");
    expect(row.claimed_by).toBeNull();
    expect(row.claimed_at).toBeNull();
    await expect(eventLogRepo.queryByType(GardenEventType.SOUL_GARDEN_TASK_CLAIM_RECLAIMED)).resolves.toEqual([
      expect.objectContaining({
        entity_id: "task-stale-claim",
        caused_by: "garden-task-repo-test",
        payload_json: expect.objectContaining({
          previous_claimed_by: "agent-target-a",
          stale_after_ms: 5 * 60 * 1000
        })
      })
    ]);
  });

  it("does not complete a task after another claimant reclaims the same id", async () => {
    const { database, repo } = createHarness();
    repo.enqueue({
      id: "task-claimant-cas",
      workspace_id: "workspace-cas",
      role: GardenRole.JANITOR,
      kind: GardenTaskKind.TTL_CLEANUP,
      payload: createTask({
        task_id: "task-claimant-cas",
        workspace_id: "workspace-cas"
      }),
      created_at: "2026-05-07T00:00:00.000Z"
    });
    await expect(
      repo.claimAtomic("task-claimant-cas", "agent-target-a", "2026-05-07T00:00:00.000Z")
    ).resolves.toBe("claimed");
    const abandoned = repo.peekAbandonedClaims("2026-05-07T00:10:00.000Z", 5 * 60 * 1000);
    await repo.gcAbandonedClaims(
      abandoned.map((row) => ({
        task_id: row.id,
        claimed_by: row.claimed_by!,
        claimed_at: row.claimed_at!,
        event: createTaskReclaimedEvent({
          taskId: row.id,
          workspaceId: row.workspace_id,
          taskKind: row.kind,
          role: row.role,
          previousClaimedBy: row.claimed_by!,
          claimedAt: row.claimed_at!,
          occurredAt: "2026-05-07T00:10:00.000Z",
          staleAfterMs: 5 * 60 * 1000
        })
      }))
    );
    await expect(
      repo.claimAtomic("task-claimant-cas", "agent-target-b", "2026-05-07T00:11:00.000Z")
    ).resolves.toBe("claimed");

    await expect(
      repo.completeWithEvents(
        "task-claimant-cas",
        { status: "completed", completed_at: "2026-05-07T00:12:00.000Z" },
        [
          createTaskCompletedEvent({
            taskId: "task-claimant-cas",
            workspaceId: "workspace-cas",
            taskKind: GardenTaskKind.TTL_CLEANUP,
            role: GardenRole.JANITOR,
            success: true,
            occurredAt: "2026-05-07T00:12:00.000Z"
          })
        ],
        "agent-target-a"
      )
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(getGardenTask(database, "task-claimant-cas")).toMatchObject({
      status: "claimed",
      claimed_by: "agent-target-b"
    });
  });
});
