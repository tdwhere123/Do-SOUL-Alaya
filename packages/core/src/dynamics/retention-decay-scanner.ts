import {
  StorageTier,
  type EventLogEntry,
  type ManifestationState,
  type MemoryEntry,
  type RetentionState
} from "@do-soul/alaya-protocol";

import { parseNonEmptyString } from "../shared/validators.js";

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
  collectWorkspaceMemories,
  hasScoreChanged,
  type DynamicsServiceEventLogRepoPort,
  type DynamicsServiceKarmaEventRepoPort,
  type DynamicsServiceMemoryRepoPort,
  type DynamicsServiceRuntimeNotifier
} from "./dynamics-service-ports.js";

const HEALTH_SCAN_REASON = "health_scan";

export interface RetentionDecayScannerDependencies {
  readonly memoryRepo: DynamicsServiceMemoryRepoPort;
  readonly karmaEventRepo: DynamicsServiceKarmaEventRepoPort;
  readonly eventLogRepo: DynamicsServiceEventLogRepoPort;
  readonly runtimeNotifier: DynamicsServiceRuntimeNotifier;
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
    const karmaByObjectId = await this.deps.karmaEventRepo.sumByObjectIds(
      memories.map((memory) => memory.object_id)
    );

    let updatedCount = 0;
    let manifestationChanges = 0;

    for (const memory of memories) {
      const transition = this.computeDecayTransition(memory, karmaByObjectId[memory.object_id] ?? 0, now);

      if (
        !hasScoreChanged(transition.previousRetention, transition.retentionScore) &&
        transition.previousManifestation === transition.manifestationState &&
        transition.previousRetentionState === transition.retentionState
      ) {
        continue;
      }

      const emittedManifestationChange = await this.applyDecayTransition(memory, transition, now);
      updatedCount += 1;
      if (emittedManifestationChange) {
        manifestationChanges += 1;
      }
    }

    return {
      updated_count: updatedCount,
      manifestation_changes: manifestationChanges
    };
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

  // DB-first: write scores before emitting audit events (see processKarmaEvent).
  private async applyDecayTransition(
    memory: Readonly<MemoryEntry>,
    transition: DecayTransition,
    now: string
  ): Promise<boolean> {
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
    return manifestationChanged;
  }
}
