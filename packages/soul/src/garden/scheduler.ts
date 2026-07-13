import {
  GARDEN_ROLE_PERMISSIONS,
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
import { buildGardenCompletionEventPayload } from "./events/completion-payload.js";
import {
  quarantineInvalidTask,
  readDispatchTask
} from "./dispatch/invalid-task-quarantine.js";
import { buildTaskFailureCompletionEvent } from "./dispatch/task-failure-completion-event.js";
import {
  buildCoolingKey,
  countByStatus,
  gardenTaskRoutingError,
  parseIsoTimestampMs,
  roleForTier,
  taskKindAllowedAtTier,
  tierForRole,
  TIER_ORDER
} from "./scheduler-helpers.js";
import type {
  GardenBacklogWarningTransitionSignal,
  GardenSchedulerConfig,
  GardenSchedulerEventLogPort,
  GardenTaskBacklogCount,
  GardenTaskEventInput,
  GardenTaskRepoPort,
  GardenTaskRow
} from "./scheduler-types.js";

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
const IN_PROCESS_GARDEN_TASK_KINDS: ReadonlySet<GardenTaskDescriptor["task_kind"]> =
  new Set<GardenTaskDescriptor["task_kind"]>(
    Object.values(GARDEN_ROLE_PERMISSIONS).flatMap(
      (permission) => permission.allowed_task_kinds
    )
  );

interface DispatchOptions {
  readonly matchesTaskKind: (taskKind: GardenTaskDescriptor["task_kind"]) => boolean;
  readonly rejectTierViolations: boolean;
  readonly workspaceId?: string;
}

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
    eventLog: GardenSchedulerEventLogPort,
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
    if (!taskKindAllowedAtTier(descriptor.task_kind, descriptor.required_tier)) {
      throw new Error(
        `Garden task kind ${descriptor.task_kind} is not allowed at ${descriptor.required_tier}.`
      );
    }
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
      matchesTaskKind: (taskKind) => allowedTaskKinds.has(taskKind),
      rejectTierViolations: false,
      workspaceId
    });
  }

  private async dispatchNextInternal(
    role: GardenRoleValue,
    options: DispatchOptions
  ): Promise<GardenTaskDescriptor | null> {
    const roleTier = GARDEN_ROLE_TIER_MAP[role];
    const nowIso = this.now();
    this.pruneExpiredCoolingEntries(nowIso);

    const candidates = this.taskRepo.peekPending(role, options.workspaceId, Math.max(1, this.queueDepth));

    for (const candidate of candidates) {
      if (!IN_PROCESS_GARDEN_TASK_KINDS.has(candidate.kind)) continue;
      if (!options.matchesTaskKind(candidate.kind)) continue;
      const task = await this.readDispatchCandidate(candidate, nowIso);
      if (task === null) continue;

      const routingError = gardenTaskRoutingError(candidate, task, role);
      if (routingError !== null && !options.rejectTierViolations) {
        await this.quarantineInvalidTask(candidate, routingError, nowIso);
        continue;
      }
      if (TIER_ORDER[task.required_tier] > TIER_ORDER[roleTier]) {
        if (!options.rejectTierViolations) {
          continue;
        }
        if (await this.rejectTierViolation(candidate, task, role, roleTier, nowIso)) {
          return null;
        }
        continue;
      }
      if (routingError !== null) {
        await this.quarantineInvalidTask(candidate, routingError, nowIso);
        continue;
      }

      // invariant: only Tier 1 work cools between repeated object-level passes.
      if (task.required_tier === GardenTier.TIER_1 && this.isCooling(task, nowIso)) {
        continue;
      }
      if (!(await this.claimForDispatch(task, role, roleTier, nowIso))) {
        continue;
      }
      return task;
    }

    return null;
  }

  private async readDispatchCandidate(
    candidate: GardenTaskRow,
    nowIso: string
  ): Promise<GardenTaskDescriptor | null> {
    return await readDispatchTask(candidate, nowIso, {
      taskRepo: this.taskRepo,
      onQuarantined: () => this.updateBacklogTelemetry(nowIso),
      warn: this.warn
    });
  }

  private async quarantineInvalidTask(
    candidate: GardenTaskRow,
    reason: string,
    nowIso: string
  ): Promise<void> {
    await quarantineInvalidTask(candidate, reason, nowIso, {
      taskRepo: this.taskRepo,
      onQuarantined: () => this.updateBacklogTelemetry(nowIso),
      warn: this.warn
    });
  }

  private async rejectTierViolation(
    candidate: GardenTaskRow,
    task: GardenTaskDescriptor,
    role: GardenRoleValue,
    roleTier: GardenTierValue,
    nowIso: string
  ): Promise<boolean> {
    const failureReason = `Tier violation: ${role} cannot dispatch ${task.required_tier}`;
    const rejected = await this.taskRepo.failPendingWithCompletionEvent(
      candidate.id,
      nowIso,
      failureReason,
      buildTaskFailureCompletionEvent(candidate, nowIso),
      [this.buildTierViolationEvent(task, roleTier, nowIso)]
    );
    if (!rejected) return false;
    this.updateBacklogTelemetry(nowIso);
    await this.recordTierViolationHealthJournal(task, roleTier);
    return true;
  }

  private async claimForDispatch(
    task: GardenTaskDescriptor,
    role: GardenRoleValue,
    roleTier: GardenTierValue,
    nowIso: string
  ): Promise<boolean> {
    const claimResult = await this.taskRepo.claimAtomicWithEvents(
      task.task_id,
      IN_PROCESS_GARDEN_CLAIMANT,
      nowIso,
      [this.buildDispatchedEvent(task, role, roleTier, nowIso)]
    );
    if (claimResult !== "claimed") {
      return false;
    }
    this.updateBacklogTelemetry(nowIso);
    return true;
  }

  private buildDispatchedEvent(
    task: GardenTaskDescriptor,
    role: GardenRoleValue,
    roleTier: GardenTierValue,
    nowIso: string
  ): GardenTaskEventInput {
    return {
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
          payload_json: buildGardenCompletionEventPayload(result, nowIso)
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

  private buildTierViolationEvent(
    task: GardenTaskDescriptor,
    roleTier: GardenTierValue,
    occurredAt: string
  ): GardenTaskEventInput {
    return {
      event_type: GardenEventType.SOUL_GARDEN_TIER_VIOLATION_REJECTED,
      entity_type: "garden_task",
      entity_id: task.task_id,
      workspace_id: task.workspace_id,
      run_id: task.run_id,
      caused_by: "garden-scheduler",
      payload_json: parseGardenEventPayload(GardenEventType.SOUL_GARDEN_TIER_VIOLATION_REJECTED, {
        task_id: task.task_id,
        task_kind: task.task_kind,
        required_tier: task.required_tier,
        role_tier: roleTier,
        workspace_id: task.workspace_id,
        occurred_at: occurredAt
      })
    };
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
