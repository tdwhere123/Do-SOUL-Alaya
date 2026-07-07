import {
  type EventLogEntry,
  type KarmaEvent,
  type MemoryEntry
} from "@do-soul/alaya-protocol";

import { scheduleAuditedAsyncSideEffect } from "../runtime/async-side-effect-auditor.js";
import { CoreError } from "../shared/errors.js";

import {
  broadcastEvents,
  buildManifestationChangedEventInput,
  buildRetentionUpdatedEventInput,
  buildStateChangedEventInput
} from "./dynamics-audit-events.js";
import { determineManifestation } from "./dynamics-constants-runtime.js";
import {
  computeActivationScore,
  computeRetentionFromKarma,
  resolveRetentionState
} from "./dynamics-scoring.js";
import {
  deriveKarmaFieldUpdates,
  hasScoreChanged,
  parseKarmaEventInput,
  type DynamicsEventLogInput,
  type DynamicsServiceEventLogRepoPort,
  type DynamicsServiceGreenPort,
  type DynamicsServiceKarmaEventRepoPort,
  type DynamicsServiceMemoryRepoPort,
  type DynamicsServiceRuntimeNotifier,
  type KarmaTransitionComputation,
  type KarmaTransitionContext,
  type KarmaTransitionEventPublisherPort
} from "./dynamics-service-ports.js";

export interface KarmaTransitionEngineDependencies {
  readonly memoryRepo: DynamicsServiceMemoryRepoPort;
  readonly karmaEventRepo: DynamicsServiceKarmaEventRepoPort;
  readonly eventLogRepo: DynamicsServiceEventLogRepoPort;
  readonly runtimeNotifier: DynamicsServiceRuntimeNotifier;
  readonly greenService?: DynamicsServiceGreenPort;
  readonly eventPublisher?: KarmaTransitionEventPublisherPort;
  readonly now: () => string;
}

export interface KarmaTransitionPlan {
  readonly parsedEvent: Readonly<KarmaEvent>;
  readonly memory: Readonly<MemoryEntry>;
  readonly karmaSum: number;
  readonly transition: KarmaTransitionComputation;
  readonly context?: KarmaTransitionContext;
}

export interface KarmaTransitionApplyResult {
  readonly updated: Readonly<MemoryEntry>;
  readonly revived: boolean;
}

export interface KarmaTransitionTransactionMutation {
  readonly updated: Readonly<MemoryEntry>;
  readonly events: readonly DynamicsEventLogInput[];
}

export class KarmaTransitionEngine {
  public constructor(private readonly deps: KarmaTransitionEngineDependencies) {}

  public async processKarmaEvent(
    event: KarmaEvent,
    context?: KarmaTransitionContext
  ): Promise<void> {
    const parsedEvent = parseKarmaEventInput(event);
    if (this.canRunAtomicTransition()) {
      await this.processKarmaTransitionAtomic(parsedEvent, context);
      return;
    }
    // test-only: production wiring is guaranteed atomic by requireAtomicKarmaTransition
    // (daemon); this ordering-safe, non-atomic path serves fakes lacking the sync ports.
    const plan = await this.computeKarmaTransitionPlanFromParsed(parsedEvent, context);
    const applied = await this.applyKarmaTransitionPlan(plan);
    const events = await this.auditKarmaTransition(applied, plan);
    await this.notifyKarmaTransition(applied.updated, events);
  }

  // invariant (§7 + §31): the karma write and its EventLog audit rows commit in
  // one SQLite transaction, so a failed append rolls the DB mutation back with
  // no half-commit window. Engaged only when the injected repos expose the
  // synchronous ports the transaction callback needs.
  private canRunAtomicTransition(): boolean {
    return (
      this.deps.eventPublisher !== undefined &&
      this.canRunSynchronousTransition()
    );
  }

  private async processKarmaTransitionAtomic(
    parsedEvent: Readonly<KarmaEvent>,
    context?: KarmaTransitionContext
  ): Promise<void> {
    const eventPublisher = this.deps.eventPublisher;
    if (eventPublisher === undefined) {
      throw new CoreError("CONFLICT", "Atomic karma transition requires an event publisher.", {
        subCode: "PORT_UNAVAILABLE"
      });
    }
    let appliedResult: KarmaTransitionApplyResult | undefined;
    await eventPublisher.mutateThenAppendMany(() => {
      const plan = this.computeKarmaTransitionPlanSync(parsedEvent, context);
      const preApplyResult: KarmaTransitionApplyResult = {
        updated: {
          ...plan.memory,
          activation_score: plan.transition.activationScore,
          retention_score: plan.transition.retentionScore,
          manifestation_state: plan.transition.manifestationState,
          retention_state: plan.transition.retentionState,
          ...plan.transition.fieldUpdates
        },
        revived: false
      };
      const events = this.buildKarmaAuditInputs(preApplyResult, plan);
      return {
        events,
        result: undefined,
        apply: () => {
          appliedResult = this.applyKarmaTransitionPlanSync(plan);
          return this.buildKarmaRevivalAuditInputs(appliedResult, plan);
        }
      };
    });
    if (appliedResult) {
      this.scheduleGreenReevaluation(appliedResult.updated);
    }
  }

