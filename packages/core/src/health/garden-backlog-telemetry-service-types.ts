import type {
  EventLogEntry,
  GardenBacklogSnapshot,
  GardenBacklogThresholds,
  GardenBacklogWarningTransition,
  HealthJournalRecordPort
} from "@do-soul/alaya-protocol";
import type { RuntimeNotifier } from "../runtime/event-publisher.js";

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
  append(entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">): EventLogEntry | Promise<EventLogEntry>;
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

export interface RunnerHandle {
  readonly generation: number;
  readonly promise: Promise<void>;
}
