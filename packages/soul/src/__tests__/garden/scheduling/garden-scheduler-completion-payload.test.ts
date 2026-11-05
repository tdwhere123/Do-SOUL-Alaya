import { describe, expect, it, vi } from "vitest";
import {
  BoundedJsonObjectSchema,
  GardenEventType,
  GardenRole,
  GardenTaskKind,
  GardenTier
} from "@do-soul/alaya-protocol";
import { GardenScheduler } from "../../../garden/scheduling/scheduler.js";
import { createResult, createTask } from "./garden-scheduler-fixtures.js";

interface AppendedEvent {
  readonly event_type: string;
  readonly payload: Record<string, unknown>;
}

function createBoundedEventLog() {
  const events: AppendedEvent[] = [];
  const append = vi.fn(async (event: AppendedEvent) => {
    BoundedJsonObjectSchema.parse(event.payload);
    events.push(event);
  });
  return { append, events };
}

function createUuidLikeObjectIds(count: number): readonly string[] {
  return Array.from(
    { length: count },
    (_, index) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`
  );
}

describe("GardenScheduler completion event payloads", () => {
  it.each([
    { outcome: "completed", success: true },
    { outcome: "skipped", success: true },
    { outcome: "failed", success: false }
  ] as const)("preserves measured $outcome with compatibility success=$success", async ({ outcome, success }) => {
    const eventLog = createBoundedEventLog();
    const scheduler = new GardenScheduler(eventLog);
    scheduler.enqueue(createTask());
    await scheduler.dispatchNext(GardenRole.JANITOR);

    await scheduler.reportCompletion(createResult({ outcome, success }));

    const completions = eventLog.events.filter(event => event.event_type === GardenEventType.SOUL_GARDEN_TASK_COMPLETED);
    expect(completions).toHaveLength(1);
    expect(completions[0]!.payload).toMatchObject({ outcome, success });
    expect(scheduler.queueDepth).toBe(0);
  });

  it.each([
    { outcome: "completed", success: false },
    { outcome: "skipped", success: false },
    { outcome: "failed", success: true }
  ] as const)("rejects $outcome with contradictory success=$success before completing the claim", async ({ outcome, success }) => {
    const eventLog = createBoundedEventLog();
    const scheduler = new GardenScheduler(eventLog);
    scheduler.enqueue(createTask());
    await scheduler.dispatchNext(GardenRole.JANITOR);
    const eventsBefore = eventLog.events.length;

    await expect(scheduler.reportCompletion(createResult({ outcome, success }))).rejects.toThrow(/conflicts/);

    expect(eventLog.events).toHaveLength(eventsBefore);
    expect(await scheduler.releaseInProcessClaim("task-1")).toBe(true);
    expect(scheduler.queueDepth).toBe(1);
  });

  it.each([true, false])("does not infer an unmeasured outcome from legacy success=%s", async success => {
    const eventLog = createBoundedEventLog();
    const scheduler = new GardenScheduler(eventLog);

    await scheduler.reportCompletion(createResult({ success }));

    expect(eventLog.events).toHaveLength(1);
    expect(eventLog.events[0]!.payload.success).toBe(success);
    expect(eventLog.events[0]!.payload).not.toHaveProperty("outcome");
  });

  it("bounds a large completion event while retaining full tier-1 cooling state", async () => {
    const eventLog = createBoundedEventLog();
    const scheduler = new GardenScheduler(eventLog, {
      coolingPeriodMs: 60_000,
      now: () => "2026-07-10T12:00:00.000Z"
    });
    const objectIds = createUuidLikeObjectIds(600);
    scheduler.enqueue(
      createTask({
        task_id: "large-completion-task",
        task_kind: GardenTaskKind.GREEN_MAINTENANCE,
        required_tier: GardenTier.TIER_1,
        target_object_refs: [objectIds[0]!]
      })
    );
    await expect(scheduler.dispatchNext(GardenRole.AUDITOR)).resolves.toMatchObject({
      task_id: "large-completion-task"
    });

    await scheduler.reportCompletion(
      createResult({
        task_id: "large-completion-task",
        task_kind: GardenTaskKind.GREEN_MAINTENANCE,
        role: GardenRole.AUDITOR,
        tier: GardenTier.TIER_1,
        objects_affected: objectIds
      })
    );

    const completionEvents = eventLog.events.filter(
      (event) => event.event_type === GardenEventType.SOUL_GARDEN_TASK_COMPLETED
    );
    expect(completionEvents).toHaveLength(1);
    const payload = completionEvents[0]!.payload;
    const prefix = payload.objects_affected as readonly string[];
    expect(JSON.stringify(payload).length).toBeLessThanOrEqual(16_384);
    expect(prefix).toEqual(objectIds.slice(0, prefix.length));
    expect(prefix.length).toBeLessThan(objectIds.length);
    expect(payload.objects_affected_total_count).toBe(600);
    expect(payload.objects_affected_sha256).toBe(
      "e2607f053c56cc67422d3a5dffbbfd997b811024ffea9bc85046d13b8557ca94"
    );
    expect(
      BoundedJsonObjectSchema.safeParse({
        ...payload,
        objects_affected: objectIds.slice(0, prefix.length + 1)
      }).success
    ).toBe(false);

    scheduler.enqueue(
      createTask({
        task_id: "tail-cooling-witness",
        task_kind: GardenTaskKind.GREEN_MAINTENANCE,
        required_tier: GardenTier.TIER_1,
        target_object_refs: [objectIds.at(-1)!]
      })
    );
    await expect(scheduler.dispatchNext(GardenRole.AUDITOR)).resolves.toBeNull();
  });

  it("preserves the legacy payload shape for a bounded completion event", async () => {
    const eventLog = createBoundedEventLog();
    const scheduler = new GardenScheduler(eventLog, {
      now: () => "2026-07-10T12:00:00.000Z"
    });

    await scheduler.reportCompletion(
      createResult({
        objects_affected: ["memory-1", "memory-2"]
      })
    );

    expect(eventLog.events).toEqual([
      {
        event_type: GardenEventType.SOUL_GARDEN_TASK_COMPLETED,
        entity_type: "garden_task",
        entity_id: "task-1",
        workspace_id: "workspace-1",
        run_id: null,
        payload: {
          task_id: "task-1",
          task_kind: GardenTaskKind.TTL_CLEANUP,
          role: GardenRole.JANITOR,
          tier: GardenTier.TIER_0,
          success: true,
          objects_affected: ["memory-1", "memory-2"],
          workspace_id: "workspace-1",
          occurred_at: "2026-07-10T12:00:00.000Z"
        }
      }
    ]);
  });
});
