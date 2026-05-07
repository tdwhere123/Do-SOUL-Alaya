import {
  GARDEN_ROLE_TIER_MAP,
  GardenRole,
  GardenTaskDescriptorSchema,
  GardenTier,
  type GardenBacklogQueueDepthByTier,
  type GardenBacklogSnapshot,
  type GardenBacklogWarningTransition,
  GardenEventType,
  parseGardenEventPayload,
  type GardenRoleValue,
  type GardenTaskDescriptor,
  type GardenTaskKindValue,
  type GardenTaskResult,
  type GardenTierValue,
  type EventType,
  type HealthJournalRecordPort
} from "@do-soul/alaya-protocol";
import {
  evaluateBacklogPressure,
  type BacklogPressureThresholds
} from "./backlog-telemetry.js";

const TIER_ORDER: Record<GardenTierValue, number> = {
  tier_0: 0,
  tier_1: 1,
  tier_2: 2
};
const IN_PROCESS_GARDEN_CLAIMANT = "in-process";

export interface GardenSchedulerEventLogPort {
  append(entry: {
    readonly event_type: string;
    readonly entity_type: string;
    readonly entity_id: string;
    readonly workspace_id: string;
    readonly run_id: string | null;
    readonly payload: Record<string, unknown>;
  }): Promise<void>;
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
  /**
   * Reviewer-final F1: read-only single-row lookup. Used by tests that
   * need to verify post-rollback state (e.g., that attempt_count was
   * restored to its pre-claim value, distinguishing the I3 fix from
   * the pre-fix releaseClaim-only path which left attempt_count
   * silently bumped).
   */
  findById(taskId: string): GardenTaskRow | null;
  claimAtomic(taskId: string, claimedBy: string, claimedAt: string): GardenTaskClaimResult;
  /**
   * Wave-end M6: claim a task and append the dispatched audit event(s)
   * in one storage transaction. Eliminates the prior partial-state
   * window between claimAtomic and a separate eventLog.append where a
   * daemon crash would leave a `claimed` row without a matching
   * SOUL_GARDEN_TASK_DISPATCHED event row.
   */
  claimAtomicWithEvents(
    taskId: string,
    claimedBy: string,
    claimedAt: string,
    dispatchedEvents: readonly GardenTaskEventInput[]
  ): Promise<GardenTaskClaimResult>;
  completeWithEvents(
    taskId: string,
    result: {
      readonly status: "completed" | "failed";
      readonly completed_at: string;
      readonly last_error_text?: string;
    },
    events: readonly GardenTaskEventInput[]
  ): Promise<void>;
  gcAbandonedClaims(now: string, staleAfterMs: number): number;
  countBacklog(workspace_id?: string): readonly GardenTaskBacklogCount[];
  releaseClaim(taskId: string, claimedBy: string): boolean;
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

export class GardenScheduler {
  private readonly coolingMap = new Map<string, string>();
  private readonly coolingPeriodMs: number;
  private readonly now: () => string;
  private readonly warn: (message: string, meta: Record<string, unknown>) => void;
  private readonly backlogWarningThresholds: BacklogPressureThresholds | null;
  private warningArmed = false;
  private pendingBacklogWarningTransitions: GardenBacklogWarningTransitionSignal[] = [];
  private nextBacklogWarningTransitionId = 1;

  public constructor(
    private readonly eventLog: GardenSchedulerEventLogPort,
    config: GardenSchedulerConfig = {},
    private readonly healthJournal: HealthJournalRecordPort | null = null,
    private readonly taskRepo: GardenTaskRepoPort = new InMemoryGardenTaskRepo(eventLog)
  ) {
    this.coolingPeriodMs = config.coolingPeriodMs ?? 86_400_000;
    this.now = config.now ?? (() => new Date().toISOString());
    this.warn = config.warn ?? ((message, meta) => console.warn(message, meta));
    this.backlogWarningThresholds = config.backlogWarningThresholds ?? null;
  }

  public enqueue(descriptor: GardenTaskDescriptor): void {
    this.taskRepo.enqueue({
      id: descriptor.task_id,
      workspace_id: descriptor.workspace_id,
      role: roleForTier(descriptor.required_tier),
      kind: descriptor.task_kind,
      payload: descriptor,
      created_at: descriptor.created_at
    });
    this.updateBacklogTelemetry(this.now());
  }

