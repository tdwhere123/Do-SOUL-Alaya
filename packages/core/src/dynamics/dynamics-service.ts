import { randomUUID } from "node:crypto";
import {
  DYNAMICS_CONSTANTS,
  StorageTier,
  type EventLogEntry,
  type KarmaEvent,
  type KarmaEventKind,
  type ManifestationState,
  type MemoryDimension,
  type MemoryEntry,
  type RetentionState,
  type ScopeClass
} from "@do-soul/alaya-protocol";
import { CoreError } from "../shared/errors.js";

import { dynamicsServiceEmitKarmaEvent, dynamicsServiceAssignInitialDynamics, dynamicsServiceProcessKarmaEvent, dynamicsServiceComputeKarmaTransition, dynamicsServiceApplyKarmaTransition, dynamicsServiceReviveDormantMemoryFromKarma, dynamicsServiceAppendKarmaTransitionEvents, dynamicsServiceAppendMemoryRevivalEvent } from "./dynamics-service-methods-1.js";
import { dynamicsServiceAppendRetentionUpdatedEvent, dynamicsServiceAppendRetentionStateChangedEvent, dynamicsServiceAppendManifestationChangedEvent, dynamicsServiceScheduleGreenReevaluation, dynamicsServiceComputeRetentionScore, dynamicsServiceComputeActivationScore, dynamicsServiceDetermineManifestation } from "./dynamics-service-methods-2.js";
import { dynamicsServiceScanRetentionDecay, dynamicsServiceResolveRetentionState, dynamicsServiceComputeRetentionFromKarma } from "./dynamics-service-methods-3.js";
import { dynamicsServiceBroadcastEvents } from "./dynamics-service-methods-4.js";

const SCORE_CHANGE_EPSILON = 1e-9;

const ACTIVATION_WEIGHT_SUM_EPSILON = 1e-6;

const DYNAMICS_MEMORY_SCAN_PAGE_LIMIT = 500;

interface KarmaTransitionComputation {
  readonly now: string;
  readonly previousRetention: number;
  readonly previousRetentionState: RetentionState;
  readonly previousManifestation: ManifestationState;
  readonly retentionScore: number;
  readonly retentionState: RetentionState;
  readonly activationScore: number;
  readonly manifestationState: ManifestationState;
  readonly fieldUpdates: KarmaDerivedFieldUpdates;
}

type KarmaDerivedFieldUpdates = Readonly<{
  readonly last_used_at?: string;
  readonly last_hit_at?: string;
  readonly reinforcement_count?: number;
  readonly contradiction_count?: number;
  readonly superseded_by?: string;
}>;

export interface DynamicsUpdateFields {
  readonly activation_score: number;
  readonly retention_score: number;
  readonly manifestation_state: ManifestationState;
  readonly retention_state?: RetentionState;
  readonly last_used_at?: string;
  readonly last_hit_at?: string;
  readonly reinforcement_count?: number;
  readonly contradiction_count?: number;
  readonly superseded_by?: string;
}

export interface DynamicsServiceMemoryRepoPort {
  findById(objectId: string): Promise<Readonly<MemoryEntry> | null>;
  findByWorkspaceId(
    workspaceId: string,
    tier?: StorageTier,
    page?: {
      readonly limit: number;
      readonly offset: number;
    }
  ): Promise<readonly Readonly<MemoryEntry>[]>;
  findByWorkspaceIdAll?(
    workspaceId: string,
    tier?: StorageTier
  ): Promise<readonly Readonly<MemoryEntry>[]>;
  updateDynamics(
    objectId: string,
    fields: DynamicsUpdateFields,
    updatedAt: string
  ): Promise<Readonly<MemoryEntry>>;
  // invariant: REVERSIBLE revival path. Optional so narrow test fakes need not
  // implement it; when present, a positive karma event on a dormant memory
  // flips lifecycle_state dormant -> active so a used memory re-enters recall.
  // see also: processKarmaEvent revival branch, lifecycle.ts dormant -> active.
  transitionLifecycle?(
    objectId: string,
    lifecycleState: MemoryEntry["lifecycle_state"],
    updatedAt: string
  ): Promise<Readonly<MemoryEntry>>;
  // invariant (N1): guarded revival. Returns the row when it transitioned
  // dormant -> active, or null when the row was NOT dormant (no-op). The caller
  // skips the revival audit event on null so an already-active row never emits a
  // spurious from_state="dormant" transition. Optional; absent => fall back to
  // the in-memory-guarded transitionLifecycle path.
  reviveDormant?(objectId: string, updatedAt: string): Promise<Readonly<MemoryEntry> | null>;
}

