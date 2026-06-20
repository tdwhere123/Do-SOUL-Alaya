import {
  GardenTaskDescriptorSchema,
  type GardenRoleValue,
  type GardenTaskDescriptor,
  type GardenTaskKindValue
} from "@do-soul/alaya-protocol";
import {
  canRolePeekPending,
  compareTasks
} from "./scheduler-helpers.js";
import type {
  GardenSchedulerEventLogPort,
  GardenTaskBacklogCount,
  GardenTaskClaimResult,
  GardenTaskEventInput,
  GardenTaskRepoPort,
  GardenTaskRow,
  GardenTaskStatus
} from "./scheduler-types.js";

interface InMemoryGardenTaskRow extends GardenTaskRow {
  readonly descriptor: GardenTaskDescriptor;
}

/** Default in-process queue used when callers do not provide a GardenTaskRepoPort. */
export class InMemoryGardenTaskRepo implements GardenTaskRepoPort {
  private readonly rows: InMemoryGardenTaskRow[] = [];

  public constructor(private readonly eventLog: GardenSchedulerEventLogPort) {}

  public enqueue(input: {
    readonly id?: string;
    readonly workspace_id: string;
    readonly role: GardenRoleValue;
    readonly kind: GardenTaskKindValue;
    readonly payload: unknown;
    readonly created_at?: string;
  }): { readonly task_id: string } {
    const descriptor = GardenTaskDescriptorSchema.parse(input.payload);
    const taskId = input.id ?? `garden-task-${this.rows.length + 1}`;
    const createdAt = input.created_at ?? new Date().toISOString();
    this.rows.push({
      id: taskId,
      workspace_id: input.workspace_id,
      role: input.role,
      kind: input.kind,
      payload: descriptor,
      status: "pending",
      claimed_by: null,
      claimed_at: null,
      created_at: createdAt,
      completed_at: null,
      attempt_count: 0,
      last_error_text: null,
      descriptor
    });
    this.rows.sort((left, right) => compareTasks(left.descriptor, right.descriptor));
    return { task_id: taskId };
  }

  public peekPending(
    role: GardenRoleValue,
    workspace_id?: string,
    limit = 10
  ): readonly GardenTaskRow[] {
    return this.rows
      .filter((row) => row.status === "pending")
      .filter((row) => canRolePeekPending(role, row.role))
      .filter((row) => workspace_id === undefined || row.workspace_id === workspace_id)
      .slice(0, limit);
  }

  public findById(taskId: string): GardenTaskRow | null {
    const row = this.rows.find((candidate) => candidate.id === taskId);
    return row === undefined ? null : { ...row };
  }

  public claimAtomic(
    taskId: string,
    claimedBy: string,
    claimedAt: string
  ): GardenTaskClaimResult {
    const row = this.rows.find((candidate) => candidate.id === taskId);
    if (row === undefined || row.status !== "pending") {
      return "already-claimed";
    }
    replaceRow(this.rows, row, {
      ...row,
      status: "claimed",
      claimed_by: claimedBy,
      claimed_at: claimedAt,
      attempt_count: row.attempt_count + 1
    });
    return "claimed";
  }

  public async claimAtomicWithEvents(
    taskId: string,
    claimedBy: string,
    claimedAt: string,
    dispatchedEvents: readonly GardenTaskEventInput[]
  ): Promise<GardenTaskClaimResult> {
    const snapshot = this.rows.find((candidate) => candidate.id === taskId);
    if (snapshot === undefined) {
      return "already-claimed";
    }
    const preClaimState = { ...snapshot };
    const result = this.claimAtomic(taskId, claimedBy, claimedAt);
    if (result !== "claimed") {
      return result;
    }
    try {
      for (const event of dispatchedEvents) {
        await this.appendTaskEvent(event);
      }
    } catch (error) {
      const current = this.rows.find((candidate) => candidate.id === taskId);
      if (current !== undefined) {
        replaceRow(this.rows, current, preClaimState);
        this.rows.sort((left, right) => compareTasks(left.descriptor, right.descriptor));
      }
      throw error;
    }
    return "claimed";
  }