  /**
   * Returns the next dispatchable task for the role, or null when the queue is empty,
   * all remaining eligible work is still cooling, or this dispatch pass rejects a
   * higher-priority tier violation and stops there.
   */
  public async dispatchNext(role: GardenRoleValue): Promise<GardenTaskDescriptor | null> {
    return await this.dispatchNextInternal(role, {
      matchesTaskKind: () => true,
      rejectTierViolations: true
    });
  }

  public async dispatchNextMatchingTaskKind(
    role: GardenRoleValue,
    taskKinds: readonly GardenTaskDescriptor["task_kind"][]
  ): Promise<GardenTaskDescriptor | null> {
    const allowedTaskKinds = new Set<GardenTaskDescriptor["task_kind"]>(taskKinds);
    return await this.dispatchNextInternal(role, {
      matchesTaskKind: (task) => allowedTaskKinds.has(task.task_kind),
      rejectTierViolations: false
    });
  }

  private async dispatchNextInternal(
    role: GardenRoleValue,
    options: {
      readonly matchesTaskKind: (task: GardenTaskDescriptor) => boolean;
      readonly rejectTierViolations: boolean;
    }
  ): Promise<GardenTaskDescriptor | null> {
    const roleTier = GARDEN_ROLE_TIER_MAP[role];
    const nowIso = this.now();
    this.pruneExpiredCoolingEntries(nowIso);

    const candidates = this.taskRepo.peekPending(role, undefined, Math.max(1, this.queueDepth));

    for (const candidate of candidates) {
      const task = parseTaskDescriptorFromRow(candidate);
      if (!options.matchesTaskKind(task)) {
        continue;
      }

      // Tier violations are intentionally fail-fast for the current dispatch pass:
      // reject and remove the highest-priority invalid task, then let the caller retry.
      if (TIER_ORDER[task.required_tier] > TIER_ORDER[roleTier]) {
        if (!options.rejectTierViolations) {
          continue;
        }

        const claimResult = this.taskRepo.claimAtomic(
          task.task_id,
          IN_PROCESS_GARDEN_CLAIMANT,
          nowIso
        );
        if (claimResult !== "claimed") {
          continue;
        }

        try {
          await this.appendTierViolationEvent(task, roleTier, nowIso);
        } catch (error) {
          this.taskRepo.releaseClaim(task.task_id, IN_PROCESS_GARDEN_CLAIMANT);
          throw error;
        }

        await this.taskRepo.completeWithEvents(
          task.task_id,
          {
            status: "failed",
            completed_at: nowIso,
            last_error_text: `Tier violation: ${role} cannot dispatch ${task.required_tier}`
          },
          []
        );
        this.updateBacklogTelemetry(nowIso);
        await this.recordTierViolationHealthJournal(task, roleTier);
        return null;
      }

      // Cooling is intentionally Tier 1 only per the Phase 4A-1 brief.
      if (task.required_tier === GardenTier.TIER_1 && this.isCooling(task, nowIso)) {
        continue;
      }

      // Wave-end M6: claim AND append the dispatched event in the
      // same SQLite transaction. Pre-fix, claimAtomic committed first
      // and the event append happened in a separate tx — a daemon
      // crash between the two left a `claimed` row with no audit
      // trail (recovery only via gcAbandonedClaims). Now both
      // commit-or-roll together.
      const dispatchedEvent: GardenTaskEventInput = {
        event_type: GardenEventType.SOUL_GARDEN_TASK_DISPATCHED,
        entity_type: "garden_task",
        entity_id: task.task_id,
        workspace_id: task.workspace_id,
        run_id: task.run_id,
        caused_by: IN_PROCESS_GARDEN_CLAIMANT,
        payload_json: parseGardenEventPayload(GardenEventType.SOUL_GARDEN_TASK_DISPATCHED, {
          task_id: task.task_id,
          task_kind: task.task_kind,
          role,
          tier: roleTier,
          workspace_id: task.workspace_id,
          run_id: task.run_id,
          occurred_at: nowIso
        })
      };
      const claimResult = await this.taskRepo.claimAtomicWithEvents(
        task.task_id,
        IN_PROCESS_GARDEN_CLAIMANT,
        nowIso,
        [dispatchedEvent]
      );
      if (claimResult !== "claimed") {
        continue;
      }

      this.updateBacklogTelemetry(nowIso);
      return task;
    }

    return null;
  }

