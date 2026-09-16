import { afterEach, describe, expect, it } from "vitest";
import { GardenEventType, GardenRole, GardenTaskKind, GardenTier, parseGardenEventPayload } from "@do-soul/alaya-protocol";
import { initDatabase, type StorageDatabase } from "../../../sqlite/db.js";
import { SqliteGardenTaskRepo } from "../../../repos/garden/garden-task-repo.js";

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

describe("garden task kind counts", () => {
  it("counts failed POST_TURN_EXTRACT rows separately from pending and stale", async () => {
    const database = initDatabase({ filename: ":memory:" });
    databases.add(database);
    const repo = new SqliteGardenTaskRepo(database.connection, {
      appendManyWithMutation: async (events, mutate) =>
        mutate(events.map((event, index) => ({
          event_id: `event-${index + 1}`,
          created_at: "2026-09-16T00:00:00.000Z",
          revision: 0,
          ...event
        })))
    });
    const payload = {
      task_id: "post-turn-failed-1",
      task_kind: GardenTaskKind.POST_TURN_EXTRACT,
      required_tier: GardenTier.TIER_2,
      workspace_id: "workspace-1",
      run_id: "run-1",
      target_object_refs: [],
      priority: 20,
      created_at: "2026-09-16T00:00:00.000Z",
      turn_index: 0,
      turn_digest: { last_messages: [{ role: "user", content_excerpt: "remember this" }] }
    };
    repo.enqueue({
      id: "post-turn-failed-1",
      workspace_id: "workspace-1",
      role: GardenRole.LIBRARIAN,
      kind: GardenTaskKind.POST_TURN_EXTRACT,
      payload,
      created_at: "2026-09-16T00:00:00.000Z"
    });
    repo.enqueue({
      id: "post-turn-pending-1",
      workspace_id: "workspace-1",
      role: GardenRole.LIBRARIAN,
      kind: GardenTaskKind.POST_TURN_EXTRACT,
      payload: { ...payload, task_id: "post-turn-pending-1" },
      created_at: "2026-09-16T00:00:00.000Z"
    });
    expect(await repo.claimAtomic(
      "post-turn-failed-1",
      "in-process",
      "2026-09-16T00:00:01.000Z"
    )).toBe("claimed");
    await repo.completeWithEvents(
      "post-turn-failed-1",
      {
        status: "failed",
        completed_at: "2026-09-16T00:00:02.000Z",
        last_error_text: "provider unavailable"
      },
      [
        {
          event_type: GardenEventType.SOUL_GARDEN_TASK_COMPLETED,
          entity_type: "garden_task",
          entity_id: "post-turn-failed-1",
          workspace_id: "workspace-1",
          run_id: "run-1",
          caused_by: "garden-task-kind-count-test",
          payload_json: parseGardenEventPayload(GardenEventType.SOUL_GARDEN_TASK_COMPLETED, {
            task_id: "post-turn-failed-1",
            task_kind: GardenTaskKind.POST_TURN_EXTRACT,
            role: GardenRole.LIBRARIAN,
            tier: GardenTier.TIER_2,
            success: false,
            objects_affected: [],
            workspace_id: "workspace-1",
            occurred_at: "2026-09-16T00:00:02.000Z"
          })
        }
      ],
      "in-process"
    );

    expect(repo.countByKind(GardenTaskKind.POST_TURN_EXTRACT, "2026-09-16T00:00:00.000Z")).toEqual({
      kind: GardenTaskKind.POST_TURN_EXTRACT,
      pending: 1,
      stale: 0,
      failed: 1
    });
  });

  it("counts zero aggregates when no rows match the kind", () => {
    const database = initDatabase({ filename: ":memory:" });
    databases.add(database);
    const repo = new SqliteGardenTaskRepo(database.connection, {
      appendManyWithMutation: async (_events, mutate) => mutate([])
    });

    expect(repo.countByKind(GardenTaskKind.POST_TURN_EXTRACT, "2026-09-16T00:00:00.000Z")).toEqual({
      kind: GardenTaskKind.POST_TURN_EXTRACT,
      pending: 0,
      stale: 0,
      failed: 0
    });
  });

  it("scopes failed counts to the requested workspace", async () => {
    const { repo, failTask } = await createCountedExtractRepo();
    repo.enqueue({
      id: "post-turn-ws1",
      workspace_id: "workspace-1",
      role: GardenRole.LIBRARIAN,
      kind: GardenTaskKind.POST_TURN_EXTRACT,
      payload: extractPayload("post-turn-ws1", "workspace-1"),
      created_at: "2026-09-16T00:00:00.000Z"
    });
    await failTask("workspace-1", "post-turn-ws1");
    repo.enqueue({
      id: "post-turn-ws2",
      workspace_id: "workspace-2",
      role: GardenRole.LIBRARIAN,
      kind: GardenTaskKind.POST_TURN_EXTRACT,
      payload: extractPayload("post-turn-ws2", "workspace-2"),
      created_at: "2026-09-16T00:00:00.000Z"
    });
    await failTask("workspace-2", "post-turn-ws2");

    expect(
      repo.countByKind(GardenTaskKind.POST_TURN_EXTRACT, "2026-09-16T00:00:00.000Z", "workspace-1")
    ).toEqual({
      kind: GardenTaskKind.POST_TURN_EXTRACT,
      pending: 0,
      stale: 0,
      failed: 1
    });
  });

  it("counts failed rows only among the most recent extract tasks", async () => {
    const { repo, failTask } = await createCountedExtractRepo();
    repo.enqueue({
      id: "post-turn-old-failed",
      workspace_id: "workspace-1",
      role: GardenRole.LIBRARIAN,
      kind: GardenTaskKind.POST_TURN_EXTRACT,
      payload: extractPayload("post-turn-old-failed", "workspace-1"),
      created_at: "2026-09-16T00:00:00.000Z"
    });
    await failTask("workspace-1", "post-turn-old-failed", "2026-09-16T00:00:01.000Z");
    repo.enqueue({
      id: "post-turn-recent-pending",
      workspace_id: "workspace-1",
      role: GardenRole.LIBRARIAN,
      kind: GardenTaskKind.POST_TURN_EXTRACT,
      payload: extractPayload("post-turn-recent-pending", "workspace-1"),
      created_at: "2026-09-16T00:00:10.000Z"
    });

    expect(
      repo.countByKind(
        GardenTaskKind.POST_TURN_EXTRACT,
        "2026-09-16T00:00:00.000Z",
        "workspace-1",
        1
      )
    ).toEqual({
      kind: GardenTaskKind.POST_TURN_EXTRACT,
      pending: 1,
      stale: 0,
      failed: 0
    });
  });
});