  public processKarmaEventInCurrentTransaction(
    event: KarmaEvent,
    context?: KarmaTransitionContext
  ): KarmaTransitionTransactionMutation {
    if (!this.canRunSynchronousTransition()) {
      throw new CoreError("CONFLICT", "In-transaction karma transition requires synchronous repo ports.", {
        subCode: "PORT_UNAVAILABLE"
      });
    }
    const parsedEvent = parseKarmaEventInput(event);
    const plan = this.computeKarmaTransitionPlanSync(parsedEvent, context);
    const applied = this.applyKarmaTransitionPlanSync(plan);
    return {
      updated: applied.updated,
      events: this.buildKarmaAuditInputs(applied, plan)
    };
  }

  public scheduleKarmaTransactionSideEffects(
    mutation: Readonly<KarmaTransitionTransactionMutation>
  ): void {
    this.scheduleGreenReevaluation(mutation.updated);
  }

  private canRunSynchronousTransition(): boolean {
    const memoryRepo = this.deps.memoryRepo;
    return (
      this.deps.karmaEventRepo.createSync !== undefined &&
      this.deps.karmaEventRepo.sumByObjectIdSync !== undefined &&
      memoryRepo.findByIdSync !== undefined &&
      memoryRepo.updateDynamicsSync !== undefined &&
      memoryRepo.reviveDormantSync !== undefined
    );
  }

  private applyKarmaTransitionPlanSync(plan: KarmaTransitionPlan): KarmaTransitionApplyResult {
    const { memoryRepo, karmaEventRepo } = this.deps;
    if (karmaEventRepo.createSync === undefined || memoryRepo.updateDynamicsSync === undefined) {
      throw new CoreError("CONFLICT", "Atomic karma transition requires synchronous repo ports.", {
        subCode: "PORT_UNAVAILABLE"
      });
    }
    karmaEventRepo.createSync(plan.parsedEvent);
    const updated = memoryRepo.updateDynamicsSync(
      plan.memory.object_id,
      {
        activation_score: plan.transition.activationScore,
        retention_score: plan.transition.retentionScore,
        manifestation_state: plan.transition.manifestationState,
        retention_state: plan.transition.retentionState,
        ...plan.transition.fieldUpdates
      },
      plan.transition.now
    );
    const revived = this.reviveDormantMemoryFromKarmaSync(plan.memory, plan.parsedEvent, plan.transition.now);
    return { updated, revived };
  }

  public async computeKarmaTransitionPlan(
    event: KarmaEvent,
    context?: KarmaTransitionContext
  ): Promise<KarmaTransitionPlan> {
    return this.computeKarmaTransitionPlanFromParsed(parseKarmaEventInput(event), context);
  }

  private async computeKarmaTransitionPlanFromParsed(
    parsedEvent: Readonly<KarmaEvent>,
    context?: KarmaTransitionContext
  ): Promise<KarmaTransitionPlan> {
    const memory = await this.deps.memoryRepo.findById(parsedEvent.object_id);
    if (memory === null) {
      throw new CoreError("NOT_FOUND", `Memory entry not found: ${parsedEvent.object_id}`);
    }
    // add own amount: this event is inserted later, so match baseline create-then-sum.
    const karmaSum =
      (await this.deps.karmaEventRepo.sumByObjectId(parsedEvent.object_id)) + parsedEvent.amount;
    const transition = this.computeKarmaTransition(memory, parsedEvent, karmaSum, this.deps.now(), context);
    return {
      parsedEvent,
      memory,
      karmaSum,
      transition,
      ...(context === undefined ? {} : { context })
    };
  }