  public async reportCompletion(result: GardenTaskResult): Promise<void> {
    const nowIso = this.now();

    await this.taskRepo.completeWithEvents(
      result.task_id,
      {
        status: result.success ? "completed" : "failed",
        completed_at: result.completed_at,
        last_error_text: result.error_message ?? undefined
      },
      [
        {
          event_type: GardenEventType.SOUL_GARDEN_TASK_COMPLETED,
          entity_type: "garden_task",
          entity_id: result.task_id,
          workspace_id: result.workspace_id,
          run_id: null,
          caused_by: "garden-scheduler",
          payload_json: parseGardenEventPayload(GardenEventType.SOUL_GARDEN_TASK_COMPLETED, {
            task_id: result.task_id,
            task_kind: result.task_kind,
            role: result.role,
            tier: result.tier,
            success: result.success,
            objects_affected: result.objects_affected,
            workspace_id: result.workspace_id,
            occurred_at: nowIso
          })
        }
      ]
    );

    if (result.success && result.tier === GardenTier.TIER_1) {
      this.pruneExpiredCoolingEntries(nowIso);
      for (const ref of result.objects_affected) {
        this.coolingMap.set(buildCoolingKey(result.task_kind, ref), nowIso);
      }
    }
  }

  public get queueDepth(): number {
    return countByStatus(this.taskRepo.countBacklog(), "pending");
  }

  public getBacklogSnapshot(): GardenBacklogSnapshot {
    return this.buildBacklogSnapshot(this.now());
  }

  public peekBacklogWarningTransition(): GardenBacklogWarningTransitionSignal | null {
    return this.pendingBacklogWarningTransitions[0] ?? null;
  }

  public peekLastBacklogWarningTransitionId(): number | null {
    return (
      this.pendingBacklogWarningTransitions[this.pendingBacklogWarningTransitions.length - 1]
        ?.transition_id ?? null
    );
  }

  public acknowledgeBacklogWarningTransition(transitionId: number): boolean {
    if (this.pendingBacklogWarningTransitions[0]?.transition_id !== transitionId) {
      return false;
    }

    this.pendingBacklogWarningTransitions.shift();
    return true;
  }

  private isCooling(task: GardenTaskDescriptor, nowIso: string): boolean {
    const targetRef = task.target_object_refs[0] ?? task.workspace_id;
    const lastRunAt = this.coolingMap.get(buildCoolingKey(task.task_kind, targetRef));

    if (lastRunAt === undefined) {
      return false;
    }

    return Date.parse(nowIso) - Date.parse(lastRunAt) < this.coolingPeriodMs;
  }

  private pruneExpiredCoolingEntries(nowIso: string): void {
    const nowMs = Date.parse(nowIso);

    for (const [key, lastRunAt] of this.coolingMap.entries()) {
      const lastRunMs = Date.parse(lastRunAt);
      if (!Number.isFinite(lastRunMs) || nowMs - lastRunMs >= this.coolingPeriodMs) {
        this.coolingMap.delete(key);
      }
    }
  }

  private updateBacklogTelemetry(observedAt: string): void {
    if (this.backlogWarningThresholds === null) {
      return;
    }

    const transition = evaluateBacklogPressure({
      armed: this.warningArmed,
      queueDepthTotal: this.queueDepth,
      thresholds: this.backlogWarningThresholds
    });

    if (transition === "none") {
      return;
    }

    this.warningArmed = transition === "arm";
    const snapshot = this.buildBacklogSnapshot(observedAt);
    this.pendingBacklogWarningTransitions.push({
      transition_id: this.nextBacklogWarningTransitionId,
      transition,
      snapshot
    });
    this.nextBacklogWarningTransitionId += 1;
  }

  private buildBacklogSnapshot(observedAt: string): GardenBacklogSnapshot {
    const counts = this.taskRepo.countBacklog();
    return {
      workspace_id: null,
      observed_at: observedAt,
      queue_depth_total: countByStatus(counts, "pending"),
      queue_depth_by_tier: this.countQueueDepthByTier(counts),
      in_flight_total: countByStatus(counts, "claimed"),
      warning_active: this.warningArmed
    };
  }

