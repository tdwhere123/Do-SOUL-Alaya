import { afterEach, describe, expect, it, vi } from "vitest";

import { EventPublisher, type RuntimeNotifier } from "@do-soul/alaya-core";

import {
  EdgeClassifyTaskPayloadSchema,
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

  // invariant: never-claimed host-worker tasks past their TTL are removed
  // (audited), while a recent unclaimed task and any claimed task are left intact.
  it("expires only never-claimed EDGE_CLASSIFY tasks older than the cutoff", async () => {
    const { database, repo } = createHarness();
    repo.enqueue({
      id: "edge-old",
      workspace_id: "workspace-1",
      role: GardenRole.LIBRARIAN,
      kind: GardenTaskKind.EDGE_CLASSIFY,
      payload: { task_kind: GardenTaskKind.EDGE_CLASSIFY },
      created_at: "2026-05-01T00:00:00.000Z"
    });
    repo.enqueue({
      id: "edge-recent",
      workspace_id: "workspace-1",
      role: GardenRole.LIBRARIAN,
      kind: GardenTaskKind.EDGE_CLASSIFY,
      payload: { task_kind: GardenTaskKind.EDGE_CLASSIFY },
      created_at: "2026-05-20T00:00:00.000Z"
    });

    const cutoffIso = "2026-05-10T00:00:00.000Z";
    const expired = repo.peekExpiredUnclaimedTasks(GardenTaskKind.EDGE_CLASSIFY, cutoffIso, 64);
    expect(expired.map((row) => row.id)).toEqual(["edge-old"]);

    const removed = await repo.expireUnclaimedTasks(
      expired.map((row) => ({
        task_id: row.id,
        event: {
          event_type: GardenEventType.SOUL_GARDEN_TASK_EXPIRED,
          entity_type: "garden_task",
          entity_id: row.id,
          workspace_id: row.workspace_id,
          run_id: null,
          caused_by: "garden-runtime",
          payload_json: parseGardenEventPayload(GardenEventType.SOUL_GARDEN_TASK_EXPIRED, {
            task_id: row.id,
            task_kind: row.kind,
            role: row.role,
            tier: GardenTier.TIER_2,
            workspace_id: row.workspace_id,
            run_id: null,
            enqueued_at: row.created_at,
            ttl_ms: 7 * 24 * 60 * 60 * 1000,
            occurred_at: "2026-05-21T00:00:00.000Z"
          })
        }
      }))
    );
    expect(removed).toBe(1);

    // edge-old is gone; edge-recent remains pending.
    expect(repo.findById("edge-old")).toBeNull();
    expect(getGardenTask(database, "edge-recent").status).toBe("pending");
  });

  it("does not expire a claimed task even if its created_at is past the cutoff", async () => {
    const { database, repo } = createHarness();
    repo.enqueue({
      id: "edge-claimed",
      workspace_id: "workspace-1",
      role: GardenRole.LIBRARIAN,
      kind: GardenTaskKind.EDGE_CLASSIFY,
      payload: { task_kind: GardenTaskKind.EDGE_CLASSIFY },
      created_at: "2026-05-01T00:00:00.000Z"
    });
    await expect(
      repo.claimAtomic("edge-claimed", "agent-target-a", "2026-05-02T00:00:00.000Z")
    ).resolves.toBe("claimed");

    // peek selects only status='pending' rows, so a claimed task is never listed.
    const expired = repo.peekExpiredUnclaimedTasks(
      GardenTaskKind.EDGE_CLASSIFY,
      "2026-05-10T00:00:00.000Z",
      64
    );
    expect(expired).toHaveLength(0);
    expect(getGardenTask(database, "edge-claimed").status).toBe("claimed");
  });

  it("routes in-process work around persisted host-worker tasks", async () => {
    const { database, eventPublisher, repo } = createHarness();
    const warn = vi.fn();
    const scheduler = new GardenScheduler(
      createSchedulerEventLogPort(eventPublisher),
      { warn },
      null,
      repo
    );
    const edgeTask = EdgeClassifyTaskPayloadSchema.parse({
      task_id: "task-edge-host-worker",
      task_kind: GardenTaskKind.EDGE_CLASSIFY,
      required_tier: GardenTier.TIER_2,
      workspace_id: "workspace-A",
      run_id: "run-A",
      priority: 100,
      created_at: "2026-05-07T00:00:00.000Z",
      dimension: "fact",
      scope_class: "project",
      source_memory: { object_id: "source-A", content: "source", domain_tags: [] },
      neighbor_memory: { object_id: "neighbor-A", content: "neighbor", domain_tags: [] },
      source_signal_id: "signal-A"
    });
    repo.enqueue({
      id: edgeTask.task_id,
      workspace_id: edgeTask.workspace_id,
      role: GardenRole.LIBRARIAN,
      kind: edgeTask.task_kind,
      payload: edgeTask,
      created_at: edgeTask.created_at
    });
    const mismatchedTask = createTask({
      task_id: "task-mismatched-kind",
      task_kind: GardenTaskKind.EMBEDDING_BACKFILL,
      required_tier: GardenTier.TIER_2,
      workspace_id: "workspace-A",
      target_object_refs: ["workspace-A"],
      priority: 90
    });
    repo.enqueue({
      id: mismatchedTask.task_id,
      workspace_id: mismatchedTask.workspace_id,
      role: GardenRole.LIBRARIAN,
      kind: GardenTaskKind.BULK_ENRICH,
      payload: mismatchedTask,
      created_at: mismatchedTask.created_at
    });
    const invalidTierTask = createTask({
      task_id: "task-invalid-kind-tier",
      task_kind: GardenTaskKind.MERGE_PROPOSAL,
      required_tier: GardenTier.TIER_0,
      priority: 80
    });
    repo.enqueue({
      id: invalidTierTask.task_id,
      workspace_id: invalidTierTask.workspace_id,
      role: GardenRole.JANITOR,
      kind: invalidTierTask.task_kind,
      payload: invalidTierTask,
      created_at: invalidTierTask.created_at
    });
    scheduler.enqueue(
      createTask({
        task_id: "task-backfill-a",
        task_kind: GardenTaskKind.EMBEDDING_BACKFILL,
        required_tier: GardenTier.TIER_2,
        workspace_id: "workspace-A",
        target_object_refs: ["workspace-A"],
        priority: 30
      })
    );
    scheduler.enqueue(
      createTask({
        task_id: "task-bulk-a",
        task_kind: GardenTaskKind.BULK_ENRICH,
        required_tier: GardenTier.TIER_2,
        workspace_id: "workspace-A",
        target_object_refs: ["workspace-A"],
        priority: 40
      })
    );
    scheduler.enqueue(
      createTask({
        task_id: "task-backfill-b",
        task_kind: GardenTaskKind.EMBEDDING_BACKFILL,
        required_tier: GardenTier.TIER_2,
        workspace_id: "workspace-B",
        target_object_refs: ["workspace-B"],
        priority: 50
      })
    );

    await expect(
      scheduler.dispatchNextMatchingTaskKind(
        GardenRole.LIBRARIAN,
        [GardenTaskKind.EMBEDDING_BACKFILL],
        "workspace-A"
      )
    ).resolves.toMatchObject({ task_id: "task-backfill-a", workspace_id: "workspace-A" });
    await expect(
      scheduler.dispatchNextMatchingTaskKind(
        GardenRole.LIBRARIAN,
        [GardenTaskKind.EMBEDDING_BACKFILL],
        "workspace-A"
      )
    ).resolves.toBeNull();
    await expect(
      scheduler.dispatchNextMatchingTaskKind(GardenRole.LIBRARIAN, [
        GardenTaskKind.EMBEDDING_BACKFILL
      ])
    ).resolves.toMatchObject({ task_id: "task-backfill-b", workspace_id: "workspace-B" });
    await expect(
      scheduler.dispatchNextMatchingTaskKind(GardenRole.LIBRARIAN, [
        GardenTaskKind.EDGE_CLASSIFY
      ])
    ).resolves.toBeNull();

    expect(repo.peekPending(GardenRole.LIBRARIAN).map((task) => task.id)).toEqual([
      "task-edge-host-worker",
      "task-mismatched-kind",
      "task-invalid-kind-tier",
      "task-bulk-a"
    ]);
    await expect(scheduler.dispatchNext(GardenRole.LIBRARIAN)).resolves.toMatchObject({
      task_id: "task-bulk-a"
    });
    expect(repo.peekPending(GardenRole.LIBRARIAN).map((task) => task.id)).toEqual([
      "task-edge-host-worker"
    ]);
    expect(getGardenTask(database, mismatchedTask.task_id)).toMatchObject({
      status: "failed",
      last_error_text: expect.stringContaining("kind")
    });
    expect(getGardenTask(database, invalidTierTask.task_id)).toMatchObject({
      status: "failed",
      last_error_text: expect.stringContaining("not allowed")
    });
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
