
import {
  DYNAMICS_CONSTANTS,
  FORMATION_CONFIDENCE_MAP,
  MemoryGovernanceEventType,
  SoulMemoryStateChangedPayloadSchema,
  StorageTier,
  TransitionCausedBy,
  parseKarmaEvent as parseProtocolKarmaEvent,
  type EventLogEntry,
  type KarmaEvent,
  type KarmaEventKind,
  type ManifestationState,
  type MemoryDimension,
  type MemoryEntry,
  type RetentionState} from "@do-soul/alaya-protocol";


import { CoreError } from "../shared/errors.js";

import {
  DIMENSION_DEFAULT_DECAY_PROFILE,
  INITIAL_ACTIVATION_FROM_CONFIDENCE_FACTOR,
  clamp01,
  determineManifestation
} from "./dynamics-constants-runtime.js";

type DynamicsServiceMethodOwner = {
  now: () => string;
  generateEventId: () => string;
  dependencies: DynamicsServiceDependencies;
  [key: string]: any;
};


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
    value === "inferred" ||
    value === "derived" ||
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

async function collectWorkspaceMemories(
  memoryRepo: DynamicsServiceMemoryRepoPort,
  workspaceId: string,
  tier: StorageTier
): Promise<readonly Readonly<MemoryEntry>[]> {
  if (memoryRepo.findByWorkspaceIdAll !== undefined) {
    return await memoryRepo.findByWorkspaceIdAll(workspaceId, tier);
  }

  const rows: Readonly<MemoryEntry>[] = [];
  for (let offset = 0; ; offset += DYNAMICS_MEMORY_SCAN_PAGE_LIMIT) {
    const page = await memoryRepo.findByWorkspaceId(workspaceId, tier, {
      limit: DYNAMICS_MEMORY_SCAN_PAGE_LIMIT,
      offset
    });
    rows.push(...page);
    if (page.length < DYNAMICS_MEMORY_SCAN_PAGE_LIMIT) {
      break;
    }
  }
  return Object.freeze(rows);
}

export async function dynamicsServiceEmitKarmaEvent(owner: DynamicsServiceMethodOwner, input: {
    readonly kind: KarmaEventKind;
    readonly objectId: string;
    readonly workspaceId: string;
    readonly amount?: number;
    readonly runId?: string | null;
  }): Promise<void> {
    const amount = input.amount ?? DYNAMICS_CONSTANTS.karma[input.kind];
    await owner.processKarmaEvent({
      event_id: owner.generateEventId(),
      kind: input.kind,
      object_id: input.objectId,
      amount,
      created_at: owner.now(),
      workspace_id: input.workspaceId,
      run_id: input.runId ?? null
    });
  }

export function dynamicsServiceAssignInitialDynamics(owner: DynamicsServiceMethodOwner, params: {
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

export async function dynamicsServiceProcessKarmaEvent(owner: DynamicsServiceMethodOwner, event: KarmaEvent): Promise<void> {
    const parsedEvent = parseKarmaEventInput(event);
    const memory = await owner.dependencies.memoryRepo.findById(parsedEvent.object_id);

    if (memory === null) {
      throw new CoreError("NOT_FOUND", `Memory entry not found: ${parsedEvent.object_id}`);
    }

    await owner.dependencies.karmaEventRepo.create(parsedEvent);
    const karmaSum = await owner.dependencies.karmaEventRepo.sumByObjectId(parsedEvent.object_id);
    const transition = owner.computeKarmaTransition(memory, parsedEvent, karmaSum, owner.now());
    const updated = await owner.applyKarmaTransition(memory, transition);
    const revived = await owner.reviveDormantMemoryFromKarma(memory, parsedEvent, transition.now);
    const events = await owner.appendKarmaTransitionEvents(updated, parsedEvent, transition, revived);

    await owner.broadcastEvents(events);
    owner.scheduleGreenReevaluation(updated);
  }

export function dynamicsServiceComputeKarmaTransition(owner: DynamicsServiceMethodOwner, memory: Readonly<MemoryEntry>, parsedEvent: Readonly<KarmaEvent>, karmaSum: number, now: string): KarmaTransitionComputation {
    const previousRetention = memory.retention_score ?? 0;
    const previousRetentionState =
      memory.retention_state ??
      owner.resolveRetentionState({
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
    const retentionScore = owner.computeRetentionFromKarma(memory, karmaSum, now);
    const fieldUpdates = deriveKarmaFieldUpdates(memory, parsedEvent);
    const retentionState = owner.resolveRetentionState({
      memory,
      retentionScore,
      reinforcementCount: fieldUpdates.reinforcement_count ?? memory.reinforcement_count ?? 0,
      lifecycleState: memory.lifecycle_state,
      supersededBy: fieldUpdates.superseded_by ?? memory.superseded_by,
      currentRetentionState: previousRetentionState,
      now
    });
    const activationScore = owner.computeActivationScore(
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
      manifestationState: owner.determineManifestation(activationScore),
      fieldUpdates
    };
  }

export async function dynamicsServiceApplyKarmaTransition(owner: DynamicsServiceMethodOwner, memory: Readonly<MemoryEntry>, transition: KarmaTransitionComputation): Promise<Readonly<MemoryEntry>> {
    return await owner.dependencies.memoryRepo.updateDynamics(
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

export async function dynamicsServiceReviveDormantMemoryFromKarma(owner: DynamicsServiceMethodOwner, memory: Readonly<MemoryEntry>, parsedEvent: Readonly<KarmaEvent>, now: string): Promise<boolean> {
    if (parsedEvent.amount <= 0) {
      return false;
    }

    const reviveDormant = owner.dependencies.memoryRepo.reviveDormant;
    if (reviveDormant !== undefined) {
      const revivedRow = await reviveDormant(memory.object_id, now);
      return revivedRow !== null;
    }

    if (memory.lifecycle_state === "dormant" && owner.dependencies.memoryRepo.transitionLifecycle !== undefined) {
      await owner.dependencies.memoryRepo.transitionLifecycle(memory.object_id, "active", now);
      return true;
    }

    return false;
  }

export async function dynamicsServiceAppendKarmaTransitionEvents(owner: DynamicsServiceMethodOwner, updated: Readonly<MemoryEntry>, parsedEvent: Readonly<KarmaEvent>, transition: KarmaTransitionComputation, revived: boolean): Promise<EventLogEntry[]> {
    const events: EventLogEntry[] = [];

    if (revived) {
      events.push(await owner.appendMemoryRevivalEvent(updated, parsedEvent, transition.now));
    }

    if (hasScoreChanged(transition.previousRetention, transition.retentionScore)) {
      events.push(await owner.appendRetentionUpdatedEvent(updated, parsedEvent, transition));
    }

    if (transition.previousRetentionState !== transition.retentionState) {
      events.push(await owner.appendRetentionStateChangedEvent(updated, parsedEvent, transition));
    }

    if (transition.previousManifestation !== transition.manifestationState) {
      events.push(await owner.appendManifestationChangedEvent(updated, parsedEvent, transition));
    }

    return events;
  }

export async function dynamicsServiceAppendMemoryRevivalEvent(owner: DynamicsServiceMethodOwner, updated: Readonly<MemoryEntry>, parsedEvent: Readonly<KarmaEvent>, now: string): Promise<EventLogEntry> {
    return await owner.dependencies.eventLogRepo.append({
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
        from_state: "dormant",
        to_state: "active",
        reason_code: parsedEvent.kind,
        caused_by: TransitionCausedBy.SYSTEM,
        evidence_refs: null,
        occurred_at: now
      })
    });
  }
