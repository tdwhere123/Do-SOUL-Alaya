import { afterEach } from "vitest";

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

export const databases = new Set<StorageDatabase>();

export function createHarness(): Readonly<{
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

export function createTask(overrides: Partial<GardenTaskDescriptor> = {}): GardenTaskDescriptor {
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
    completed_at: "2026-05-07T00:00:01.000Z",
    ...overrides
  };
}

export function createTaskCompletedEvent(input: {
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

export function createTaskReclaimedEvent(input: {
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

export function createSchedulerEventLogPort(eventPublisher: EventPublisher): GardenSchedulerEventLogPort {
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

export interface GardenTaskDbRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly status: string;
  readonly claimed_by: string | null;
  readonly claimed_at: string | null;
  readonly completed_at: string | null;
  readonly last_error_text: string | null;
}

export function getGardenTask(database: StorageDatabase, taskId: string): GardenTaskDbRow {
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

export function listGardenTasks(database: StorageDatabase): readonly GardenTaskDbRow[] {
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

