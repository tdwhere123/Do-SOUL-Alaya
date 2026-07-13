import type {
  EventType,
  GardenBacklogSnapshot,
  GardenBacklogWarningTransition,
  GardenRoleValue,
  GardenTaskKindValue
} from "@do-soul/alaya-protocol";
import type { BacklogPressureThresholds } from "./backlog-telemetry.js";

export interface GardenSchedulerEventInput {
  readonly event_type: string;
  readonly entity_type: string;
  readonly entity_id: string;
  readonly workspace_id: string;
  readonly run_id: string | null;
  readonly payload: Record<string, unknown>;
}

export interface GardenSchedulerEventLogPort {
  append(entry: GardenSchedulerEventInput): Promise<void>;
  // Multi-event transitions fail closed unless the port can commit the whole batch.
  appendManyAtomic?(entries: readonly GardenSchedulerEventInput[]): Promise<void>;
}

export type GardenTaskStatus = "pending" | "claimed" | "completed" | "failed";
export type GardenTaskClaimResult = "claimed" | "already-claimed";

export interface GardenTaskEventInput {
  readonly event_type: EventType;
  readonly entity_type: string;
  readonly entity_id: string;
  readonly workspace_id: string;
  readonly run_id: string | null;
  readonly caused_by: string | null;
  readonly payload_json: Record<string, unknown>;
}

export interface GardenTaskRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly role: GardenRoleValue;
  readonly kind: GardenTaskKindValue;
  readonly payload: unknown;
  readonly status: GardenTaskStatus;
  readonly claimed_by: string | null;
  readonly claimed_at: string | null;
  readonly created_at: string;
  readonly completed_at: string | null;
  readonly attempt_count: number;
  readonly last_error_text: string | null;
}

export interface GardenTaskBacklogCount {
  readonly role: GardenRoleValue;
  readonly status: Extract<GardenTaskStatus, "pending" | "claimed">;
  readonly count: number;
}

export interface GardenTaskRepoPort {
  enqueue(input: {
    readonly id?: string;
    readonly workspace_id: string;
    readonly role: GardenRoleValue;
    readonly kind: GardenTaskKindValue;
    readonly payload: unknown;
    readonly created_at?: string;
  }): { readonly task_id: string };
  peekPending(
    role: GardenRoleValue,
    workspace_id?: string,
    limit?: number
  ): readonly GardenTaskRow[];
  findById(taskId: string): GardenTaskRow | null;
  claimAtomic(
    taskId: string,
    claimedBy: string,
    claimedAt: string
  ): Promise<GardenTaskClaimResult>;
  claimAtomicWithEvents(
    taskId: string,
    claimedBy: string,
    claimedAt: string,
    dispatchedEvents: readonly GardenTaskEventInput[]
  ): Promise<GardenTaskClaimResult>;
  failPendingWithCompletionEvent(
    taskId: string,
    completedAt: string,
    lastErrorText: string,
    completionEvent: GardenTaskEventInput,
    precedingEvents?: readonly GardenTaskEventInput[]
  ): Promise<boolean>;
  completeWithEvents(
    taskId: string,
    result: {
      readonly status: "completed" | "failed";
      readonly completed_at: string;
      readonly last_error_text?: string;
    },
    events: readonly GardenTaskEventInput[],
    claimedBy: string
  ): Promise<void>;
  peekAbandonedClaims(now: string, staleAfterMs: number): readonly GardenTaskRow[];
  gcAbandonedClaims(
    reclaims: readonly {
      readonly task_id: string;
      readonly claimed_by: string;
      readonly claimed_at: string;
      readonly event: GardenTaskEventInput;
    }[]
  ): Promise<number>;
  countBacklog(workspace_id?: string): readonly GardenTaskBacklogCount[];
  releaseClaim(taskId: string, claimedBy: string): Promise<boolean>;
}

export interface GardenSchedulerConfig {
  readonly coolingPeriodMs?: number;
  readonly now?: () => string;
  readonly backlogWarningThresholds?: BacklogPressureThresholds;
  readonly warn?: (message: string, meta: Record<string, unknown>) => void;
}

export interface GardenBacklogWarningTransitionSignal {
  readonly transition_id: number;
  readonly transition: GardenBacklogWarningTransition;
  readonly snapshot: GardenBacklogSnapshot;
}
