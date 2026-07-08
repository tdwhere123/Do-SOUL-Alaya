import {
  GARDEN_ROLE_TIER_MAP,
  GardenTier,
  type GardenBacklogQueueDepthByTier,
  type GardenBacklogSnapshot,
  GardenEventType,
  parseGardenEventPayload,
  type GardenRoleValue,
  type GardenTaskDescriptor,
  type GardenTaskResult,
  type GardenTierValue,
  type HealthJournalRecordPort
} from "@do-soul/alaya-protocol";
import {
  evaluateBacklogPressure,
  type BacklogPressureThresholds
} from "./backlog-telemetry.js";
import { InMemoryGardenTaskRepo } from "./in-memory-garden-task-repo.js";
import {
  buildCoolingKey,
  countByStatus,
  parseIsoTimestampMs,
  parseTaskDescriptorFromRow,
  roleForTier,
  tierForRole,
  TIER_ORDER
} from "./scheduler-helpers.js";
import type {
  GardenBacklogWarningTransitionSignal,
  GardenSchedulerConfig,
  GardenSchedulerEventLogPort,
  GardenTaskBacklogCount,
  GardenTaskEventInput,
  GardenTaskRepoPort} from "./scheduler-types.js";

export { InMemoryGardenTaskRepo } from "./in-memory-garden-task-repo.js";
export type {
  GardenBacklogWarningTransitionSignal,
  GardenSchedulerConfig,
  GardenSchedulerEventLogPort,
  GardenTaskBacklogCount,
  GardenTaskClaimResult,
  GardenTaskEventInput,
  GardenTaskRepoPort,
  GardenTaskRow,
  GardenTaskStatus
} from "./scheduler-types.js";

const IN_PROCESS_GARDEN_CLAIMANT = "in-process";

function defaultGardenSchedulerWarn(message: string, meta: Record<string, unknown>): void {
  process.emitWarning(message, {
    code: "ALAYA_GARDEN_SCHEDULER_WARNING",
    detail: JSON.stringify(meta)
  });
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
    this.warn = config.warn ?? defaultGardenSchedulerWarn;
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

  // workspaceId is OPTIONAL. When undefined the pending peek is workspace-wide
  // (the production background pass dispatch — unchanged kind-only fairness).
  // When set, the peek is scoped to that workspace_id so a targeted readiness
  // drain dispatches only its own workspace's same-kind tasks and never another
  // workspace's pending task of the same kind.
  // see also: apps/core-daemon/src/garden-runtime.ts runEmbeddingBackfillPass
  public async dispatchNextMatchingTaskKind(
    role: GardenRoleValue,
    taskKinds: readonly GardenTaskDescriptor["task_kind"][],
    workspaceId?: string
  ): Promise<GardenTaskDescriptor | null> {
    const allowedTaskKinds = new Set<GardenTaskDescriptor["task_kind"]>(taskKinds);
    return await this.dispatchNextInternal(role, {
      matchesTaskKind: (task) => allowedTaskKinds.has(task.task_kind),
      rejectTierViolations: false,
      workspaceId
    });
  }

  private async dispatchNextInternal(
    role: GardenRoleValue,
    options: {
      readonly matchesTaskKind: (task: GardenTaskDescriptor) => boolean;
      readonly rejectTierViolations: boolean;
      readonly workspaceId?: string;
    }
  ): Promise<GardenTaskDescriptor | null> {
    const roleTier = GARDEN_ROLE_TIER_MAP[role];
    const nowIso = this.now();
    this.pruneExpiredCoolingEntries(nowIso);

    const candidates = this.taskRepo.peekPending(role, options.workspaceId, Math.max(1, this.queueDepth));

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
          [],
          IN_PROCESS_GARDEN_CLAIMANT
        );
        this.updateBacklogTelemetry(nowIso);
        await this.recordTierViolationHealthJournal(task, roleTier);
        return null;
      }

      // invariant: only Tier 1 work cools between repeated object-level passes.
      if (task.required_tier === GardenTier.TIER_1 && this.isCooling(task, nowIso)) {
        continue;
      }

      // invariant: claim state and dispatch audit commit or roll back together.
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
      ],
      IN_PROCESS_GARDEN_CLAIMANT
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

    const nowMs = parseIsoTimestampMs(nowIso);
    const lastRunMs = parseIsoTimestampMs(lastRunAt);
    if (nowMs === null || lastRunMs === null) {
      return true;
    }

    return nowMs - lastRunMs < this.coolingPeriodMs;
  }

  private pruneExpiredCoolingEntries(nowIso: string): void {
    const nowMs = parseIsoTimestampMs(nowIso);
    if (nowMs === null) {
      return;
    }

    for (const [key, lastRunAt] of this.coolingMap.entries()) {
      const lastRunMs = parseIsoTimestampMs(lastRunAt);
      if (lastRunMs === null || nowMs - lastRunMs >= this.coolingPeriodMs) {
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
