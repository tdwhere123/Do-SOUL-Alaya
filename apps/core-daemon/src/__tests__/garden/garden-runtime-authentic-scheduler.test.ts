import { describe, expect, it } from "vitest";
import {
  GardenEventType,
  GardenRole,
  GardenTaskKind,
  GardenTier,
  type EventLogEntry,
  type GardenTaskDescriptor,
  type GardenTaskResult
} from "@do-soul/alaya-protocol";
import { GardenScheduler } from "@do-soul/alaya-soul";
import { initDatabase, SqliteGardenTaskRepo } from "@do-soul/alaya-storage";
import { createGardenRuntime } from "../../garden/runtime/runtime.js";
import { createRuntimeInput } from "./runtime-fixture.js";

describe("createGardenRuntime with a real GardenScheduler", () => {
  it("persists a garden_tasks row after the background pass", async () => {
    const database = initDatabase({ filename: ":memory:" });
    try {
      const runtime = createGardenRuntime(
        createRuntimeInput({
          databaseConnection: database.connection
        })
      );
      await runtime.runBackgroundPass();
      const rows = database.connection.prepare("SELECT id FROM garden_tasks").all() as readonly {
        readonly id: string;
      }[];
      expect(rows.length).toBeGreaterThan(0);
    } finally {
      database.close();
    }
  });

  it("persists a path-plasticity task and a completion event with SqliteGardenTaskRepo", async () => {
    const database = initDatabase({ filename: ":memory:" });
    try {
      const events: EventLogEntry[] = [];
      const gardenTaskRepo = new SqliteGardenTaskRepo(database.connection, {
        async appendManyWithMutation<T>(
          inputs: readonly Omit<EventLogEntry, "event_id" | "created_at" | "revision">[],
          mutate: (entries: readonly EventLogEntry[]) => T
        ): Promise<T> {
          const entries = inputs.map((event, index) => ({
            ...event,
            event_id: `event-${events.length + index + 1}`,
            created_at: "2026-05-05T12:00:00.000Z",
            revision: events.length + index + 1
          }));
          events.push(...entries);
          return mutate(entries);
        }
      });
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
        task_id: "task-plasticity-1",
        task_kind: GardenTaskKind.PATH_PLASTICITY_UPDATE,
        required_tier: GardenTier.TIER_2,
        workspace_id: "workspace-1",
        run_id: null,
        target_object_refs: ["path-1"],
        priority: 10,
        created_at: "2026-05-05T12:00:00.000Z"
      };
      scheduler.enqueue(task);
      const pending = database.connection
        .prepare("SELECT status FROM garden_tasks WHERE id = ?")
        .get(task.task_id) as { readonly status: string };
      expect(pending.status).toBe("pending");

      const dispatched = await scheduler.dispatchNext(GardenRole.LIBRARIAN);
      expect(dispatched?.task_id).toBe(task.task_id);
      const claimed = database.connection
        .prepare("SELECT status FROM garden_tasks WHERE id = ?")
        .get(task.task_id) as { readonly status: string };
      expect(claimed.status).toBe("claimed");

      const result: GardenTaskResult = {
        task_id: task.task_id,
        task_kind: task.task_kind,
        role: GardenRole.LIBRARIAN,
        tier: GardenTier.TIER_2,
        workspace_id: task.workspace_id,
        success: true,
        objects_affected: ["path-1"],
        audit_entries: [],
        error_message: null,
        completed_at: "2026-05-05T12:01:00.000Z"
      };
      await scheduler.reportCompletion(result);
      const completed = database.connection
        .prepare("SELECT status, completed_at FROM garden_tasks WHERE id = ?")
        .get(task.task_id) as { readonly status: string; readonly completed_at: string | null };
      expect(completed.status).toBe("completed");
      expect(completed.completed_at).toBe("2026-05-05T12:01:00.000Z");
      expect(events.some((event) => event.event_type === GardenEventType.SOUL_GARDEN_TASK_COMPLETED))
        .toBe(true);
    } finally {
      database.close();
    }
  });
});