export interface DynamicsServiceKarmaEventRepoPort {
  create(event: Readonly<KarmaEvent>): Promise<Readonly<KarmaEvent>>;
  sumByObjectId(objectId: string): Promise<number>;
  sumByObjectIds(objectIds: readonly string[]): Promise<Readonly<Record<string, number>>>;
  findByObjectId(objectId: string): Promise<readonly Readonly<KarmaEvent>[]>;
}

export interface DynamicsServiceEventLogRepoPort {
  append(entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">): EventLogEntry | Promise<EventLogEntry>;
  queryByEntity(entityType: string, entityId: string): Promise<readonly EventLogEntry[]>;
}

export interface DynamicsServiceGreenPort {
  reevaluate(params: {
    readonly targetObjectId: string;
    readonly workspaceId: string;
  }): Promise<unknown>;
}

export interface DynamicsServiceDependencies {
  readonly memoryRepo: DynamicsServiceMemoryRepoPort;
  readonly karmaEventRepo: DynamicsServiceKarmaEventRepoPort;
  readonly eventLogRepo: DynamicsServiceEventLogRepoPort;
  readonly runtimeNotifier: {
    notifyEntry(entry: EventLogEntry): void | Promise<void>;
  };
  readonly greenService?: DynamicsServiceGreenPort;
  readonly generateEventId?: () => string;
  readonly now?: () => string;
}

export class DynamicsService {
public readonly now: () => string;

public readonly generateEventId: () => string;

public constructor(public readonly dependencies: DynamicsServiceDependencies) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.generateEventId = dependencies.generateEventId ?? (() => randomUUID());
    assertActivationWeightsSumToOne(DYNAMICS_CONSTANTS.activation_weights_phase1b);
  }

  public async emitKarmaEvent(input: {
    readonly kind: KarmaEventKind;
    readonly objectId: string;
    readonly workspaceId: string;
    readonly amount?: number;
    readonly runId?: string | null;
  }): Promise<void> {
    return dynamicsServiceEmitKarmaEvent(this, input);
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
    return dynamicsServiceAssignInitialDynamics(this, params);
  }

  public async processKarmaEvent(event: KarmaEvent): Promise<void> {
    return dynamicsServiceProcessKarmaEvent(this, event);
  }

  private computeKarmaTransition(memory: Readonly<MemoryEntry>, parsedEvent: Readonly<KarmaEvent>, karmaSum: number, now: string): KarmaTransitionComputation {
    return dynamicsServiceComputeKarmaTransition(this, memory, parsedEvent, karmaSum, now);
  }

  private async applyKarmaTransition(memory: Readonly<MemoryEntry>, transition: KarmaTransitionComputation): Promise<Readonly<MemoryEntry>> {
    return dynamicsServiceApplyKarmaTransition(this, memory, transition);
  }

  private async reviveDormantMemoryFromKarma(memory: Readonly<MemoryEntry>, parsedEvent: Readonly<KarmaEvent>, now: string): Promise<boolean> {
    return dynamicsServiceReviveDormantMemoryFromKarma(this, memory, parsedEvent, now);
  }

