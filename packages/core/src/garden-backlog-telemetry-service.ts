import {
  GardenBacklogThresholdsSchema,
  PhaseCExtensionEventType,
  parsePhaseCExtensionEventPayload,
  type EventLogEntry,
  type GardenBacklogSnapshot,
  type GardenBacklogThresholds,
  type GardenBacklogWarningTransition,
  type HealthJournalRecordPort
} from "@do-soul/alaya-protocol";
import { SYSTEM_ACTOR, resolveSystemWorkspaceId } from "./shared/actors.js";
import { getNextRevision } from "./shared/event-utils.js";
import type { RuntimeNotifier } from "./event-publisher.js";

const GARDEN_BACKLOG_ENTITY_TYPE = "garden_backlog";
const GARDEN_BACKLOG_ENTITY_ID = "global";
const DEFAULT_STOP_TIMEOUT_MS = 10_000;
const STOP_RETRY_BACKOFF_MS = 1;

export interface GardenBacklogTelemetrySchedulerPort {
  getBacklogSnapshot(): GardenBacklogSnapshot;
  peekBacklogWarningTransition(): Readonly<{
    readonly transition_id: number;
    readonly transition: GardenBacklogWarningTransition;
    readonly snapshot: GardenBacklogSnapshot;
  }> | null;
  peekLastBacklogWarningTransitionId(): number | null;
  acknowledgeBacklogWarningTransition(transitionId: number): boolean;
}

export interface GardenBacklogTelemetryEventLogPort {
  append(entry: Omit<EventLogEntry, "event_id" | "created_at">): Promise<EventLogEntry>;
  queryByEntity(entityType: string, entityId: string): Promise<readonly EventLogEntry[]>;
}

export interface GardenBacklogTelemetryWarnPort {
  (message: string, meta: Record<string, unknown>): void;
}

export interface GardenBacklogTelemetryServiceDependencies {
  readonly scheduler: GardenBacklogTelemetrySchedulerPort;
  readonly eventLogRepo: GardenBacklogTelemetryEventLogPort;
  readonly runtimeNotifier?: Pick<RuntimeNotifier, "notifyEntry">;
  readonly healthJournal?: HealthJournalRecordPort;
  readonly thresholds: GardenBacklogThresholds;
  readonly stopTimeoutMs?: number | null;
  readonly defaultWorkspaceId?: string;
  readonly warn?: GardenBacklogTelemetryWarnPort;
}

export type GardenBacklogTelemetryStopResult = "drained" | "timed_out";

