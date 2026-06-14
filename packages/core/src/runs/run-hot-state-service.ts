import {
  EngineStatus,
  WorkspaceRunEventType,
  StreamingEventType,
  type EventLogEntry,
  type WorkspaceRunEvent,
  type Run,
  type RunHotState
} from "@do-soul/alaya-protocol";

export interface RunHotStateRunRepoPort {
  getById(id: string): Promise<Run | null>;
}

export interface RunHotStateEventLogRepoPort {
  queryByRun(runId: string): Promise<readonly EventLogEntry[]>;
}

export interface RunHotStateServiceDependencies {
  readonly runRepo: RunHotStateRunRepoPort;
  readonly eventLogRepo: RunHotStateEventLogRepoPort;
  readonly maxSnapshots?: number;
}

const DEFAULT_RUN_HOT_STATE_SNAPSHOT_CAP = 10_000;

export class RunHotStateService {
  private readonly snapshots = new Map<string, RunHotState>();
  private readonly maxSnapshots: number;

  public constructor(private readonly dependencies: RunHotStateServiceDependencies) {
    this.maxSnapshots = parsePositiveIntegerCap(
      dependencies.maxSnapshots,
      DEFAULT_RUN_HOT_STATE_SNAPSHOT_CAP,
      "maxSnapshots"
    );
  }

  public async getSnapshot(runId: string): Promise<RunHotState | null> {
    const existing = this.snapshots.get(runId);

    if (existing !== undefined) {
      this.cacheSnapshot(runId, existing);
      return existing;
    }

    const run = await this.dependencies.runRepo.getById(runId);

    if (run === null) {
      return null;
    }

    const snapshot = await snapshotFromRun(run, this.dependencies.eventLogRepo);
    this.cacheSnapshot(runId, snapshot);
    return snapshot;
  }

  public async apply(event: WorkspaceRunEvent): Promise<void> {
    if (event.run_id === null) {
      return;
    }

    switch (event.event_type) {
      case "run.created": {
        this.cacheSnapshot(event.run_id, {
          run_id: event.run_id,
          run_state: "idle",
          active_surface_id: null,
          last_message_at: null,
          engine_status: EngineStatus.IDLE,
          updated_at: event.created_at
        });
        return;
      }
      case "run.deleted": {
        this.snapshots.delete(event.run_id);
        return;
      }
      case "run.message.appended": {
        const current = await this.getOrBuild(event.run_id, event.created_at);
        this.cacheSnapshot(event.run_id, {
          ...current,
          run_state: "active",
          engine_status: EngineStatus.STREAMING,
          last_message_at: event.created_at,
          updated_at: event.created_at
        });
        return;
      }
      case "engine.response.received": {
        const current = await this.getOrBuild(event.run_id, event.created_at);
        this.cacheSnapshot(event.run_id, {
          ...current,
          run_state: "active",
          engine_status: EngineStatus.IDLE,
          last_message_at: event.created_at,
          updated_at: event.created_at
        });
        return;
      }
      default:
        return;
    }
  }

  public async setEngineStatus(
    runId: string,
    engineStatus: EngineStatus,
    timestamp = new Date().toISOString(),
    lastMessageAt?: string | null
  ): Promise<void> {
    const current = await this.getOrBuild(runId, timestamp);
    this.cacheSnapshot(runId, {
      ...current,
      run_state: "active",
      engine_status: engineStatus,
      ...(lastMessageAt !== undefined ? { last_message_at: lastMessageAt } : {}),
      updated_at: timestamp
    });
  }

  private cacheSnapshot(runId: string, snapshot: RunHotState): void {
    this.snapshots.delete(runId);
    this.snapshots.set(runId, snapshot);
    this.pruneSnapshots();
  }

  private pruneSnapshots(): void {
    while (this.snapshots.size > this.maxSnapshots) {
      const oldestRunId = this.snapshots.keys().next().value as string | undefined;
      if (oldestRunId === undefined) {
        return;
      }
      this.snapshots.delete(oldestRunId);
    }
  }

  private async getOrBuild(runId: string, timestamp: string): Promise<RunHotState> {
    const existing = await this.getSnapshot(runId);

    if (existing !== null) {
      return existing;
    }

    return {
      run_id: runId,
      run_state: "active",
      active_surface_id: null,
      last_message_at: null,
      engine_status: EngineStatus.IDLE,
      updated_at: timestamp
    };
  }
}

function parsePositiveIntegerCap(
  value: number | undefined,
  fallback: number,
  name: string
): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isFinite(value) || value < 1) {
    throw new Error(`${name} must be a positive finite integer`);
  }
  return Math.floor(value);
}

async function snapshotFromRun(
  run: Run,
  eventLogRepo: RunHotStateEventLogRepoPort
): Promise<RunHotState> {
  const lastMessageAt = await findLastMessageAt(run.run_id, eventLogRepo);

  return {
    run_id: run.run_id,
    run_state: run.run_state,
    active_surface_id: run.current_surface_id,
    last_message_at: lastMessageAt,
    engine_status: EngineStatus.IDLE,
    updated_at: run.last_active_at
  };
}

async function findLastMessageAt(
  runId: string,
  eventLogRepo: RunHotStateEventLogRepoPort
): Promise<string | null> {
  const events = await eventLogRepo.queryByRun(runId);

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];

    if (
      event.event_type === WorkspaceRunEventType.RUN_MESSAGE_APPENDED ||
      event.event_type === WorkspaceRunEventType.ENGINE_RESPONSE_RECEIVED ||
      event.event_type === StreamingEventType.MESSAGE_COMPLETED
    ) {
      return event.created_at;
    }
  }

  return null;
}
