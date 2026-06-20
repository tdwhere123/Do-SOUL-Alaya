import { vi } from "vitest";
import {
  GardenRole,
  GardenTaskKind,
  GardenTier,
  type GardenTaskDescriptor,
  type GardenTaskResult
} from "@do-soul/alaya-protocol";
import { GardenScheduler, InMemoryGardenTaskRepo } from "../../garden/scheduler.js";

export function createScheduler(
  config: {
    readonly coolingPeriodMs?: number;
    readonly now?: () => string;
    readonly backlogWarningThresholds?: {
      readonly warning_queue_depth: number;
      readonly warning_rearm_depth: number;
    };
  } = {}
) {
  const eventLog = {
    append: vi.fn(async () => undefined)
  };
  const healthJournal = {
    record: vi.fn(async () => undefined)
  };

  return {
    eventLog,
    healthJournal,
    scheduler: new GardenScheduler(eventLog, config, healthJournal)
  };
}

export function createTask(overrides: Partial<GardenTaskDescriptor> = {}): GardenTaskDescriptor {
  return {
    task_id: "task-1",
    task_kind: GardenTaskKind.TTL_CLEANUP,
    required_tier: GardenTier.TIER_0,
    workspace_id: "workspace-1",
    run_id: null,
    target_object_refs: ["memory-1"],
    priority: 10,
    created_at: "2026-03-27T00:00:00.000Z",
    ...overrides
  };
}

export function createResult(overrides: Partial<GardenTaskResult> = {}): GardenTaskResult {
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
    completed_at: "2026-03-27T00:00:00.000Z",
    ...overrides
  };
}

export function enqueueVisibleTierViolation(
  repo: InMemoryGardenTaskRepo,
  overrides: Partial<GardenTaskDescriptor> = {}
): void {
  const descriptor = createTask(overrides);
  repo.enqueue({
    id: descriptor.task_id,
    workspace_id: descriptor.workspace_id,
    role: GardenRole.JANITOR,
    kind: descriptor.task_kind,
    payload: descriptor,
    created_at: descriptor.created_at
  });
}

export function readCoolingMap(scheduler: GardenScheduler): Map<string, string> {
  return (scheduler as unknown as { coolingMap: Map<string, string> }).coolingMap;
}
