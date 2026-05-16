import {
  DYNAMICS_CONSTANTS,
  FORMATION_CONFIDENCE_MAP,
  MemoryGovernanceEventType,
  SoulMemoryManifestationChangedPayloadSchema,
  SoulMemoryRetentionUpdatedPayloadSchema,
  SoulMemoryStateChangedPayloadSchema,
  StorageTier,
  TransitionCausedBy,
  parseKarmaEvent as parseProtocolKarmaEvent,
  type EventLogEntry,
  type KarmaEvent,
  type ManifestationState,
  type MemoryDimension,
  type MemoryEntry,
  type RetentionState,
  type ScopeClass
} from "@do-soul/alaya-protocol";
import { CoreError } from "./errors.js";
import {
  DIMENSION_DEFAULT_DECAY_PROFILE,
  INITIAL_ACTIVATION_FROM_CONFIDENCE_FACTOR,
  clamp01,
  computeFreshnessFactor,
  computeRetentionFromProfile,
  determineManifestation
} from "./dynamics-constants-runtime.js";
import { parseNonEmptyString } from "./shared/validators.js";

const SCORE_CHANGE_EPSILON = 1e-9;
const ACTIVATION_WEIGHT_SUM_EPSILON = 1e-6;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

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
  findByWorkspaceId(workspaceId: string, tier?: StorageTier): Promise<readonly Readonly<MemoryEntry>[]>;
  updateDynamics(
    objectId: string,
    fields: DynamicsUpdateFields,
    updatedAt: string
  ): Promise<Readonly<MemoryEntry>>;
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
  readonly now?: () => string;
}

export class DynamicsService {
  private readonly now: () => string;

  public constructor(private readonly dependencies: DynamicsServiceDependencies) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
    assertActivationWeightsSumToOne(DYNAMICS_CONSTANTS.activation_weights_phase1b);
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