  public async completeWithEvents(
    taskId: string,
    result: {
      readonly status: Extract<GardenTaskStatus, "completed" | "failed">;
      readonly completed_at: string;
      readonly last_error_text?: string;
    },
    events: readonly GardenTaskEventInput[],
    claimedBy: string
  ): Promise<void> {
    for (const event of events) {
      await this.appendTaskEvent(event);
    }

    const row = this.rows.find((candidate) => candidate.id === taskId);
    if (row === undefined || (row.status !== "pending" && row.status !== "claimed")) {
      return;
    }
    if (row.claimed_by !== claimedBy) {
      throw new Error(`Garden task ${taskId} is not claimed by the expected worker.`);
    }
    replaceRow(this.rows, row, {
      ...row,
      status: result.status,
      completed_at: result.completed_at,
      last_error_text: result.last_error_text ?? null
    });
  }

  public peekAbandonedClaims(now: string, staleAfterMs: number): readonly GardenTaskRow[] {
    const threshold = Date.parse(now) - staleAfterMs;
    return this.rows
      .filter((row) => row.status === "claimed" && row.claimed_at !== null)
      .filter((row) => Date.parse(row.claimed_at!) < threshold)
      .map((row) => ({ ...row }));
  }

  public async gcAbandonedClaims(
    reclaims: readonly {
      readonly task_id: string;
      readonly claimed_by: string;
      readonly claimed_at: string;
      readonly event: GardenTaskEventInput;
    }[]
  ): Promise<number> {
    const rowsToReclaim = this.collectRowsToReclaim(reclaims);
    let reclaimed = 0;
    for (const [index, reclaim] of reclaims.entries()) {
      await this.appendTaskEvent(reclaim.event);
      const row = rowsToReclaim[index]!;
      replaceRow(this.rows, row, {
        ...row,
        status: "pending",
        claimed_by: null,
        claimed_at: null
      });
      reclaimed += 1;
    }
    return reclaimed;
  }

  public countBacklog(workspace_id?: string): readonly GardenTaskBacklogCount[] {
    const counts = new Map<string, GardenTaskBacklogCount>();
    for (const row of this.rows) {
      if (row.status !== "pending" && row.status !== "claimed") {
        continue;
      }
      if (workspace_id !== undefined && row.workspace_id !== workspace_id) {
        continue;
      }
      const key = `${row.role}:${row.status}`;
      const current = counts.get(key);
      counts.set(key, {
        role: row.role,
        status: row.status,
        count: (current?.count ?? 0) + 1
      });
    }
    return [...counts.values()];
  }

  public releaseClaim(taskId: string, claimedBy: string): boolean {
    const row = this.rows.find((candidate) => candidate.id === taskId);
    if (row === undefined || row.status !== "claimed" || row.claimed_by !== claimedBy) {
      return false;
    }
    replaceRow(this.rows, row, {
      ...row,
      status: "pending",
      claimed_by: null,
      claimed_at: null
    });
    this.rows.sort((left, right) => compareTasks(left.descriptor, right.descriptor));
    return true;
  }

  private collectRowsToReclaim(
    reclaims: readonly {
      readonly task_id: string;
      readonly claimed_by: string;
      readonly claimed_at: string;
    }[]
  ): InMemoryGardenTaskRow[] {
    return reclaims.map((reclaim) => {
      const row = this.rows.find((candidate) => candidate.id === reclaim.task_id);
      if (
        row === undefined ||
        row.status !== "claimed" ||
        row.claimed_by !== reclaim.claimed_by ||
        row.claimed_at !== reclaim.claimed_at
      ) {
        throw new Error(`Garden task ${reclaim.task_id} claim changed and cannot be reclaimed.`);
      }
      return row;
    });
  }

  private async appendTaskEvent(event: GardenTaskEventInput): Promise<void> {
    await this.eventLog.append({
      event_type: event.event_type,
      entity_type: event.entity_type,
      entity_id: event.entity_id,
      workspace_id: event.workspace_id,
      run_id: event.run_id,
      payload: event.payload_json
    });
  }
}

function replaceRow(
  rows: InMemoryGardenTaskRow[],
  oldRow: InMemoryGardenTaskRow,
  newRow: InMemoryGardenTaskRow
): void {
  const index = rows.indexOf(oldRow);
  if (index >= 0) {
    rows[index] = newRow;
  }
}
