import {
  StorageTier,
  type EventLogEntry,
  type ManifestationState,
  type MemoryEntry,
  type RetentionState
} from "@do-soul/alaya-protocol";

import { CoreError } from "../shared/errors.js";
import { parseNonEmptyString } from "../shared/validators.js";

import {
  appendManifestationChangedEvent,
  appendRetentionUpdatedEvent,
  appendStateChangedEvent,
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
  collectWorkspaceMemories,
  hasScoreChanged,
  type DynamicsEventLogInput,
  type DynamicsServiceEventLogRepoPort,
  type DynamicsServiceKarmaEventRepoPort,
  type DynamicsServiceMemoryRepoPort,
  type DynamicsServiceRuntimeNotifier,
  type KarmaTransitionEventPublisherPort
} from "./dynamics-service-ports.js";

const HEALTH_SCAN_REASON = "health_scan";

export interface RetentionDecayScannerDependencies {
  readonly memoryRepo: DynamicsServiceMemoryRepoPort;
  readonly karmaEventRepo: DynamicsServiceKarmaEventRepoPort;
  readonly eventLogRepo: DynamicsServiceEventLogRepoPort;
  readonly runtimeNotifier: DynamicsServiceRuntimeNotifier;
  readonly eventPublisher?: KarmaTransitionEventPublisherPort;
  readonly now: () => string;
}

interface DecayTransition {
  readonly previousRetention: number;
  readonly previousRetentionState: RetentionState;
  readonly previousManifestation: ManifestationState;
  readonly retentionScore: number;
  readonly retentionState: RetentionState;
  readonly activationScore: number;
  readonly manifestationState: ManifestationState;
}

interface DecayTransitionApplyResult {
  readonly updated: boolean;
  readonly manifestationChanged: boolean;
}

export interface RetentionDecayScanResult {
  readonly updated_count: number;
  readonly manifestation_changes: number;
}

// Periodic decay sweep over a workspace's HOT memories; recomputes retention /
// activation and emits audit events only for memories whose scores changed.
export class RetentionDecayScanner {
  public constructor(private readonly deps: RetentionDecayScannerDependencies) {}

  public async scanRetentionDecay(workspaceId: string): Promise<RetentionDecayScanResult> {
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspaceId");
    const now = this.deps.now();
    const memories = await collectWorkspaceMemories(this.deps.memoryRepo, parsedWorkspaceId, StorageTier.HOT);

    let updatedCount = 0;
    let manifestationChanges = 0;

    for (const memory of memories) {
      const outcome = await this.applyDecayTransition(memory.object_id, now);
      if (!outcome.updated) {
        continue;
      }
      updatedCount += 1;
      if (outcome.manifestationChanged) {
        manifestationChanges += 1;
      }
    }

    return {
      updated_count: updatedCount,
      manifestation_changes: manifestationChanges
    };
  }

  private canRunAtomicDecayTransition(): boolean {
    const { memoryRepo, karmaEventRepo } = this.deps;
    return (
      this.deps.eventPublisher !== undefined &&
      memoryRepo.findByIdSync !== undefined &&
      memoryRepo.updateDynamicsSync !== undefined &&
      karmaEventRepo.sumByObjectIdSync !== undefined
    );
  }

  private async applyDecayTransition(objectId: string, now: string): Promise<DecayTransitionApplyResult> {
    if (this.canRunAtomicDecayTransition()) {
      return this.applyDecayTransitionAtomic(objectId, now);
    }
    const memory = await this.deps.memoryRepo.findById(objectId);
    if (memory === null) {
      return { updated: false, manifestationChanged: false };
    }
    const karmaSum = await this.deps.karmaEventRepo.sumByObjectId(objectId);
    return this.applyDecayTransitionAsync(memory, karmaSum, now);
  }

  private async applyDecayTransitionAtomic(objectId: string, now: string): Promise<DecayTransitionApplyResult> {
    const eventPublisher = this.deps.eventPublisher;
    if (eventPublisher === undefined) {
      throw new CoreError("CONFLICT", "Atomic retention decay requires an event publisher.", {
        subCode: "PORT_UNAVAILABLE"
      });
    }
    let decayResult: DecayTransitionApplyResult | undefined;
    await eventPublisher.mutateThenAppendMany(() => {
      const { memoryRepo, karmaEventRepo } = this.deps;
      if (
        memoryRepo.findByIdSync === undefined ||
        memoryRepo.updateDynamicsSync === undefined ||
        karmaEventRepo.sumByObjectIdSync === undefined
      ) {
        throw new CoreError("CONFLICT", "Atomic retention decay requires synchronous repo ports.", {
          subCode: "PORT_UNAVAILABLE"
        });
      }
      const memory = memoryRepo.findByIdSync(objectId);
      if (memory === null) {
        return { events: [], result: { updated: false, manifestationChanged: false } };
      }
      const transition = this.computeDecayTransition(
        memory,
        karmaEventRepo.sumByObjectIdSync(objectId),
        now
      );
      if (!this.shouldApplyDecayTransition(transition)) {
        return { events: [], result: { updated: false, manifestationChanged: false } };
      }
      const dummyUpdatedMemory = {
        ...memory,
        activation_score: transition.activationScore,
        retention_score: transition.retentionScore,
        manifestation_state: transition.manifestationState,
        retention_state: transition.retentionState
      };
      const events = this.buildDecayAuditInputs(dummyUpdatedMemory, transition, now);
      return {
        events,
        result: undefined,
        apply: () => {
          memoryRepo.updateDynamicsSync(
            objectId,
            {
              activation_score: transition.activationScore,
              retention_score: transition.retentionScore,
              manifestation_state: transition.manifestationState,
              retention_state: transition.retentionState
            },
            now
          );
          decayResult = {
            updated: true,
            manifestationChanged: transition.previousManifestation !== transition.manifestationState
          };
        }
      };
    });
    return decayResult ?? { updated: false, manifestationChanged: false };
  }