  private async appendKarmaTransitionEvents(updated: Readonly<MemoryEntry>, parsedEvent: Readonly<KarmaEvent>, transition: KarmaTransitionComputation, revived: boolean): Promise<EventLogEntry[]> {
    return dynamicsServiceAppendKarmaTransitionEvents(this, updated, parsedEvent, transition, revived);
  }

  private async appendMemoryRevivalEvent(updated: Readonly<MemoryEntry>, parsedEvent: Readonly<KarmaEvent>, now: string): Promise<EventLogEntry> {
    return dynamicsServiceAppendMemoryRevivalEvent(this, updated, parsedEvent, now);
  }

  private async appendRetentionUpdatedEvent(updated: Readonly<MemoryEntry>, parsedEvent: Readonly<KarmaEvent>, transition: KarmaTransitionComputation): Promise<EventLogEntry> {
    return dynamicsServiceAppendRetentionUpdatedEvent(this, updated, parsedEvent, transition);
  }

  private async appendRetentionStateChangedEvent(updated: Readonly<MemoryEntry>, parsedEvent: Readonly<KarmaEvent>, transition: KarmaTransitionComputation): Promise<EventLogEntry> {
    return dynamicsServiceAppendRetentionStateChangedEvent(this, updated, parsedEvent, transition);
  }

  private async appendManifestationChangedEvent(updated: Readonly<MemoryEntry>, parsedEvent: Readonly<KarmaEvent>, transition: KarmaTransitionComputation): Promise<EventLogEntry> {
    return dynamicsServiceAppendManifestationChangedEvent(this, updated, parsedEvent, transition);
  }

  private scheduleGreenReevaluation(updated: Readonly<MemoryEntry>): void {
    return dynamicsServiceScheduleGreenReevaluation(this, updated);
  }

  public async computeRetentionScore(memory: Readonly<MemoryEntry>): Promise<number> {
    return dynamicsServiceComputeRetentionScore(this, memory);
  }

  public computeActivationScore(memory: Readonly<MemoryEntry>, context: {
      readonly currentScopeClass: ScopeClass;
      readonly currentDomainTags: readonly string[];
      readonly now?: string;
    }): number {
    return dynamicsServiceComputeActivationScore(this, memory, context);
  }

  public determineManifestation(activationScore: number): ManifestationState {
    return dynamicsServiceDetermineManifestation(this, activationScore);
  }

  public async scanRetentionDecay(workspaceId: string): Promise<{
    readonly updated_count: number;
    readonly manifestation_changes: number;
  }> {
    return dynamicsServiceScanRetentionDecay(this, workspaceId);
  }

  private resolveRetentionState(params: {
    readonly memory: Readonly<MemoryEntry>;
    readonly retentionScore: number;
    readonly reinforcementCount: number;
    readonly lifecycleState: MemoryEntry["lifecycle_state"];
    readonly supersededBy: string | null;
    readonly currentRetentionState: RetentionState | null;
    readonly now: string;
  }): RetentionState {
    return dynamicsServiceResolveRetentionState(this, params);
  }

  private computeRetentionFromKarma(memory: Readonly<MemoryEntry>, karmaSum: number, now: string): number {
    return dynamicsServiceComputeRetentionFromKarma(this, memory, karmaSum, now);
  }

  private async broadcastEvents(events: readonly EventLogEntry[]): Promise<void> {
    return dynamicsServiceBroadcastEvents(this, events);
  }
}

function assertActivationWeightsSumToOne(
  weights: Readonly<Record<"scope_match" | "domain_match" | "retention" | "freshness", number>>
): void {
  const sum = weights.scope_match + weights.domain_match + weights.retention + weights.freshness;

  if (Math.abs(sum - 1) > ACTIVATION_WEIGHT_SUM_EPSILON) {
    throw new CoreError("VALIDATION", `activation_weights_phase1b must sum to 1.0, got ${sum}`);
  }
}
