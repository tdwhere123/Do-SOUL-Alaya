import { randomUUID } from "node:crypto";

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
  type KarmaEventKind,
  type ManifestationState,
  type MemoryDimension,
  type MemoryEntry,
  type RetentionState,
  type ScopeClass
} from "@do-soul/alaya-protocol";

import { scheduleAuditedAsyncSideEffect } from "../runtime/async-side-effect-auditor.js";

import { CoreError } from "../shared/errors.js";

import {
  DIMENSION_DEFAULT_DECAY_PROFILE,
  INITIAL_ACTIVATION_FROM_CONFIDENCE_FACTOR,
  MS_PER_DAY,
  clamp01,
  computeFreshnessFactor,
  computeRetentionFromProfile,
  determineManifestation
} from "./dynamics-constants-runtime.js";

import { parseNonEmptyString } from "../shared/validators.js";
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

export async function dynamicsServiceAppendRetentionUpdatedEvent(owner: DynamicsServiceMethodOwner, updated: Readonly<MemoryEntry>, parsedEvent: Readonly<KarmaEvent>, transition: KarmaTransitionComputation): Promise<EventLogEntry> {
    return await owner.dependencies.eventLogRepo.append({
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
        from_state: String(transition.previousRetention),
        to_state: String(transition.retentionScore),
        reason_code: parsedEvent.kind,
        caused_by: TransitionCausedBy.SYSTEM,
        evidence_refs: null,
        occurred_at: transition.now,
        retention_score: transition.retentionScore
      })
    });
  }

export async function dynamicsServiceAppendRetentionStateChangedEvent(owner: DynamicsServiceMethodOwner, updated: Readonly<MemoryEntry>, parsedEvent: Readonly<KarmaEvent>, transition: KarmaTransitionComputation): Promise<EventLogEntry> {
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
        from_state: transition.previousRetentionState,
        to_state: transition.retentionState,
        reason_code: parsedEvent.kind,
        caused_by: TransitionCausedBy.SYSTEM,
        evidence_refs: null,
        occurred_at: transition.now
      })
    });
  }

export async function dynamicsServiceAppendManifestationChangedEvent(owner: DynamicsServiceMethodOwner, updated: Readonly<MemoryEntry>, parsedEvent: Readonly<KarmaEvent>, transition: KarmaTransitionComputation): Promise<EventLogEntry> {
    return await owner.dependencies.eventLogRepo.append({
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
        from_state: transition.previousManifestation,
        to_state: transition.manifestationState,
        reason_code: parsedEvent.kind,
        caused_by: TransitionCausedBy.SYSTEM,
        evidence_refs: null,
        occurred_at: transition.now
      })
    });
  }

export function dynamicsServiceScheduleGreenReevaluation(owner: DynamicsServiceMethodOwner, updated: Readonly<MemoryEntry>): void {
    scheduleAuditedAsyncSideEffect(
      owner.dependencies.greenService?.reevaluate({
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
        eventLogRepo: owner.dependencies.eventLogRepo,
        runtimeNotifier: owner.dependencies.runtimeNotifier,
        now: owner.now
      }
    );
  }

export async function dynamicsServiceComputeRetentionScore(owner: DynamicsServiceMethodOwner, memory: Readonly<MemoryEntry>): Promise<number> {
    const karmaSum = await owner.dependencies.karmaEventRepo.sumByObjectId(memory.object_id);
    return owner.computeRetentionFromKarma(memory, karmaSum, owner.now());
  }

export function dynamicsServiceComputeActivationScore(owner: DynamicsServiceMethodOwner, memory: Readonly<MemoryEntry>, context: {
      readonly currentScopeClass: ScopeClass;
      readonly currentDomainTags: readonly string[];
      readonly now?: string;
    }): number {
    const weights = DYNAMICS_CONSTANTS.activation_weights_phase1b;

    const scopeMatch = memory.scope_class === context.currentScopeClass ? 1 : 0.5;
    const domainMatch = computeDomainMatch(memory.domain_tags, context.currentDomainTags);
    const retention = memory.retention_score ?? 0;
    const freshness = computeFreshnessFactor({
      lastUsedAt: memory.last_used_at,
      createdAt: memory.created_at,
      now: context.now ?? owner.now()
    });

    return clamp01(
      scopeMatch * weights.scope_match +
        domainMatch * weights.domain_match +
        retention * weights.retention +
        freshness * weights.freshness
    );
  }

export function dynamicsServiceDetermineManifestation(owner: DynamicsServiceMethodOwner, activationScore: number): ManifestationState {
    return determineManifestation(activationScore);
  }