  private countQueueDepthByTier(
    backlogCounts: readonly GardenTaskBacklogCount[]
  ): GardenBacklogQueueDepthByTier {
    const counts: Record<GardenTierValue, number> = {
      tier_0: 0,
      tier_1: 0,
      tier_2: 0
    };

    for (const count of backlogCounts) {
      if (count.status !== "pending") {
        continue;
      }
      counts[tierForRole(count.role)] += count.count;
    }

    return counts;
  }

  private async appendTierViolationEvent(
    task: GardenTaskDescriptor,
    roleTier: GardenTierValue,
    occurredAt: string
  ): Promise<void> {
    await this.eventLog.append({
      event_type: GardenEventType.SOUL_GARDEN_TIER_VIOLATION_REJECTED,
      entity_type: "garden_task",
      entity_id: task.task_id,
      workspace_id: task.workspace_id,
      run_id: task.run_id,
      payload: parseGardenEventPayload(GardenEventType.SOUL_GARDEN_TIER_VIOLATION_REJECTED, {
        task_id: task.task_id,
        task_kind: task.task_kind,
        required_tier: task.required_tier,
        role_tier: roleTier,
        workspace_id: task.workspace_id,
        occurred_at: occurredAt
      })
    });
  }

  private async recordTierViolationHealthJournal(
    task: GardenTaskDescriptor,
    roleTier: GardenTierValue
  ): Promise<void> {
    try {
      await this.healthJournal?.record({
        event_kind: "garden_backlog",
        workspace_id: task.workspace_id,
        run_id: task.run_id,
        summary: `Tier violation rejected task ${task.task_id}`,
        detail_json: {
          task_id: task.task_id,
          task_kind: task.task_kind,
          required_tier: task.required_tier,
          role_tier: roleTier
        }
      });
    } catch (error) {
      this.warn("[garden] tier violation health journal record failed", {
        taskId: task.task_id,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
}

function compareTasks(left: GardenTaskDescriptor, right: GardenTaskDescriptor): number {
  if (left.priority !== right.priority) {
    return right.priority - left.priority;
  }

  if (left.created_at !== right.created_at) {
    return left.created_at.localeCompare(right.created_at);
  }

  return left.task_id.localeCompare(right.task_id);
}

function buildCoolingKey(taskKind: GardenTaskDescriptor["task_kind"], targetRef: string): string {
  return `${taskKind}:${targetRef}`;
}

function parseTaskDescriptorFromRow(row: GardenTaskRow): GardenTaskDescriptor {
  return GardenTaskDescriptorSchema.parse(row.payload);
}

function roleForTier(tier: GardenTierValue): GardenRoleValue {
  switch (tier) {
    case GardenTier.TIER_0:
      return GardenRole.JANITOR;
    case GardenTier.TIER_1:
      return GardenRole.AUDITOR;
    case GardenTier.TIER_2:
      return GardenRole.LIBRARIAN;
  }
}

function tierForRole(role: GardenRoleValue): GardenTierValue {
  return GARDEN_ROLE_TIER_MAP[role];
}

function countByStatus(
  counts: readonly GardenTaskBacklogCount[],
  status: "pending" | "claimed"
): number {
  return counts
    .filter((count) => count.status === status)
    .reduce((total, count) => total + count.count, 0);
}

/**
 * Default in-process queue used when callers don't provide their own
 * GardenTaskRepoPort. Exported to enable tests that need to inspect
 * rollback state via findById (Reviewer-final F1: distinguishing
 * I3-fix from pre-fix requires reading attempt_count after a failed
 * dispatch, which the production GardenScheduler API correctly does
 * not expose).
 */
export class InMemoryGardenTaskRepo implements GardenTaskRepoPort {
  private readonly rows: GardenTaskRow[] = [];

  public constructor(private readonly eventLog: GardenSchedulerEventLogPort) {}

  public enqueue(input: {
    readonly id?: string;
    readonly workspace_id: string;
    readonly role: GardenRoleValue;
    readonly kind: GardenTaskKindValue;
    readonly payload: unknown;
    readonly created_at?: string;
  }): { readonly task_id: string } {
    const taskId = input.id ?? `garden-task-${this.rows.length + 1}`;
    const createdAt = input.created_at ?? new Date().toISOString();
    this.rows.push({
      id: taskId,
      workspace_id: input.workspace_id,
      role: input.role,
      kind: input.kind,
      payload: input.payload,
      status: "pending",
      claimed_by: null,
      claimed_at: null,
      created_at: createdAt,
      completed_at: null,
      attempt_count: 0,
      last_error_text: null
    });
    this.rows.sort((left, right) =>
      compareTasks(parseTaskDescriptorFromRow(left), parseTaskDescriptorFromRow(right))
    );
    return { task_id: taskId };
  }

  public peekPending(
    _role: GardenRoleValue,
    workspace_id?: string,
    limit = 10
  ): readonly GardenTaskRow[] {
    return this.rows
      .filter((row) => row.status === "pending")
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

  // Wave-end M6 + Codex re-review I3: in-memory impl matches the
  // SQLite-backed contract — claim and append commit-or-roll together.
  // SQLite handles this via appendManyWithMutation's tx; the in-memory
  // event log has no transaction, so we apply the rollback by hand:
  //
  // 1. Snapshot the full row state BEFORE claim (including attempt_count).
  // 2. claimAtomic. If CAS loses, return early without appending.
  // 3. Try event appends one by one.
  // 4. On any throw, restore the row from the snapshot — this reverts
  //    status, claimed_by, claimed_at AND attempt_count, which the prior
  //    naive releaseClaim left bumped (Codex re-review I3).
  //
  // We cannot undo events that already appended successfully before the
  // throw (the port has no truncate). The scheduler today only appends
  // one event per claim (SOUL_GARDEN_TASK_DISPATCHED), so the multi-event
  // partial-append window does not exist in production. If a future
  // caller passes multiple events we keep the row consistent and rely on
  // the SQLite repo for true atomicity.
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
        await this.eventLog.append({
          event_type: event.event_type,
          entity_type: event.entity_type,
          entity_id: event.entity_id,
          workspace_id: event.workspace_id,
          run_id: event.run_id,
          payload: event.payload_json
        });
      }
    } catch (error) {
      const current = this.rows.find((candidate) => candidate.id === taskId);
      if (current !== undefined) {
        replaceRow(this.rows, current, preClaimState);
        this.rows.sort((left, right) =>
          compareTasks(parseTaskDescriptorFromRow(left), parseTaskDescriptorFromRow(right))
        );
      }
      throw error;
    }
    return "claimed";
  }

  public async completeWithEvents(
    taskId: string,
    result: {
      readonly status: "completed" | "failed";
      readonly completed_at: string;
      readonly last_error_text?: string;
    },
    events: readonly GardenTaskEventInput[]
  ): Promise<void> {
    for (const event of events) {
      await this.eventLog.append({
        event_type: event.event_type,
        entity_type: event.entity_type,
        entity_id: event.entity_id,
        workspace_id: event.workspace_id,
        run_id: event.run_id,
        payload: event.payload_json
      });
    }

    const row = this.rows.find((candidate) => candidate.id === taskId);
    if (row === undefined) {
      return;
    }
    if (row.status !== "pending" && row.status !== "claimed") {
      return;
    }
    replaceRow(this.rows, row, {
      ...row,
      status: result.status,
      completed_at: result.completed_at,
      last_error_text: result.last_error_text ?? null
    });
  }

  public gcAbandonedClaims(now: string, staleAfterMs: number): number {
    const threshold = Date.parse(now) - staleAfterMs;
    let reclaimed = 0;
    for (const row of [...this.rows]) {
      if (row.status !== "claimed" || row.claimed_at === null) {
        continue;
      }
      if (Date.parse(row.claimed_at) >= threshold) {
        continue;
      }
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
      if (row.status !== "pending") {
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
    this.rows.sort((left, right) =>
      compareTasks(parseTaskDescriptorFromRow(left), parseTaskDescriptorFromRow(right))
    );
    return true;
  }
}

function replaceRow(rows: GardenTaskRow[], oldRow: GardenTaskRow, newRow: GardenTaskRow): void {
  const index = rows.indexOf(oldRow);
  if (index >= 0) {
    rows[index] = newRow;
  }
}