export class GardenBacklogTelemetryService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private snapshotRunner: RunnerHandle | null = null;
  private captureRunner: RunnerHandle | null = null;
  private snapshotRequestedVersion = 0;
  private snapshotProcessedVersion = 0;
  private captureRequestedVersion = 0;
  private captureProcessedVersion = 0;
  private snapshotRunnerGeneration = 0;
  private captureRunnerGeneration = 0;
  private acceptingOperations = true;
  private drainBoundaryFrozen = false;
  private stopTimedOut = false;
  private finalDrainBoundaryTransitionId: number | null = null;
  private readonly thresholds: GardenBacklogThresholds;
  private readonly stopTimeoutMs: number | null;
  private readonly systemWorkspaceId: string;

  public constructor(private readonly deps: GardenBacklogTelemetryServiceDependencies) {
    this.thresholds = GardenBacklogThresholdsSchema.parse(deps.thresholds);
    this.stopTimeoutMs = normalizeStopTimeoutMs(deps.stopTimeoutMs);
    this.systemWorkspaceId = resolveSystemWorkspaceId(deps.defaultWorkspaceId);
  }

  public getSnapshot(): GardenBacklogSnapshot {
    return this.deps.scheduler.getBacklogSnapshot();
  }

  public start(): void {
    if (this.stopTimedOut) {
      throw new Error("garden backlog telemetry service cannot restart after a timed-out stop");
    }

    this.acceptingOperations = true;
    this.drainBoundaryFrozen = false;
    this.finalDrainBoundaryTransitionId = null;
    if (this.timer !== null) {
      return;
    }

    this.timer = setInterval(() => {
      if (!this.acceptingOperations) {
        return;
      }

      this.snapshotRequestedVersion += 1;

      if (this.deps.scheduler.peekBacklogWarningTransition() !== null) {
        this.captureRequestedVersion += 1;
      }

      void this.ensureCaptureRunner();
      void this.ensureSnapshotRunner();
    }, this.thresholds.snapshot_interval_ms);
    this.timer.unref?.();
  }

  public async stop(): Promise<GardenBacklogTelemetryStopResult> {
    if (this.stopTimedOut) {
      return "timed_out";
    }

    this.acceptingOperations = false;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const pendingTransition = this.deps.scheduler.peekBacklogWarningTransition();
    if (!this.drainBoundaryFrozen) {
      this.finalDrainBoundaryTransitionId = this.deps.scheduler.peekLastBacklogWarningTransitionId();
      this.drainBoundaryFrozen = true;
    }

    if (pendingTransition !== null) {
      this.captureRequestedVersion += 1;
    }

    const drainPromise = Promise.all([
      this.ensureCaptureRunner(),
      this.ensureSnapshotRunner()
    ]).then(() => undefined);

    if (this.stopTimeoutMs === null) {
      await drainPromise;
      return "drained";
    }

    const completed = await raceWithTimeout(
      drainPromise.then(() => true),
      this.stopTimeoutMs
    );

    if (!completed) {
      this.stopTimedOut = true;
      this.invalidateTimedOutRunners();
      this.warn("garden backlog telemetry stop timed out", {
        timeout_ms: this.stopTimeoutMs,
        snapshot_requests_pending: this.snapshotRequestedVersion - this.snapshotProcessedVersion,
        capture_requests_pending: this.captureRequestedVersion - this.captureProcessedVersion
      });
      return "timed_out";
    }

    return "drained";
  }

  public async capture(): Promise<void> {
    if (!this.acceptingOperations) {
      return;
    }

    this.captureRequestedVersion += 1;
    await this.ensureCaptureRunner();
  }

  private hasPendingSnapshotOperations(): boolean {
    return this.snapshotProcessedVersion < this.snapshotRequestedVersion;
  }

  private hasPendingCaptureOperations(): boolean {
    return this.captureProcessedVersion < this.captureRequestedVersion;
  }

  private ensureSnapshotRunner(): Promise<void> {
    if (this.snapshotRunner !== null) {
      return this.snapshotRunner.promise;
    }

    if (!this.hasPendingSnapshotOperations()) {
      return Promise.resolve();
    }

    const generation = this.snapshotRunnerGeneration;
    const promise = this.runPendingSnapshots(generation).finally(async () => {
      if (this.snapshotRunner?.generation === generation) {
        this.snapshotRunner = null;
      }

      if (generation !== this.snapshotRunnerGeneration) {
        return;
      }

      if (this.hasPendingSnapshotOperations()) {
        await this.ensureSnapshotRunner();
      }
    });
    this.snapshotRunner = { generation, promise };

    return promise;
  }

  private ensureCaptureRunner(): Promise<void> {
    if (this.captureRunner !== null) {
      return this.captureRunner.promise;
    }

    if (!this.hasPendingCaptureOperations()) {
      return Promise.resolve();
    }

    const generation = this.captureRunnerGeneration;
    const promise = this.runPendingCaptures(generation).finally(async () => {
      if (this.captureRunner?.generation === generation) {
        this.captureRunner = null;
      }

      if (generation !== this.captureRunnerGeneration) {
        return;
      }

      if (this.hasPendingCaptureOperations()) {
        await this.ensureCaptureRunner();
      }
    });
    this.captureRunner = { generation, promise };

    return promise;
  }

  private async runPendingSnapshots(generation: number): Promise<void> {
    while (this.hasPendingSnapshotOperations()) {
      if (generation !== this.snapshotRunnerGeneration) {
        return;
      }

      const requestedSnapshotVersion = this.snapshotRequestedVersion;
      await this.publishSnapshotSafely(generation);
      if (generation !== this.snapshotRunnerGeneration) {
        return;
      }
      this.snapshotProcessedVersion = requestedSnapshotVersion;
    }
  }

  private async runPendingCaptures(generation: number): Promise<void> {
    while (this.hasPendingCaptureOperations()) {
      if (generation !== this.captureRunnerGeneration) {
        return;
      }

      if (this.hasPendingStopBoundaryTransitions()) {
        const requestedCaptureVersion = this.captureRequestedVersion;
        await this.publishWarningTransitionsSafely(generation);
        if (generation !== this.captureRunnerGeneration) {
          return;
        }

        if (this.hasPendingStopBoundaryTransitions()) {
          await delay(STOP_RETRY_BACKOFF_MS);
          if (generation !== this.captureRunnerGeneration) {
            return;
          }
          continue;
        }

        this.captureProcessedVersion = requestedCaptureVersion;
        continue;
      }

      const requestedCaptureVersion = this.captureRequestedVersion;
      await this.publishWarningTransitionsSafely(generation);
      if (generation !== this.captureRunnerGeneration) {
        return;
      }
      this.captureProcessedVersion = requestedCaptureVersion;
    }
  }

  private hasPendingStopBoundaryTransitions(): boolean {
    if (
      this.acceptingOperations ||
      !this.drainBoundaryFrozen ||
      this.finalDrainBoundaryTransitionId === null
    ) {
      return false;
    }

    const signal = this.deps.scheduler.peekBacklogWarningTransition();
    return signal !== null && signal.transition_id <= this.finalDrainBoundaryTransitionId;
  }

  private async publishSnapshotSafely(generation: number): Promise<void> {
    const snapshot = this.getSnapshot();
    const payload = {
      ...snapshot,
      workspace_id: this.systemWorkspaceId,
      run_id: null
    } as const;

    let entry: EventLogEntry;
    try {
      entry = await this.appendEvent(
        PhaseCExtensionEventType.GARDEN_BACKLOG_TELEMETRY_SNAPSHOT,
        payload
      );
    } catch (error) {
      this.warn("garden backlog snapshot publish failed", {
        error: toErrorMessage(error)
      });
      return;
    }

    if (generation !== this.snapshotRunnerGeneration) {
      return;
    }

    void this.notifySnapshotBestEffort(entry);
  }

  private async publishWarningTransitionsSafely(generation: number): Promise<void> {
    while (true) {
      const signal = this.deps.scheduler.peekBacklogWarningTransition();

      if (signal === null) {
        return;
      }

      if (!this.acceptingOperations) {
        if (
          this.finalDrainBoundaryTransitionId === null ||
          signal.transition_id > this.finalDrainBoundaryTransitionId
        ) {
          return;
        }
      }

      const eventPayload = {
        ...signal.snapshot,
        workspace_id: this.systemWorkspaceId,
        run_id: null,
        warning_queue_depth: this.thresholds.warning_queue_depth,
        warning_rearm_depth: this.thresholds.warning_rearm_depth,
        transition: signal.transition
      } as const;
      const journalDetailPayload = {
        ...signal.snapshot,
        workspace_id: this.systemWorkspaceId,
        run_id: null,
        warning_queue_depth: this.thresholds.warning_queue_depth,
        warning_rearm_depth: this.thresholds.warning_rearm_depth,
        transition: signal.transition
      } as const;

      let entry: EventLogEntry;
      try {
        entry = await this.appendEvent(
          PhaseCExtensionEventType.GARDEN_BACKLOG_WARNING,
          eventPayload
        );
      } catch (error) {
        this.warn("garden backlog warning event publish failed", {
          transition: signal.transition,
          error: toErrorMessage(error)
        });
        return;
      }

      if (generation !== this.captureRunnerGeneration) {
        return;
      }

      const acknowledged = this.deps.scheduler.acknowledgeBacklogWarningTransition(
        signal.transition_id
      );

      if (!acknowledged) {
        this.warn("garden backlog warning acknowledgement skipped", {
          transition: signal.transition,
          transition_id: signal.transition_id
        });
        return;
      }

      if (generation !== this.captureRunnerGeneration) {
        return;
      }

      void this.finishWarningSideEffectsBestEffort({
        entry,
        detailPayload: journalDetailPayload,
        generation,
        queueDepthTotal: signal.snapshot.queue_depth_total,
        transition: signal.transition
      });
    }
  }

  private async appendEvent(
    eventType:
      | typeof PhaseCExtensionEventType.GARDEN_BACKLOG_TELEMETRY_SNAPSHOT
      | typeof PhaseCExtensionEventType.GARDEN_BACKLOG_WARNING,
    payload: Record<string, unknown>
  ): Promise<EventLogEntry> {
    const revision = await getNextRevision(
      this.deps.eventLogRepo,
      GARDEN_BACKLOG_ENTITY_TYPE,
      GARDEN_BACKLOG_ENTITY_ID
    );
    return await this.deps.eventLogRepo.append({
      event_type: eventType,
      entity_type: GARDEN_BACKLOG_ENTITY_TYPE,
      entity_id: GARDEN_BACKLOG_ENTITY_ID,
      workspace_id: this.systemWorkspaceId,
      run_id: null,
      caused_by: SYSTEM_ACTOR,
      revision,
      payload_json: parsePhaseCExtensionEventPayload(eventType, payload)
    });
  }

  private async notifyEntry(entry: EventLogEntry): Promise<void> {
    await this.deps.runtimeNotifier?.notifyEntry(entry);
  }

  private warn(message: string, meta: Record<string, unknown>): void {
    this.deps.warn?.(message, meta);
  }

  private invalidateTimedOutRunners(): void {
    this.snapshotRunnerGeneration += 1;
    this.captureRunnerGeneration += 1;
    this.snapshotRunner = null;
    this.captureRunner = null;
  }

  private async notifySnapshotBestEffort(entry: EventLogEntry): Promise<void> {
    try {
      await this.notifyEntry(entry);
    } catch (error) {
      this.warn("garden backlog snapshot notify failed", {
        error: toErrorMessage(error)
      });
    }
  }

  private async finishWarningSideEffectsBestEffort(args: {
    readonly detailPayload: Record<string, unknown>;
    readonly entry: EventLogEntry;
    readonly generation: number;
    readonly queueDepthTotal: number;
    readonly transition: GardenBacklogWarningTransition;
  }): Promise<void> {
    try {
      await this.notifyEntry(args.entry);
    } catch (error) {
      this.warn("garden backlog warning notify failed", {
        transition: args.transition,
        error: toErrorMessage(error)
      });
    }

    if (args.generation !== this.captureRunnerGeneration) {
      return;
    }

    try {
      await this.deps.healthJournal?.record({
        event_kind: "garden_backlog",
        workspace_id: this.systemWorkspaceId,
        run_id: null,
        summary: `Garden backlog warning ${args.transition} at depth ${args.queueDepthTotal}`,
        detail_json: args.detailPayload
      });
    } catch (error) {
      this.warn("garden backlog warning journal record failed", {
        transition: args.transition,
        error: toErrorMessage(error)
      });
    }
  }
}

interface RunnerHandle {
  readonly generation: number;
  readonly promise: Promise<void>;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeStopTimeoutMs(timeoutMs: number | null | undefined): number | null {
  if (timeoutMs === null) {
    return null;
  }

  if (timeoutMs === undefined) {
    return DEFAULT_STOP_TIMEOUT_MS;
  }

  return Number.isFinite(timeoutMs) && timeoutMs >= 0 ? timeoutMs : DEFAULT_STOP_TIMEOUT_MS;
}

async function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | false> {
  let timeout: ReturnType<typeof setTimeout> | null = null;

  try {
    return await Promise.race([
      promise,
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
        timeout.unref?.();
      })
    ]);
  } finally {
    if (timeout !== null) {
      clearTimeout(timeout);
    }
  }
}

async function delay(timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, timeoutMs);
    timeout.unref?.();
  });
}
