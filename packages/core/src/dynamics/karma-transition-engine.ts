import {
  type EventLogEntry,
  type KarmaEvent,
  type MemoryEntry
} from "@do-soul/alaya-protocol";

import { scheduleAuditedAsyncSideEffect } from "../runtime/async-side-effect-auditor.js";
import { CoreError } from "../shared/errors.js";

import {
  appendManifestationChangedEvent,
  appendRetentionUpdatedEvent,
  appendStateChangedEvent,
  broadcastEvents
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
  type DynamicsServiceEventLogRepoPort,
  type DynamicsServiceGreenPort,
  type DynamicsServiceKarmaEventRepoPort,
  type DynamicsServiceMemoryRepoPort,
  type DynamicsServiceRuntimeNotifier,
  type KarmaTransitionComputation
} from "./dynamics-service-ports.js";

export interface KarmaTransitionEngineDependencies {
  readonly memoryRepo: DynamicsServiceMemoryRepoPort;
  readonly karmaEventRepo: DynamicsServiceKarmaEventRepoPort;
  readonly eventLogRepo: DynamicsServiceEventLogRepoPort;
  readonly runtimeNotifier: DynamicsServiceRuntimeNotifier;
  readonly greenService?: DynamicsServiceGreenPort;
  readonly now: () => string;
}

// Karma-event ingestion: transition math, DB apply, dormant revival, audit
// events, and the fire-and-forget Green re-evaluation.
export class KarmaTransitionEngine {
  public constructor(private readonly deps: KarmaTransitionEngineDependencies) {}

  public async processKarmaEvent(event: KarmaEvent): Promise<void> {
    const parsedEvent = parseKarmaEventInput(event);
    const memory = await this.deps.memoryRepo.findById(parsedEvent.object_id);

    if (memory === null) {
      throw new CoreError("NOT_FOUND", `Memory entry not found: ${parsedEvent.object_id}`);
    }

    await this.deps.karmaEventRepo.create(parsedEvent);
    const karmaSum = await this.deps.karmaEventRepo.sumByObjectId(parsedEvent.object_id);
    const transition = this.computeKarmaTransition(memory, parsedEvent, karmaSum, this.deps.now());
    const updated = await this.applyKarmaTransition(memory, transition);
    const revived = await this.reviveDormantMemoryFromKarma(memory, parsedEvent, transition.now);
    const events = await this.appendKarmaTransitionEvents(updated, parsedEvent, transition, revived);

    await broadcastEvents(this.deps.runtimeNotifier, events);
    this.scheduleGreenReevaluation(updated);
  }

  public computeKarmaTransition(
    memory: Readonly<MemoryEntry>,
    parsedEvent: Readonly<KarmaEvent>,
    karmaSum: number,
    now: string
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
    const fieldUpdates = deriveKarmaFieldUpdates(memory, parsedEvent);
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

  private async applyKarmaTransition(
    memory: Readonly<MemoryEntry>,
    transition: KarmaTransitionComputation
  ): Promise<Readonly<MemoryEntry>> {
    return await this.deps.memoryRepo.updateDynamics(
      memory.object_id,
      {
        activation_score: transition.activationScore,
        retention_score: transition.retentionScore,
        manifestation_state: transition.manifestationState,
        retention_state: transition.retentionState,
        ...transition.fieldUpdates
      },
      transition.now
    );
  }

  private async reviveDormantMemoryFromKarma(
    memory: Readonly<MemoryEntry>,
    parsedEvent: Readonly<KarmaEvent>,
    now: string
  ): Promise<boolean> {
    if (parsedEvent.amount <= 0) {
      return false;
    }

    const reviveDormant = this.deps.memoryRepo.reviveDormant;
    if (reviveDormant !== undefined) {
      const revivedRow = await reviveDormant(memory.object_id, now);
      return revivedRow !== null;
    }

    if (memory.lifecycle_state === "dormant" && this.deps.memoryRepo.transitionLifecycle !== undefined) {
      await this.deps.memoryRepo.transitionLifecycle(memory.object_id, "active", now);
      return true;
    }

    return false;
  }

  private async appendKarmaTransitionEvents(
    updated: Readonly<MemoryEntry>,
    parsedEvent: Readonly<KarmaEvent>,
    transition: KarmaTransitionComputation,
    revived: boolean
  ): Promise<EventLogEntry[]> {
    const events: EventLogEntry[] = [];

    if (revived) {
      events.push(
        await appendStateChangedEvent(this.deps.eventLogRepo, {
          memory: updated,
          fromState: "dormant",
          toState: "active",
          reasonCode: parsedEvent.kind,
          occurredAt: transition.now
        })
      );
    }

    if (hasScoreChanged(transition.previousRetention, transition.retentionScore)) {
      events.push(
        await appendRetentionUpdatedEvent(this.deps.eventLogRepo, {
          memory: updated,
          fromRetention: transition.previousRetention,
          toRetention: transition.retentionScore,
          reasonCode: parsedEvent.kind,
          occurredAt: transition.now
        })
      );
    }

    if (transition.previousRetentionState !== transition.retentionState) {
      events.push(
        await appendStateChangedEvent(this.deps.eventLogRepo, {
          memory: updated,
          fromState: transition.previousRetentionState,
          toState: transition.retentionState,
          reasonCode: parsedEvent.kind,
          occurredAt: transition.now
        })
      );
    }

    if (transition.previousManifestation !== transition.manifestationState) {
      events.push(
        await appendManifestationChangedEvent(this.deps.eventLogRepo, {
          memory: updated,
          fromState: transition.previousManifestation,
          toState: transition.manifestationState,
          reasonCode: parsedEvent.kind,
          occurredAt: transition.now
        })
      );
    }

    return events;
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