  public async processKarmaEvent(event: KarmaEvent): Promise<void> {
    const parsedEvent = parseKarmaEventInput(event);
    const memory = await this.dependencies.memoryRepo.findById(parsedEvent.object_id);

    if (memory === null) {
      throw new CoreError("NOT_FOUND", `Memory entry not found: ${parsedEvent.object_id}`);
    }

    await this.dependencies.karmaEventRepo.create(parsedEvent);

    const now = this.now();
    const previousRetention = memory.retention_score ?? 0;
    const previousRetentionState =
      memory.retention_state ??
      this.resolveRetentionState({
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

    const karmaSum = await this.dependencies.karmaEventRepo.sumByObjectId(parsedEvent.object_id);
    const retentionScore = this.computeRetentionFromKarma(memory, karmaSum, now);
    const fieldUpdates = deriveKarmaFieldUpdates(memory, parsedEvent);
    const retentionState = this.resolveRetentionState({
      memory,
      retentionScore,
      reinforcementCount: fieldUpdates.reinforcement_count ?? memory.reinforcement_count ?? 0,
      lifecycleState: memory.lifecycle_state,
      supersededBy: fieldUpdates.superseded_by ?? memory.superseded_by,
      currentRetentionState: previousRetentionState,
      now
    });
    const activationScore = this.computeActivationScore(
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
    const manifestationState = this.determineManifestation(activationScore);

    // DB-first for dynamics audit events: memory_entries is the source of truth for
    // scores, and there is no reconciliation path if a phantom event is written before
    // a DB failure. Write to DB first, then emit audit events using the confirmed values.
    const updated = await this.dependencies.memoryRepo.updateDynamics(
      memory.object_id,
      {
        activation_score: activationScore,
        retention_score: retentionScore,
        manifestation_state: manifestationState,
        retention_state: retentionState,
        ...fieldUpdates
      },
      now
    );
    const events: EventLogEntry[] = [];

    if (hasScoreChanged(previousRetention, retentionScore)) {
      const retentionEvent = await this.dependencies.eventLogRepo.append({
        event_type: MemoryGovernanceEventType.SOUL_MEMORY_RETENTION_UPDATED,
        entity_type: "memory_entry",
        entity_id: updated.object_id,
        workspace_id: updated.workspace_id,
        run_id: updated.run_id,
        caused_by: TransitionCausedBy.SYSTEM,
        payload_json: SoulMemoryRetentionUpdatedPayloadSchema.parse({
          object_id: updated.object_id,
          object_kind: updated.object_kind,
          workspace_id: updated.workspace_id,
          run_id: updated.run_id,
          from_state: String(previousRetention),
          to_state: String(retentionScore),
          reason_code: parsedEvent.kind,
          caused_by: TransitionCausedBy.SYSTEM,
          evidence_refs: null,
          occurred_at: now,
          retention_score: retentionScore
        })
      });
      events.push(retentionEvent);
    }

    if (previousRetentionState !== retentionState) {
      const stateChangedEvent = await this.dependencies.eventLogRepo.append({
        event_type: MemoryGovernanceEventType.SOUL_MEMORY_STATE_CHANGED,
        entity_type: "memory_entry",
        entity_id: updated.object_id,
        workspace_id: updated.workspace_id,
        run_id: updated.run_id,
        caused_by: TransitionCausedBy.SYSTEM,
        payload_json: SoulMemoryStateChangedPayloadSchema.parse({
          object_id: updated.object_id,
          object_kind: updated.object_kind,
          workspace_id: updated.workspace_id,
          run_id: updated.run_id,
          from_state: previousRetentionState,
          to_state: retentionState,
          reason_code: parsedEvent.kind,
          caused_by: TransitionCausedBy.SYSTEM,
          evidence_refs: null,
          occurred_at: now
        })
      });
      events.push(stateChangedEvent);
    }

    if (previousManifestation !== manifestationState) {
      const manifestationEvent = await this.dependencies.eventLogRepo.append({
        event_type: MemoryGovernanceEventType.SOUL_MEMORY_MANIFESTATION_CHANGED,
        entity_type: "memory_entry",
        entity_id: updated.object_id,
        workspace_id: updated.workspace_id,
        run_id: updated.run_id,
        caused_by: TransitionCausedBy.SYSTEM,
        payload_json: SoulMemoryManifestationChangedPayloadSchema.parse({
          object_id: updated.object_id,
          object_kind: updated.object_kind,
          workspace_id: updated.workspace_id,
          run_id: updated.run_id,
          from_state: previousManifestation,
          to_state: manifestationState,
          reason_code: parsedEvent.kind,
          caused_by: TransitionCausedBy.SYSTEM,
          evidence_refs: null,
          occurred_at: now
        })
      });
      events.push(manifestationEvent);
    }

    await this.broadcastEvents(events);

    void this.dependencies.greenService
      ?.reevaluate({
        targetObjectId: updated.object_id,
        workspaceId: updated.workspace_id
      })
      .catch(() => undefined);
  }

  public async computeRetentionScore(memory: Readonly<MemoryEntry>): Promise<number> {
    const karmaSum = await this.dependencies.karmaEventRepo.sumByObjectId(memory.object_id);
    return this.computeRetentionFromKarma(memory, karmaSum, this.now());
  }

  public computeActivationScore(
    memory: Readonly<MemoryEntry>,
    context: {
      readonly currentScopeClass: ScopeClass;
      readonly currentDomainTags: readonly string[];
      readonly now?: string;
    }
  ): number {
    const weights = DYNAMICS_CONSTANTS.activation_weights_phase1b;

    const scopeMatch = memory.scope_class === context.currentScopeClass ? 1 : 0.5;
    const domainMatch = computeDomainMatch(memory.domain_tags, context.currentDomainTags);
    const retention = memory.retention_score ?? 0;
    const freshness = computeFreshnessFactor({
      lastUsedAt: memory.last_used_at,
      createdAt: memory.created_at,
      now: context.now ?? this.now()
    });

    return clamp01(
      scopeMatch * weights.scope_match +
        domainMatch * weights.domain_match +
        retention * weights.retention +
        freshness * weights.freshness
    );
  }

  public determineManifestation(activationScore: number): ManifestationState {
    return determineManifestation(activationScore);
  }

  public async scanRetentionDecay(workspaceId: string): Promise<{
    readonly updated_count: number;
    readonly manifestation_changes: number;
  }> {
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspaceId");
    const now = this.now();
    const memories = await this.dependencies.memoryRepo.findByWorkspaceId(parsedWorkspaceId, StorageTier.HOT);
    const karmaByObjectId = await this.dependencies.karmaEventRepo.sumByObjectIds(
      memories.map((memory) => memory.object_id)
    );

    let updatedCount = 0;
    let manifestationChanges = 0;

    for (const memory of memories) {
      const previousRetention = memory.retention_score ?? 0;
      const previousRetentionState =
        memory.retention_state ??
        this.resolveRetentionState({
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
      const karmaSum = karmaByObjectId[memory.object_id] ?? 0;
      const retentionScore = this.computeRetentionFromKarma(memory, karmaSum, now);
      const retentionState = this.resolveRetentionState({
        memory,
        retentionScore,
        reinforcementCount: memory.reinforcement_count ?? 0,
        lifecycleState: memory.lifecycle_state,
        supersededBy: memory.superseded_by,
        currentRetentionState: previousRetentionState,
        now
      });
      const activationScore = this.computeActivationScore(
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
      const manifestationState = this.determineManifestation(activationScore);

      if (
        !hasScoreChanged(previousRetention, retentionScore) &&
        previousManifestation === manifestationState &&
        previousRetentionState === retentionState
      ) {
        continue;
      }

      // DB-first: write scores before emitting audit events (see processKarmaEvent comment).
      const updated = await this.dependencies.memoryRepo.updateDynamics(
        memory.object_id,
        {
          activation_score: activationScore,
          retention_score: retentionScore,
          manifestation_state: manifestationState,
          retention_state: retentionState
        },
        now
      );

      updatedCount += 1;
      const events: EventLogEntry[] = [];

      if (hasScoreChanged(previousRetention, retentionScore)) {
        const retentionEvent = await this.dependencies.eventLogRepo.append({
          event_type: MemoryGovernanceEventType.SOUL_MEMORY_RETENTION_UPDATED,
          entity_type: "memory_entry",
          entity_id: updated.object_id,
          workspace_id: updated.workspace_id,
          run_id: updated.run_id,
          caused_by: TransitionCausedBy.SYSTEM,
          payload_json: SoulMemoryRetentionUpdatedPayloadSchema.parse({
            object_id: updated.object_id,
            object_kind: updated.object_kind,
            workspace_id: updated.workspace_id,
            run_id: updated.run_id,
            from_state: String(previousRetention),
            to_state: String(retentionScore),
            reason_code: "health_scan",
            caused_by: TransitionCausedBy.SYSTEM,
            evidence_refs: null,
            occurred_at: now,
            retention_score: retentionScore
          })
        });
        events.push(retentionEvent);
      }

      if (previousRetentionState !== retentionState) {
        const stateChangedEvent = await this.dependencies.eventLogRepo.append({
          event_type: MemoryGovernanceEventType.SOUL_MEMORY_STATE_CHANGED,
          entity_type: "memory_entry",
          entity_id: updated.object_id,
          workspace_id: updated.workspace_id,
          run_id: updated.run_id,
          caused_by: TransitionCausedBy.SYSTEM,
          payload_json: SoulMemoryStateChangedPayloadSchema.parse({
            object_id: updated.object_id,
            object_kind: updated.object_kind,
            workspace_id: updated.workspace_id,
            run_id: updated.run_id,
            from_state: previousRetentionState,
            to_state: retentionState,
            reason_code: "health_scan",
            caused_by: TransitionCausedBy.SYSTEM,
            evidence_refs: null,
            occurred_at: now
          })
        });
        events.push(stateChangedEvent);
      }

      if (previousManifestation !== manifestationState) {
        const manifestationEvent = await this.dependencies.eventLogRepo.append({
          event_type: MemoryGovernanceEventType.SOUL_MEMORY_MANIFESTATION_CHANGED,
          entity_type: "memory_entry",
          entity_id: updated.object_id,
          workspace_id: updated.workspace_id,
          run_id: updated.run_id,
          caused_by: TransitionCausedBy.SYSTEM,
          payload_json: SoulMemoryManifestationChangedPayloadSchema.parse({
            object_id: updated.object_id,
            object_kind: updated.object_kind,
            workspace_id: updated.workspace_id,
            run_id: updated.run_id,
            from_state: previousManifestation,
            to_state: manifestationState,
            reason_code: "health_scan",
            caused_by: TransitionCausedBy.SYSTEM,
            evidence_refs: null,
            occurred_at: now
          })
        });
        events.push(manifestationEvent);
        manifestationChanges += 1;
      }

      await this.broadcastEvents(events);
    }

    return {
      updated_count: updatedCount,
      manifestation_changes: manifestationChanges
    };
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
    if (params.lifecycleState === "tombstone") {
      return "tombstoned";
    }

    if (params.lifecycleState === "archived") {
      return params.supersededBy === null ? "archived" : "tombstoned";
    }

    const ageMs = Math.max(0, Date.parse(params.now) - Date.parse(params.memory.created_at));
    const ageDays = ageMs / MS_PER_DAY;

    if (params.retentionScore >= 0.7 && params.reinforcementCount >= 3 && ageDays >= 30) {
      return "canon";
    }

    // Entry threshold: working -> consolidated at retention >= 0.5 (spec: task-4b-2 line 102).
    if (params.retentionScore >= 0.5 && params.reinforcementCount >= 1 && ageDays >= 7) {
      return "consolidated";
    }

    // Hysteresis band: consolidated -> working only when retention drops below 0.4.
    // Prevents rapid flapping for entries hovering near the 0.5 threshold.
    if (params.currentRetentionState === "consolidated" && params.retentionScore >= 0.4) {
      return "consolidated";
    }

    return "working";
  }

  private computeRetentionFromKarma(memory: Readonly<MemoryEntry>, karmaSum: number, now: string): number {
    const decayProfile = memory.decay_profile ?? DIMENSION_DEFAULT_DECAY_PROFILE[memory.dimension];

    return computeRetentionFromProfile({
      decayProfile,
      formationKind: memory.formation_kind,
      karmaSumAmount: karmaSum,
      createdAt: memory.created_at,
      now
    });
  }

  private async broadcastEvents(events: readonly EventLogEntry[]): Promise<void> {
    for (const event of events) {
      await this.dependencies.runtimeNotifier.notifyEntry(event);
    }
  }
}

type KarmaDerivedFieldUpdates = Readonly<{
  readonly last_used_at?: string;
  readonly last_hit_at?: string;
  readonly reinforcement_count?: number;
  readonly contradiction_count?: number;
  readonly superseded_by?: string;
}>;

function deriveKarmaFieldUpdates(
  memory: Readonly<MemoryEntry>,
  event: Readonly<KarmaEvent>
): KarmaDerivedFieldUpdates {
  const now = event.created_at;
  const kind = event.kind;

  return Object.freeze({
    ...(kind === "accept_gain" || kind === "reuse_gain"
      ? {
          reinforcement_count: (memory.reinforcement_count ?? 0) + 1
        }
      : {}),
    ...(kind === "reuse_gain"
      ? {
          last_used_at: now,
          last_hit_at: now
        }
      : {}),
    ...(kind === "supersede_penalty"
      ? {
          contradiction_count: (memory.contradiction_count ?? 0) + 1,
          superseded_by: event.object_id
        }
      : {})
  });
}

function computeDomainMatch(memoryTags: readonly string[], currentTags: readonly string[]): number {
  if (memoryTags.length === 0 || currentTags.length === 0) {
    return 0.5;
  }

  const currentTagSet = new Set(currentTags);
  const hasOverlap = memoryTags.some((tag) => currentTagSet.has(tag));
  return hasOverlap ? 1 : 0.3;
}

function hasScoreChanged(previous: number, next: number): boolean {
  return Math.abs(previous - next) > SCORE_CHANGE_EPSILON;
}

function parseKarmaEventInput(value: KarmaEvent): Readonly<KarmaEvent> {
  try {
    return Object.freeze(parseProtocolKarmaEvent(value));
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid karma event payload", { cause: error });
  }
}

function parseDimension(value: MemoryDimension): MemoryDimension {
  if (
    value === "preference" ||
    value === "constraint" ||
    value === "decision" ||
    value === "procedure" ||
    value === "fact" ||
    value === "hazard" ||
    value === "glossary" ||
    value === "episode"
  ) {
    return value;
  }

  throw new CoreError("VALIDATION", "Invalid memory dimension");
}

function parseFormationKind(value: MemoryEntry["formation_kind"]): MemoryEntry["formation_kind"] {
  if (
    value === "extracted" ||
    value === "explicit" ||
    value === "imported"
  ) {
    return value;
  }

  throw new CoreError("VALIDATION", "Invalid formation kind");
}

function confidenceByFormationKind(kind: MemoryEntry["formation_kind"]): number {
  return FORMATION_CONFIDENCE_MAP[kind];
}

function assertActivationWeightsSumToOne(
  weights: Readonly<Record<"scope_match" | "domain_match" | "retention" | "freshness", number>>
): void {
  const sum = weights.scope_match + weights.domain_match + weights.retention + weights.freshness;

  if (Math.abs(sum - 1) > ACTIVATION_WEIGHT_SUM_EPSILON) {
    throw new CoreError("VALIDATION", `activation_weights_phase1b must sum to 1.0, got ${sum}`);
  }
}