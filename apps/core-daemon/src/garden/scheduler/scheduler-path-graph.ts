import {
  GardenRole,
  GardenTier,
  HealthEventKind,
  RuntimeGovernanceEventType,
  parseRuntimeGovernanceEventPayload,
  type EventType,
  type GardenTaskDescriptor,
  type PathGraphSnapshot
} from "@do-soul/alaya-protocol";
import { PathGraphSnapshotter, reviewPathGraphSnapshotHistory } from "@do-soul/alaya-soul";
import type { CreateGardenSchedulerRuntimeSupportInput } from "./scheduler-runtime-types.js";

type PathGraphSnapshotRecord = Readonly<PathGraphSnapshot>;

const PATH_GRAPH_SNAPSHOT_INTERVAL_MS = 900_000;
const PATH_GRAPH_HISTORY_REVIEW_LIMIT = 2;
const PATH_GRAPH_SNAPSHOT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export function createPathGraphSnapshotTaskRunner(
  input: CreateGardenSchedulerRuntimeSupportInput
): (task: Readonly<GardenTaskDescriptor>) => Promise<void> {
  const pathGraphSnapshotter = createPathGraphSnapshotter(input);
  const persistSnapshot = createPathGraphSnapshotPersistence(input, pathGraphSnapshotter);
  const reviewHistory = createPathGraphHistoryReviewer(input);
  const pruneHistory = createPathGraphHistoryPruner(input);
  return async (task: Readonly<GardenTaskDescriptor>): Promise<void> =>
    await runPathGraphSnapshotTask(task, input, persistSnapshot, reviewHistory, pruneHistory);
}

function createPathGraphSnapshotter(
  input: CreateGardenSchedulerRuntimeSupportInput
): PathGraphSnapshotter {
  const pathRelationRepo = input.pathRelationRepo as typeof input.pathRelationRepo & {
    findActiveAll?: (workspaceId: string) => Promise<readonly unknown[]>;
    findActive?: (workspaceId: string) => Promise<readonly unknown[]>;
  };
  return new PathGraphSnapshotter({
    pathRelationRepo: {
      findActiveAll:
        pathRelationRepo.findActiveAll?.bind(input.pathRelationRepo) ??
        pathRelationRepo.findActive?.bind(input.pathRelationRepo)
    }
  });
}

function createPathGraphSnapshotPersistence(
  input: CreateGardenSchedulerRuntimeSupportInput,
  pathGraphSnapshotter: PathGraphSnapshotter
): (
  workspaceId: string,
  previousSnapshot: PathGraphSnapshotRecord | null
) => Promise<PathGraphSnapshotRecord> {
  return async (
    workspaceId: string,
    previousSnapshot: PathGraphSnapshotRecord | null
  ): Promise<PathGraphSnapshotRecord> => {
    const snapshot = await pathGraphSnapshotter.buildSnapshot(workspaceId, previousSnapshot);
    await input.eventPublisher.appendManyWithMutation(
      [
        {
          event_type: RuntimeGovernanceEventType.PATH_GRAPH_SNAPSHOT_CREATED as EventType,
          entity_type: "path_graph_snapshot",
          entity_id: snapshot.snapshot_id,
          workspace_id: workspaceId,
          run_id: null,
          caused_by: "garden-path-graph-snapshotter",
          payload_json: parseRuntimeGovernanceEventPayload(RuntimeGovernanceEventType.PATH_GRAPH_SNAPSHOT_CREATED, {
            snapshot_id: snapshot.snapshot_id,
            workspace_id: snapshot.workspace_id,
            total_active_paths: snapshot.total_active_paths,
            snapshot_at: snapshot.snapshot_at
          })
        }
      ],
      () => {
        input.pathGraphSnapshotRepo.create(snapshot);
      }
    );
    return snapshot;
  };
}

function createPathGraphHistoryReviewer(
  input: CreateGardenSchedulerRuntimeSupportInput
): (workspaceId: string) => Promise<void> {
  return async (workspaceId: string): Promise<void> => {
    const history = await input.pathGraphSnapshotRepo.findHistory(
      workspaceId,
      PATH_GRAPH_HISTORY_REVIEW_LIMIT
    );
    const review = reviewPathGraphSnapshotHistory(workspaceId, history);
    if (review === null) {
      return;
    }
    await input.healthJournalPort.record({
      event_kind: HealthEventKind.GARDEN_BACKLOG,
      workspace_id: workspaceId,
      run_id: null,
      summary: review.summary,
      detail_json: review.detail_json
    });
  };
}