  private async applyDecayTransitionAsync(
    memory: Readonly<MemoryEntry>,
    karmaSum: number,
    now: string
  ): Promise<DecayTransitionApplyResult> {
    const transition = this.computeDecayTransition(memory, karmaSum, now);
    if (!this.shouldApplyDecayTransition(transition)) {
      return { updated: false, manifestationChanged: false };
    }

    const updated = await this.deps.memoryRepo.updateDynamics(
      memory.object_id,
      {
        activation_score: transition.activationScore,
        retention_score: transition.retentionScore,
        manifestation_state: transition.manifestationState,
        retention_state: transition.retentionState
      },
      now
    );

    const events: EventLogEntry[] = [];
    let manifestationChanged = false;

    if (hasScoreChanged(transition.previousRetention, transition.retentionScore)) {
      events.push(
        await appendRetentionUpdatedEvent(this.deps.eventLogRepo, {
          memory: updated,
          fromRetention: transition.previousRetention,
          toRetention: transition.retentionScore,
          reasonCode: HEALTH_SCAN_REASON,
          occurredAt: now
        })
      );
    }

    if (transition.previousRetentionState !== transition.retentionState) {
      events.push(
        await appendStateChangedEvent(this.deps.eventLogRepo, {
          memory: updated,
          fromState: transition.previousRetentionState,
          toState: transition.retentionState,
          reasonCode: HEALTH_SCAN_REASON,
          occurredAt: now
        })
      );
    }

    if (transition.previousManifestation !== transition.manifestationState) {
      events.push(
        await appendManifestationChangedEvent(this.deps.eventLogRepo, {
          memory: updated,
          fromState: transition.previousManifestation,
          toState: transition.manifestationState,
          reasonCode: HEALTH_SCAN_REASON,
          occurredAt: now
        })
      );
      manifestationChanged = true;
    }

    await broadcastEvents(this.deps.runtimeNotifier, events);
    return { updated: true, manifestationChanged };
  }

  private shouldApplyDecayTransition(transition: DecayTransition): boolean {
    return (
      hasScoreChanged(transition.previousRetention, transition.retentionScore) ||
      transition.previousManifestation !== transition.manifestationState ||
      transition.previousRetentionState !== transition.retentionState
    );
  }

  private buildDecayAuditInputs(
    memory: Readonly<MemoryEntry>,
    transition: DecayTransition,
    now: string
  ): readonly DynamicsEventLogInput[] {
    const inputs: DynamicsEventLogInput[] = [];

    if (hasScoreChanged(transition.previousRetention, transition.retentionScore)) {
      inputs.push(
        buildRetentionUpdatedEventInput({
          memory,
          fromRetention: transition.previousRetention,
          toRetention: transition.retentionScore,
          reasonCode: HEALTH_SCAN_REASON,
          occurredAt: now
        })
      );
    }

    if (transition.previousRetentionState !== transition.retentionState) {
      inputs.push(
        buildStateChangedEventInput({
          memory,
          fromState: transition.previousRetentionState,
          toState: transition.retentionState,
          reasonCode: HEALTH_SCAN_REASON,
          occurredAt: now
        })
      );
    }

    if (transition.previousManifestation !== transition.manifestationState) {
      inputs.push(
        buildManifestationChangedEventInput({
          memory,
          fromState: transition.previousManifestation,
          toState: transition.manifestationState,
          reasonCode: HEALTH_SCAN_REASON,
          occurredAt: now
        })
      );
    }

    return inputs;
  }

  private computeDecayTransition(
    memory: Readonly<MemoryEntry>,
    karmaSum: number,
    now: string
  ): DecayTransition {
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
    const retentionState = resolveRetentionState({
      memory,
      retentionScore,
      reinforcementCount: memory.reinforcement_count ?? 0,
      lifecycleState: memory.lifecycle_state,
      supersededBy: memory.superseded_by,
      currentRetentionState: previousRetentionState,
      now
    });
    const activationScore = computeActivationScore(
      {
        ...memory,
        retention_score: retentionScore
      },
      {
        currentScopeClass: memory.scope_class,
        currentDomainTags: memory.domain_tags,
        now
      }
    );

    return {
      previousRetention,
      previousRetentionState,
      previousManifestation,
      retentionScore,
      retentionState,
      activationScore,
      manifestationState: determineManifestation(activationScore)
    };
  }
}
