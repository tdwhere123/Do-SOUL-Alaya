import type {
  EventLogEntry,
  GardenRoleValue,
  GardenTaskKindValue
} from "@do-soul/alaya-protocol";

export type GardenTaskStatus = "pending" | "claimed" | "completed" | "failed";
export type GardenTaskClaimResult = "claimed" | "already-claimed";
export type GardenTaskEventInput = Omit<EventLogEntry, "event_id" | "created_at" | "revision">;

export interface GardenTaskEventPublisherPort {
  appendManyWithMutation<T>(
    events: readonly GardenTaskEventInput[],
    mutate: (entries: readonly EventLogEntry[]) => T
  ): Promise<T>;
}

export interface GardenTaskEnqueueInput {
  readonly id?: string;
  readonly workspace_id: string;
  readonly role: GardenRoleValue;
  readonly kind: GardenTaskKindValue;
  readonly payload: unknown;
  readonly created_at?: string;
}

export interface GardenTaskRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly role: GardenRoleValue;
  readonly kind: GardenTaskKindValue;
  readonly payload_json: string;
  readonly payload: unknown;
  readonly status: GardenTaskStatus;
  readonly claimed_by: string | null;
  readonly claimed_at: string | null;
  readonly created_at: string;
  readonly completed_at: string | null;
  readonly attempt_count: number;
  readonly last_error_text: string | null;
  readonly completion_envelope_json: string | null;
}

export interface GardenTaskBacklogCount {
  readonly role: GardenRoleValue;
  readonly status: "pending" | "claimed";
  readonly count: number;
}

export interface GardenTaskKindBacklogCount {
  readonly kind: GardenTaskKindValue;
  readonly pending: number;
  readonly stale: number;
}

export interface GardenTaskCompletionResult {
  readonly status: "completed" | "failed";
  readonly completed_at: string;
  readonly last_error_text?: string;
}

export interface GardenTaskReclaimInput {
  readonly task_id: string;
  readonly claimed_by: string;
  readonly claimed_at: string;
  readonly event: GardenTaskEventInput;
}

export interface GardenTaskExpiryInput {
  readonly task_id: string;
  readonly event: GardenTaskEventInput;
}

export interface GardenTaskRepoPort {
  enqueue(input: GardenTaskEnqueueInput): { readonly task_id: string };
  findById(taskId: string): GardenTaskRow | null;
  peekPending(
    role: GardenRoleValue,
    workspace_id?: string,
    limit?: number
  ): readonly GardenTaskRow[];
  claimAtomic(
    taskId: string,
    claimedBy: string,
    claimedAt: string,
    workspace_id?: string
  ): GardenTaskClaimResult;
  claimAtomicWithEvents(
    taskId: string,
    claimedBy: string,
    claimedAt: string,
    dispatchedEvents: readonly GardenTaskEventInput[],
    workspace_id?: string
  ): Promise<GardenTaskClaimResult>;
  beginCompletionAttempt(
    taskId: string,
    claimedBy: string,
    completionClaimedBy: string,
    claimedAt: string,
    completionEnvelopeJson?: string | null
  ): boolean;
  refreshClaim(taskId: string, claimedBy: string, claimedAt: string): boolean;
  releaseClaim(taskId: string, claimedBy: string): boolean;
  completeWithEvents(
    taskId: string,
    result: GardenTaskCompletionResult,
    events: readonly GardenTaskEventInput[],
    claimedBy: string
  ): Promise<void>;
  peekAbandonedClaims(now: string, staleAfterMs: number): readonly GardenTaskRow[];
  gcAbandonedClaims(reclaims: readonly GardenTaskReclaimInput[]): Promise<number>;
  peekExpiredUnclaimedTasks(
    kind: GardenTaskKindValue,
    expiredBeforeIso: string,
    limit: number
  ): readonly GardenTaskRow[];
  expireUnclaimedTasks(expirations: readonly GardenTaskExpiryInput[]): Promise<number>;
  countBacklog(workspace_id?: string): readonly GardenTaskBacklogCount[];
  countByKind(
    kind: GardenTaskKindValue,
    staleBeforeIso: string,
    workspace_id?: string
  ): GardenTaskKindBacklogCount;
}