function extractPayload(taskId: string, workspaceId: string) {
  return {
    task_id: taskId,
    task_kind: GardenTaskKind.POST_TURN_EXTRACT,
    required_tier: GardenTier.TIER_2,
    workspace_id: workspaceId,
    run_id: "run-1",
    target_object_refs: [],
    priority: 20,
    created_at: "2026-09-16T00:00:00.000Z",
    turn_index: 0,
    turn_digest: { last_messages: [{ role: "user", content_excerpt: "remember this" }] }
  };
}

async function createCountedExtractRepo(): Promise<{
  readonly repo: SqliteGardenTaskRepo;
  readonly failTask: (workspaceId: string, taskId: string, claimedAt?: string) => Promise<void>;
}> {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);
  const repo = new SqliteGardenTaskRepo(database.connection, {
    appendManyWithMutation: async (events, mutate) =>
      mutate(events.map((event, index) => ({
        event_id: `event-${index + 1}`,
        created_at: "2026-09-16T00:00:00.000Z",
        revision: 0,
        ...event
      })))
  });
  return {
    repo,
    failTask: async (workspaceId, taskId, claimedAt = "2026-09-16T00:00:01.000Z") => {
      expect(await repo.claimAtomic(taskId, "in-process", claimedAt)).toBe("claimed");
      await repo.completeWithEvents(
        taskId,
        {
          status: "failed",
          completed_at: "2026-09-16T00:00:02.000Z",
          last_error_text: "provider unavailable"
        },
        [
          {
            event_type: GardenEventType.SOUL_GARDEN_TASK_COMPLETED,
            entity_type: "garden_task",
            entity_id: taskId,
            workspace_id: workspaceId,
            run_id: "run-1",
            caused_by: "garden-task-kind-count-test",
            payload_json: parseGardenEventPayload(GardenEventType.SOUL_GARDEN_TASK_COMPLETED, {
              task_id: taskId,
              task_kind: GardenTaskKind.POST_TURN_EXTRACT,
              role: GardenRole.LIBRARIAN,
              tier: GardenTier.TIER_2,
              success: false,
              objects_affected: [],
              workspace_id: workspaceId,
              occurred_at: "2026-09-16T00:00:02.000Z"
            })
          }
        ],
        "in-process"
      );
    }
  };
}
