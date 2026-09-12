import { describe, expect, it } from "vitest";
import {
  GardenRole,
  GardenTaskKind,
  GardenTier,
  type EventLogEntry,
  type GardenTaskDescriptor,
  type GardenTaskResult
} from "@do-soul/alaya-protocol";
import { GardenScheduler } from "@do-soul/alaya-soul";
import { initDatabase, SqliteGardenTaskRepo } from "@do-soul/alaya-storage";

function createEventPublisher() {
  return {
    async appendManyWithMutation<T>(
      events: readonly Omit<EventLogEntry, "event_id" | "created_at" | "revision">[],
      mutate: (entries: readonly EventLogEntry[]) => T
    ): Promise<T> {
      return mutate(
        events.map((event, index) => ({
          ...event,
          event_id: `event-${index + 1}`,
          created_at: "2026-05-05T12:00:00.000Z",
          revision: index + 1
        }))
      );
    }
  };
}

describe("GardenScheduler with SqliteGardenTaskRepo", () => {
  it("persists a real tick as claimed then completed SQL rows", async () => {
    const database = initDatabase({ filename: ":memory:" });
    try {
      const gardenTaskRepo = new SqliteGardenTaskRepo(database.connection, createEventPublisher());
      const scheduler = new GardenScheduler(
        {
          append: async () => undefined,
          appendManyAtomic: async () => undefined
        },
        { now: () => "2026-05-05T12:00:00.000Z" },
        null,
        gardenTaskRepo
      );
      const task: GardenTaskDescriptor = {
        task_id: "task-ttl-1",
        task_kind: GardenTaskKind.TTL_CLEANUP,
        required_tier: GardenTier.TIER_0,
        workspace_id: "workspace-1",
        run_id: null,
        target_object_refs: ["memory-1"],
        priority: 10,
        created_at: "2026-05-05T12:00:00.000Z"
      };

      scheduler.enqueue(task);
      const pending = database.connection
        .prepare("SELECT status, claimed_by FROM garden_tasks WHERE id = ?")
        .get(task.task_id) as { readonly status: string; readonly claimed_by: string | null };
      expect(pending).toEqual({ status: "pending", claimed_by: null });

      const dispatched = await scheduler.dispatchNext(GardenRole.JANITOR);
      expect(dispatched?.task_id).toBe(task.task_id);
      const claimed = database.connection
        .prepare("SELECT status, claimed_by FROM garden_tasks WHERE id = ?")
        .get(task.task_id) as { readonly status: string; readonly claimed_by: string | null };
      expect(claimed).toEqual({ status: "claimed", claimed_by: "in-process" });

      const result: GardenTaskResult = {
        task_id: task.task_id,
        task_kind: task.task_kind,
        role: GardenRole.JANITOR,
        tier: GardenTier.TIER_0,
        workspace_id: task.workspace_id,
        success: true,
        objects_affected: [],
        audit_entries: [],
        error_message: null,
        completed_at: "2026-05-05T12:01:00.000Z"
      };
      await scheduler.reportCompletion(result);
      const completed = database.connection
        .prepare("SELECT status, claimed_by, completed_at FROM garden_tasks WHERE id = ?")
        .get(task.task_id) as {
        readonly status: string;
        readonly claimed_by: string | null;
        readonly completed_at: string | null;
      };
      expect(completed.status).toBe("completed");
      expect(completed.completed_at).toBe("2026-05-05T12:01:00.000Z");
    } finally {
      database.close();
    }
  });
});