  private computeKarmaTransitionPlanSync(
    parsedEvent: Readonly<KarmaEvent>,
    context?: KarmaTransitionContext
  ): KarmaTransitionPlan {
    const { memoryRepo, karmaEventRepo } = this.deps;
    if (memoryRepo.findByIdSync === undefined || karmaEventRepo.sumByObjectIdSync === undefined) {
      throw new CoreError("CONFLICT", "Atomic karma transition requires synchronous read ports.", {
        subCode: "PORT_UNAVAILABLE"
      });
    }
    const memory = memoryRepo.findByIdSync(parsedEvent.object_id);
    if (memory === null) {
      throw new CoreError("NOT_FOUND", `Memory entry not found: ${parsedEvent.object_id}`);
    }
    const karmaSum = karmaEventRepo.sumByObjectIdSync(parsedEvent.object_id) + parsedEvent.amount;
    const transition = this.computeKarmaTransition(memory, parsedEvent, karmaSum, this.deps.now(), context);
    return {
      parsedEvent,
      memory,
      karmaSum,
      transition,
      ...(context === undefined ? {} : { context })
    };
  }

  public async applyKarmaTransitionPlan(plan: KarmaTransitionPlan): Promise<KarmaTransitionApplyResult> {
    await this.deps.karmaEventRepo.create(plan.parsedEvent);
    const updated = await this.deps.memoryRepo.updateDynamics(
      plan.memory.object_id,
      {
        activation_score: plan.transition.activationScore,
        retention_score: plan.transition.retentionScore,
        manifestation_state: plan.transition.manifestationState,
        retention_state: plan.transition.retentionState,
        ...plan.transition.fieldUpdates
      },
      plan.transition.now
    );
    const revived = await this.reviveDormantMemoryFromKarma(plan.memory, plan.parsedEvent, plan.transition.now);
    return { updated, revived };
  }

  public async auditKarmaTransition(
    applyResult: KarmaTransitionApplyResult,
    plan: KarmaTransitionPlan
  ): Promise<EventLogEntry[]> {
    return await this.buildKarmaTransitionAuditEntries(applyResult, plan);
  }

  public async notifyKarmaTransition(
    updated: Readonly<MemoryEntry>,
    events: readonly EventLogEntry[]
  ): Promise<void> {
    await broadcastEvents(this.deps.runtimeNotifier, events);
    this.scheduleGreenReevaluation(updated);
  }

  public computeKarmaTransition(
    memory: Readonly<MemoryEntry>,
    parsedEvent: Readonly<KarmaEvent>,
    karmaSum: number,
    now: string,
    context?: KarmaTransitionContext
  ): KarmaTransitionComputation {
    const previousRetention = memory.retention_score ?? 0;
    const previousRetentionState =
      memory.retention_state ??
      resolveRetentionState({
        memory,
        retentionScore: previousRetention,
        reinforcementCount: memory.reinforcement_count ?? 0,
        lifecycleState: memory.lifecycle_state,
        supersededBy: memory.superseded_by,
        currentRetentionState: memory.retention_state ?? null,
        now
      });
    const previousManifestation =
      memory.manifestation_state ?? determineManifestation(memory.activation_score ?? 0);
    const retentionScore = computeRetentionFromKarma(memory, karmaSum, now);
    const fieldUpdates = deriveKarmaFieldUpdates(memory, parsedEvent, context);
    const retentionState = resolveRetentionState({
      memory,
      retentionScore,
      reinforcementCount: fieldUpdates.reinforcement_count ?? memory.reinforcement_count ?? 0,
      lifecycleState: memory.lifecycle_state,
      supersededBy: fieldUpdates.superseded_by ?? memory.superseded_by,
      currentRetentionState: previousRetentionState,
      now
    });
    const activationScore = computeActivationScore(
      {
        ...memory,
        retention_score: retentionScore,
        last_used_at: fieldUpdates.last_used_at ?? memory.last_used_at,
        last_hit_at: fieldUpdates.last_hit_at ?? memory.last_hit_at
      },
      {
        currentScopeClass: memory.scope_class,
        currentDomainTags: memory.domain_tags,
        now
      }
    );

    return {
      now,
      previousRetention,
      previousRetentionState,
      previousManifestation,
      retentionScore,
      retentionState,
      activationScore,
      manifestationState: determineManifestation(activationScore),
      fieldUpdates
    };
  }

  private async buildKarmaTransitionAuditEntries(
    applyResult: KarmaTransitionApplyResult,
    plan: KarmaTransitionPlan
  ): Promise<EventLogEntry[]> {
    const entries: EventLogEntry[] = [];
    for (const input of this.buildKarmaAuditInputs(applyResult, plan)) {
      entries.push(await this.deps.eventLogRepo.append(input));
    }
    return entries;
  }

