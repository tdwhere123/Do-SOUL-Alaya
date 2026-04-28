import {
  GARDEN_ROLE_TIER_MAP,
  GardenTier,
  type GardenBacklogQueueDepthByTier,
  type GardenBacklogSnapshot,
  type GardenBacklogWarningTransition,
  Phase4AEventType,
  parsePhase4AEventPayload,
  type GardenRoleValue,
  type GardenTaskDescriptor,
  type GardenTaskResult,
  type GardenTierValue,
  type HealthJournalRecordPort
} from "@do-what/protocol";
import {
  evaluateBacklogPressure,
  type BacklogPressureThresholds
} from "./backlog-telemetry.js";

const TIER_ORDER: Record<GardenTierValue, number> = {
  tier_0: 0,
  tier_1: 1,
  tier_2: 2
};

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
  private readonly queue: GardenTaskDescriptor[] = [];
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
    private readonly healthJournal: HealthJournalRecordPort | null = null
  ) {
    this.coolingPeriodMs = config.coolingPeriodMs ?? 86_400_000;
    this.now = config.now ?? (() => new Date().toISOString());
    this.warn = config.warn ?? ((message, meta) => console.warn(message, meta));
    this.backlogWarningThresholds = config.backlogWarningThresholds ?? null;
  }

  public enqueue(descriptor: GardenTaskDescriptor): void {
    this.queue.push(descriptor);
    this.queue.sort(compareTasks);
    this.updateBacklogTelemetry(this.now());
  }

  /**
   * Returns the next dispatchable task for the role, or null when the queue is empty,
   * all remaining eligible work is still cooling, or this dispatch pass rejects a
   * higher-priority tier violation and stops there.
   */
  public async dispatchNext(role: GardenRoleValue): Promise<GardenTaskDescriptor | null> {
    const roleTier = GARDEN_ROLE_TIER_MAP[role];
    const nowIso = this.now();
    this.pruneExpiredCoolingEntries(nowIso);

    for (let index = 0; index < this.queue.length; index += 1) {
      const task = this.queue.at(index);
      if (task === undefined) {
        continue;
      }

      // Tier violations are intentionally fail-fast for the current dispatch pass:
      // reject and remove the highest-priority invalid task, then let the caller retry.
      if (TIER_ORDER[task.required_tier] > TIER_ORDER[roleTier]) {
        const nextQueue = removeQueueIndex(this.queue, index);
        await this.appendTierViolationEvent(task, roleTier, nowIso);
        this.replaceQueue(nextQueue, nowIso);
        await this.recordTierViolationHealthJournal(task, roleTier);
        return null;
      }

      // Cooling is intentionally Tier 1 only per the Phase 4A-1 brief.
      if (task.required_tier === GardenTier.TIER_1 && this.isCooling(task, nowIso)) {
        continue;
      }

      const nextQueue = removeQueueIndex(this.queue, index);
      await this.eventLog.append({
        event_type: Phase4AEventType.SOUL_GARDEN_TASK_DISPATCHED,
        entity_type: "garden_task",
        entity_id: task.task_id,
        workspace_id: task.workspace_id,
        run_id: task.run_id,
        payload: parsePhase4AEventPayload(Phase4AEventType.SOUL_GARDEN_TASK_DISPATCHED, {
          task_id: task.task_id,
          task_kind: task.task_kind,
          role,
          tier: roleTier,
          workspace_id: task.workspace_id,
          run_id: task.run_id,
          occurred_at: nowIso
        })
      });
      this.replaceQueue(nextQueue, nowIso);
      return task;
    }

    return null;
  }

  public async reportCompletion(result: GardenTaskResult): Promise<void> {
    const nowIso = this.now();

    await this.eventLog.append({
      event_type: Phase4AEventType.SOUL_GARDEN_TASK_COMPLETED,
      entity_type: "garden_task",
      entity_id: result.task_id,
      workspace_id: result.workspace_id,
      run_id: null,
      payload: parsePhase4AEventPayload(Phase4AEventType.SOUL_GARDEN_TASK_COMPLETED, {
        task_id: result.task_id,
        task_kind: result.task_kind,
        role: result.role,
        tier: result.tier,
        success: result.success,
        objects_affected: result.objects_affected,
        workspace_id: result.workspace_id,
        occurred_at: nowIso
      })
    });

    if (result.success && result.tier === GardenTier.TIER_1) {
      this.pruneExpiredCoolingEntries(nowIso);
      for (const ref of result.objects_affected) {
        this.coolingMap.set(buildCoolingKey(result.task_kind, ref), nowIso);
      }
    }
  }

  public get queueDepth(): number {
    return this.queue.length;
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
      queueDepthTotal: this.queue.length,
      thresholds: this.backlogWarningThresholds
    });

    if (transition === "none") {
      return;
    }

    this.warningArmed = transition === "arm";
    this.pendingBacklogWarningTransitions.push({
      transition_id: this.nextBacklogWarningTransitionId,
      transition,
      snapshot: this.buildBacklogSnapshot(observedAt)
    });
    this.nextBacklogWarningTransitionId += 1;
  }

  private replaceQueue(nextQueue: readonly GardenTaskDescriptor[], observedAt: string): void {
    this.queue.splice(0, this.queue.length, ...nextQueue);
    this.updateBacklogTelemetry(observedAt);
  }

  private buildBacklogSnapshot(observedAt: string): GardenBacklogSnapshot {
    return {
      workspace_id: null,
      observed_at: observedAt,
      queue_depth_total: this.queue.length,
      queue_depth_by_tier: this.countQueueDepthByTier(),
      in_flight_total: 0,
      warning_active: this.warningArmed
    };
  }

  private countQueueDepthByTier(): GardenBacklogQueueDepthByTier {
    const counts: Record<GardenTierValue, number> = {
      tier_0: 0,
      tier_1: 0,
      tier_2: 0
    };

    for (const task of this.queue) {
      counts[task.required_tier] += 1;
    }

    return counts;
  }

  private async appendTierViolationEvent(
    task: GardenTaskDescriptor,
    roleTier: GardenTierValue,
    occurredAt: string
  ): Promise<void> {
    await this.eventLog.append({
      event_type: Phase4AEventType.SOUL_GARDEN_TIER_VIOLATION_REJECTED,
      entity_type: "garden_task",
      entity_id: task.task_id,
      workspace_id: task.workspace_id,
      run_id: task.run_id,
      payload: parsePhase4AEventPayload(Phase4AEventType.SOUL_GARDEN_TIER_VIOLATION_REJECTED, {
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

function removeQueueIndex(
  queue: readonly GardenTaskDescriptor[],
  index: number
): readonly GardenTaskDescriptor[] {
  return [...queue.slice(0, index), ...queue.slice(index + 1)];
}
