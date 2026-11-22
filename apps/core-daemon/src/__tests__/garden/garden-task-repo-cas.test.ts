import { describe, expect, it, vi } from "vitest";

import {
  EdgeClassifyTaskPayloadSchema,
  GardenEventType,
  GardenRole,
  GardenTaskKind,
  GardenTier,
  parseGardenEventPayload,
  type GardenTaskDescriptor
} from "@do-soul/alaya-protocol";

import { GardenScheduler } from "@do-soul/alaya-soul";

import {
  createHarness,
  createTask,
  createResult,
  createTaskCompletedEvent,
  createTaskReclaimedEvent,
  createSchedulerEventLogPort,
  getGardenTask,
  listGardenTasks
} from "./garden-task-repo-cas-fixture.js";

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

  it("does not append an expiry event when a task is claimed after selection", async () => {
    const { repo, eventLogRepo } = createHarness();
    repo.enqueue({ id: "edge-race", workspace_id: "workspace-1", role: GardenRole.LIBRARIAN,
      kind: GardenTaskKind.EDGE_CLASSIFY, payload: {}, created_at: "2026-05-01T00:00:00.000Z" });
    const row = repo.peekExpiredUnclaimedTasks(GardenTaskKind.EDGE_CLASSIFY, "2026-05-10T00:00:00.000Z", 1)[0]!;
    await repo.claimAtomic(row.id, "worker", "2026-05-11T00:00:00.000Z");
    expect(await repo.expireUnclaimedTasks([{ task_id: row.id, event: {
      event_type: GardenEventType.SOUL_GARDEN_TASK_EXPIRED, entity_type: "garden_task", entity_id: row.id,
      workspace_id: row.workspace_id, run_id: null, caused_by: "garden-runtime",
      payload_json: parseGardenEventPayload(GardenEventType.SOUL_GARDEN_TASK_EXPIRED, {
        task_id: row.id, task_kind: row.kind, role: row.role, tier: GardenTier.TIER_2,
        workspace_id: row.workspace_id, run_id: null, enqueued_at: row.created_at,
        ttl_ms: 604800000, occurred_at: "2026-05-11T00:00:00.000Z"
      })
    } }])).toBe(0);
    expect(repo.findById(row.id)?.status).toBe("claimed");
    expect(await eventLogRepo.queryByEntity("garden_task", row.id)).toEqual([]);
  });

  it("coalesces periodic workspace scans until completion without dropping manual or other-workspace work", async () => {
    const { repo } = createHarness();
    const task = { workspace_id: "workspace-1", role: GardenRole.JANITOR, kind: GardenTaskKind.TTL_CLEANUP,
      payload: { periodic: true }, created_at: "2026-05-01T00:00:00.000Z" } as const;
    expect(repo.enqueue({ ...task, id: "periodic-1" }).task_id).toBe("periodic-1");
    expect(repo.enqueue({ ...task, id: "periodic-2" }).task_id).toBe("periodic-1");
    expect(repo.enqueue({ ...task, id: "manual-1", payload: {} }).task_id).toBe("manual-1");
    expect(repo.enqueue({ ...task, workspace_id: "workspace-2", id: "other-workspace" }).task_id).toBe("other-workspace");
    await repo.claimAtomic("periodic-1", "worker", "2026-05-02T00:00:00.000Z");
    expect(repo.enqueue({ ...task, id: "periodic-3" }).task_id).toBe("periodic-1");
    await repo.completeWithEvents("periodic-1", { status: "completed", completed_at: "2026-05-02T00:01:00.000Z" },
      [], "worker", "workspace-1");
    expect(repo.enqueue({ ...task, id: "periodic-4" }).task_id).toBe("periodic-4");
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
              `agent-target-${claimerIndex + 1}`,
              "workspace-race"
            );
          }
        })
      )
    );

    const rows = listGardenTasks(database);
    expect(rows.filter((row) => row.status === "completed")).toHaveLength(100);
    expect(rows.filter((row) => row.status === "claimed")).toHaveLength(0);
    expect(new Set(rows.filter((row) => row.status === "completed").map((row) => row.id)).size).toBe(100);

    const completionEvents = (await eventLogRepo.queryByType(
      GardenEventType.SOUL_GARDEN_TASK_COMPLETED
    )).events;
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
    await expect(eventLogRepo.queryByType(GardenEventType.SOUL_GARDEN_TASK_CLAIM_RECLAIMED)).resolves.toEqual({
      truncated: false,
      events: [
      expect.objectContaining({
        entity_id: "task-stale-claim",
        caused_by: "garden-task-repo-test",
        payload_json: expect.objectContaining({
          previous_claimed_by: "agent-target-a",
          stale_after_ms: 5 * 60 * 1000
        })
      })
      ]
    });
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
        "agent-target-a",
        "workspace-cas"
      )
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(getGardenTask(database, "task-claimant-cas")).toMatchObject({
      status: "claimed",
      claimed_by: "agent-target-b"
    });
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
    await expect(
      repo.claimAtomic("task-failed", "agent-target-failed", "2026-05-07T00:00:01.000Z")
    ).resolves.toBe("claimed");

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
      "agent-target-failed",
      "workspace-failed"
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

  // invariant: equal identity/payload reuses the unique key; a mismatched
  // payload on the same id is conflict, not a silent overwrite.
  it("coalesces equal duplicate enqueue and conflicts on mismatched payload", () => {
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
    expect(repo.enqueue(baseInput).task_id).toBe("task-duplicate");
    expect(repo.enqueue(baseInput).task_id).toBe("task-duplicate");
    expect(repo.peekPending(GardenRole.JANITOR, "workspace-a", 8)).toHaveLength(1);

    let captured: unknown;
    try {
      repo.enqueue({
        ...baseInput,
        payload: { ...baseInput.payload, target_object_refs: ["memory-other"] }
      });
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeDefined();
    expect((captured as { readonly code?: unknown }).code).toBe("CONFLICT");
  });
});