  private buildKarmaRevivalAuditInputs(
    applyResult: KarmaTransitionApplyResult,
    plan: KarmaTransitionPlan
  ): DynamicsEventLogInput[] {
    if (!applyResult.revived) {
      return [];
    }

    const { parsedEvent, transition } = plan;
    return [
      buildStateChangedEventInput({
        memory: applyResult.updated,
        fromState: "dormant",
        toState: "active",
        reasonCode: parsedEvent.kind,
        occurredAt: transition.now
      })
    ];
  }

  private buildKarmaAuditInputs(
    applyResult: KarmaTransitionApplyResult,
    plan: KarmaTransitionPlan
  ): DynamicsEventLogInput[] {
    const inputs: DynamicsEventLogInput[] = [];
    const { parsedEvent, transition } = plan;
    const memory = applyResult.updated;

    if (applyResult.revived) {
      inputs.push(
        buildStateChangedEventInput({
          memory,
          fromState: "dormant",
          toState: "active",
          reasonCode: parsedEvent.kind,
          occurredAt: transition.now
        })
      );
    }

    if (hasScoreChanged(transition.previousRetention, transition.retentionScore)) {
      inputs.push(
        buildRetentionUpdatedEventInput({
          memory,
          fromRetention: transition.previousRetention,
          toRetention: transition.retentionScore,
          reasonCode: parsedEvent.kind,
          occurredAt: transition.now
        })
      );
    }

    if (transition.previousRetentionState !== transition.retentionState) {
      inputs.push(
        buildStateChangedEventInput({
          memory,
          fromState: transition.previousRetentionState,
          toState: transition.retentionState,
          reasonCode: parsedEvent.kind,
          occurredAt: transition.now
        })
      );
    }

    if (transition.previousManifestation !== transition.manifestationState) {
      inputs.push(
        buildManifestationChangedEventInput({
          memory,
          fromState: transition.previousManifestation,
          toState: transition.manifestationState,
          reasonCode: parsedEvent.kind,
          occurredAt: transition.now
        })
      );
    }

    return inputs;
  }

  private reviveDormantMemoryFromKarmaSync(
    memory: Readonly<MemoryEntry>,
    parsedEvent: Readonly<KarmaEvent>,
    now: string
  ): boolean {
    if (parsedEvent.amount <= 0) {
      return false;
    }

    // Invoke via the repo so the method keeps its `this`; destructuring the
    // prototype method detaches its bound SQLite statements.
    const memoryRepo = this.deps.memoryRepo;
    if (memoryRepo.reviveDormantSync !== undefined) {
      return memoryRepo.reviveDormantSync(memory.object_id, now) !== null;
    }

    if (memory.lifecycle_state === "dormant" && memoryRepo.transitionLifecycleSync !== undefined) {
      memoryRepo.transitionLifecycleSync(memory.object_id, "active", now);
      return true;
    }

    return false;
  }

  private async reviveDormantMemoryFromKarma(
    memory: Readonly<MemoryEntry>,
    parsedEvent: Readonly<KarmaEvent>,
    now: string
  ): Promise<boolean> {
    if (parsedEvent.amount <= 0) {
      return false;
    }

    // Invoke via the repo so the method keeps its `this`; destructuring the
    // prototype method detaches its bound SQLite statements.
    const memoryRepo = this.deps.memoryRepo;
    if (memoryRepo.reviveDormant !== undefined) {
      const revivedRow = await memoryRepo.reviveDormant(memory.object_id, now);
      return revivedRow !== null;
    }

    if (memory.lifecycle_state === "dormant" && memoryRepo.transitionLifecycle !== undefined) {
      await memoryRepo.transitionLifecycle(memory.object_id, "active", now);
      return true;
    }

    return false;
  }

  private scheduleGreenReevaluation(updated: Readonly<MemoryEntry>): void {
    scheduleAuditedAsyncSideEffect(
      this.deps.greenService?.reevaluate({
        targetObjectId: updated.object_id,
        workspaceId: updated.workspace_id
      }),
      {
        source: "DynamicsService",
        operation: "green_reevaluate_after_karma_transition",
        subjectType: "memory_entry",
        subjectId: updated.object_id,
        workspaceId: updated.workspace_id,
        runId: updated.run_id,
        causedBy: "system",
        warningCode: "ALAYA_DYNAMICS_GREEN_REEVALUATE_FAILED",
        warningMessage: "[DynamicsService] greenService.reevaluate rejected (fire-and-forget)",
        eventLogRepo: this.deps.eventLogRepo,
        runtimeNotifier: this.deps.runtimeNotifier,
        now: this.deps.now
      }
    );
  }
}