function createPathGraphHistoryPruner(
  input: CreateGardenSchedulerRuntimeSupportInput
): (workspaceId: string, snapshotAt: string) => Promise<void> {
  return async (
    workspaceId: string,
    snapshotAt: string
  ): Promise<void> => {
    const snapshotAtMs = Date.parse(snapshotAt);
    if (!Number.isFinite(snapshotAtMs)) {
      return;
    }
    await input.pathGraphSnapshotRepo.deleteOlderThan(
      workspaceId,
      new Date(snapshotAtMs - PATH_GRAPH_SNAPSHOT_RETENTION_MS).toISOString()
    );
  };
}

async function runPathGraphSnapshotTask(
  task: Readonly<GardenTaskDescriptor>,
  input: CreateGardenSchedulerRuntimeSupportInput,
  persistSnapshot: (
    workspaceId: string,
    previousSnapshot: PathGraphSnapshotRecord | null
  ) => Promise<PathGraphSnapshotRecord>,
  reviewHistory: (workspaceId: string) => Promise<void>,
  pruneHistory: (workspaceId: string, snapshotAt: string) => Promise<void>
): Promise<void> {
  const completedAt = new Date().toISOString();
  try {
    const snapshot = await maybePersistPathGraphSnapshot(task.workspace_id, input, persistSnapshot);
    if (snapshot !== null) {
      await prunePathGraphHistory(task.workspace_id, snapshot, pruneHistory, input.warn);
      await reviewHistory(task.workspace_id);
    }
    await reportPathGraphSnapshotCompletion(input, task, completedAt, snapshot, null);
  } catch (error) {
    await reportPathGraphSnapshotCompletion(
      input,
      task,
      completedAt,
      null,
      error instanceof Error ? error.message : String(error)
    );
    throw error;
  }
}

async function maybePersistPathGraphSnapshot(
  workspaceId: string,
  input: CreateGardenSchedulerRuntimeSupportInput,
  persistSnapshot: (
    workspaceId: string,
    previousSnapshot: PathGraphSnapshotRecord | null
  ) => Promise<PathGraphSnapshotRecord>
): Promise<PathGraphSnapshotRecord | null> {
  const previousSnapshot = await input.pathGraphSnapshotRepo.findLatest(workspaceId);
  return isPathGraphSnapshotDue(previousSnapshot, Date.now())
    ? await persistSnapshot(workspaceId, previousSnapshot)
    : null;
}

async function prunePathGraphHistory(
  workspaceId: string,
  snapshot: PathGraphSnapshotRecord,
  pruneHistory: (workspaceId: string, snapshotAt: string) => Promise<void>,
  warn: (message: string, meta: Record<string, unknown>) => void
): Promise<void> {
  await pruneHistory(workspaceId, snapshot.snapshot_at).catch((error) => {
    warn("garden path graph snapshot prune failed after persistence", {
      workspaceId,
      snapshotId: snapshot.snapshot_id,
      error: error instanceof Error ? error.message : String(error)
    });
  });
}

async function reportPathGraphSnapshotCompletion(
  input: CreateGardenSchedulerRuntimeSupportInput,
  task: Readonly<GardenTaskDescriptor>,
  completedAt: string,
  snapshot: PathGraphSnapshotRecord | null,
  errorMessage: string | null
): Promise<void> {
  await input.gardenScheduler.reportCompletion({
    task_id: task.task_id,
    task_kind: task.task_kind,
    role: GardenRole.LIBRARIAN,
    tier: GardenTier.TIER_2,
    workspace_id: task.workspace_id,
    success: errorMessage === null,
    objects_affected: snapshot === null || errorMessage !== null ? [] : [snapshot.snapshot_id],
    audit_entries:
      errorMessage !== null
        ? []
        : snapshot === null
          ? ["snapshot_skipped:not_due"]
          : [snapshot.snapshot_id],
    error_message: errorMessage,
    completed_at: completedAt
  });
}

function isPathGraphSnapshotDue(
  snapshot: PathGraphSnapshotRecord | null,
  nowMs: number
): boolean {
  if (snapshot === null) {
    return true;
  }
  const snapshotAtMs = Date.parse(snapshot.snapshot_at);
  if (!Number.isFinite(snapshotAtMs)) {
    return true;
  }
  return nowMs - snapshotAtMs >= PATH_GRAPH_SNAPSHOT_INTERVAL_MS;
}
