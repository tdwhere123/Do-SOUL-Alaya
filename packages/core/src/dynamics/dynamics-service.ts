import { randomUUID } from "node:crypto";
import {
  DYNAMICS_CONSTANTS,
  type KarmaEvent,
  type KarmaEventKind,
  type ManifestationState,
  type MemoryDimension,
  type MemoryEntry,
  type RetentionState,
  type ScopeClass
} from "@do-soul/alaya-protocol";

import {
  computeActivationScore as computeActivationScorePure,
  computeRetentionFromKarma,
  determineManifestation
} from "./dynamics-scoring.js";
import {
  DIMENSION_DEFAULT_DECAY_PROFILE,
  INITIAL_ACTIVATION_FROM_CONFIDENCE_FACTOR,
  clamp01
} from "./dynamics-constants-runtime.js";
import { KarmaTransitionEngine } from "./karma-transition-engine.js";
import { RetentionDecayScanner, type RetentionDecayScanResult } from "./retention-decay-scanner.js";
import {
  assertActivationWeightsSumToOne,
  confidenceByFormationKind,
  parseDimension,
  parseFormationKind,
  type DynamicsServiceDependencies,
  type KarmaTransitionContext
} from "./dynamics-service-ports.js";

export type {
  DynamicsEventLogInput,
  DynamicsServiceDependencies,
  DynamicsServiceEventLogRepoPort,
  DynamicsServiceGreenPort,
  DynamicsServiceKarmaEventRepoPort,
  DynamicsServiceMemoryRepoPort,
  DynamicsServiceRuntimeNotifier,
  DynamicsUpdateFields,
  KarmaDerivedFieldUpdates,
  KarmaTransitionComputation,
  KarmaTransitionContext,
  KarmaTransitionEventPublisherPort
} from "./dynamics-service-ports.js";

export class DynamicsService {
  public readonly now: () => string;

  public readonly generateEventId: () => string;

  private readonly karmaEngine: KarmaTransitionEngine;

  private readonly retentionScanner: RetentionDecayScanner;

  public constructor(public readonly dependencies: DynamicsServiceDependencies) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.generateEventId = dependencies.generateEventId ?? (() => randomUUID());
    assertActivationWeightsSumToOne(DYNAMICS_CONSTANTS.activation_weights_phase1b);
    this.karmaEngine = new KarmaTransitionEngine({
      memoryRepo: dependencies.memoryRepo,
      karmaEventRepo: dependencies.karmaEventRepo,
      eventLogRepo: dependencies.eventLogRepo,
      runtimeNotifier: dependencies.runtimeNotifier,
      greenService: dependencies.greenService,
      eventPublisher: dependencies.eventPublisher,
      now: this.now
    });
    this.retentionScanner = new RetentionDecayScanner({
      memoryRepo: dependencies.memoryRepo,
      karmaEventRepo: dependencies.karmaEventRepo,
      eventLogRepo: dependencies.eventLogRepo,
      runtimeNotifier: dependencies.runtimeNotifier,
      eventPublisher: dependencies.eventPublisher,
      now: this.now
    });
  }

  public async emitKarmaEvent(input: {
    readonly kind: KarmaEventKind;
    readonly objectId: string;
    readonly workspaceId: string;
    readonly amount?: number;
    readonly runId?: string | null;
    readonly supersedingObjectId?: string;
  }): Promise<void> {
    const amount = input.amount ?? DYNAMICS_CONSTANTS.karma[input.kind];
    const transitionContext =
      input.supersedingObjectId === undefined
        ? undefined
        : Object.freeze({ supersedingObjectId: input.supersedingObjectId });
    await this.processKarmaEvent(
      {
        event_id: this.generateEventId(),
        kind: input.kind,
        object_id: input.objectId,
        amount,
        created_at: this.now(),
        workspace_id: input.workspaceId,
        run_id: input.runId ?? null
      },
      transitionContext
    );
  }

  public assignInitialDynamics(params: {
    readonly dimension: MemoryDimension;
    readonly formation_kind: MemoryEntry["formation_kind"];
    readonly created_at: string;
  }): {
    readonly decay_profile: MemoryEntry["decay_profile"];
    readonly confidence: number;
    readonly retention_score: number;
    readonly retention_state: RetentionState;
    readonly activation_score: number;
    readonly manifestation_state: ManifestationState;
    readonly reinforcement_count: number;
    readonly contradiction_count: number;
  } {
    const parsedDimension = parseDimension(params.dimension);
    const parsedFormationKind = parseFormationKind(params.formation_kind);
    const decayProfile = DIMENSION_DEFAULT_DECAY_PROFILE[parsedDimension];
    const confidence = confidenceByFormationKind(parsedFormationKind);
    const retentionScore = confidence;
    const activationScore = clamp01(confidence * INITIAL_ACTIVATION_FROM_CONFIDENCE_FACTOR);

    return Object.freeze({
      decay_profile: decayProfile,
      confidence,
      retention_score: retentionScore,
      retention_state: "working",
      activation_score: activationScore,
      manifestation_state: determineManifestation(activationScore),
      reinforcement_count: 0,
      contradiction_count: 0
    });
  }

  public async processKarmaEvent(
    event: KarmaEvent,
    context?: KarmaTransitionContext
  ): Promise<void> {
    return this.karmaEngine.processKarmaEvent(event, context);
  }

  public async computeRetentionScore(memory: Readonly<MemoryEntry>): Promise<number> {
    const karmaSum = await this.dependencies.karmaEventRepo.sumByObjectId(memory.object_id);
    return computeRetentionFromKarma(memory, karmaSum, this.now());
  }

  public computeActivationScore(memory: Readonly<MemoryEntry>, context: {
      readonly currentScopeClass: ScopeClass;
      readonly currentDomainTags: readonly string[];
      readonly now?: string;
    }): number {
    return computeActivationScorePure(memory, {
      currentScopeClass: context.currentScopeClass,
      currentDomainTags: context.currentDomainTags,
      now: context.now ?? this.now()
    });
  }

  public determineManifestation(activationScore: number): ManifestationState {
    return determineManifestation(activationScore);
  }

  public async scanRetentionDecay(workspaceId: string): Promise<RetentionDecayScanResult> {
    return this.retentionScanner.scanRetentionDecay(workspaceId);
  }
}
