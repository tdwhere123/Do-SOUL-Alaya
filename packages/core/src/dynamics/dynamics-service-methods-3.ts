
import {
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
  type RetentionState} from "@do-soul/alaya-protocol";


import { CoreError } from "../shared/errors.js";

import {
  DIMENSION_DEFAULT_DECAY_PROFILE,
  MS_PER_DAY,
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

export async function dynamicsServiceScanRetentionDecay(owner: DynamicsServiceMethodOwner, workspaceId: string): Promise<{
    readonly updated_count: number;
    readonly manifestation_changes: number;
  }> {
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspaceId");
    const now = owner.now();
    const memories = await collectWorkspaceMemories(owner.dependencies.memoryRepo, parsedWorkspaceId, StorageTier.HOT);
    const karmaByObjectId = await owner.dependencies.karmaEventRepo.sumByObjectIds(
      memories.map((memory) => memory.object_id)
    );

    let updatedCount = 0;
    let manifestationChanges = 0;

    for (const memory of memories) {
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
      const karmaSum = karmaByObjectId[memory.object_id] ?? 0;
      const retentionScore = owner.computeRetentionFromKarma(memory, karmaSum, now);
      const retentionState = owner.resolveRetentionState({
        memory,
        retentionScore,
        reinforcementCount: memory.reinforcement_count ?? 0,
        lifecycleState: memory.lifecycle_state,
        supersededBy: memory.superseded_by,
        currentRetentionState: previousRetentionState,
        now
      });
      const activationScore = owner.computeActivationScore(
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
      const manifestationState = owner.determineManifestation(activationScore);

      if (
        !hasScoreChanged(previousRetention, retentionScore) &&
        previousManifestation === manifestationState &&
        previousRetentionState === retentionState
      ) {
        continue;
      }

      // DB-first: write scores before emitting audit events (see processKarmaEvent comment).
      const updated = await owner.dependencies.memoryRepo.updateDynamics(
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
        const retentionEvent = await owner.dependencies.eventLogRepo.append({
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
        const stateChangedEvent = await owner.dependencies.eventLogRepo.append({
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
        const manifestationEvent = await owner.dependencies.eventLogRepo.append({
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

      await owner.broadcastEvents(events);
    }

    return {
      updated_count: updatedCount,
      manifestation_changes: manifestationChanges
    };
  }

export function dynamicsServiceResolveRetentionState(owner: DynamicsServiceMethodOwner, params: {
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

export function dynamicsServiceComputeRetentionFromKarma(owner: DynamicsServiceMethodOwner, memory: Readonly<MemoryEntry>, karmaSum: number, now: string): number {
    const decayProfile = memory.decay_profile ?? DIMENSION_DEFAULT_DECAY_PROFILE[memory.dimension];

    return computeRetentionFromProfile({
      decayProfile,
      formationKind: memory.formation_kind,
      karmaSumAmount: karmaSum,
      createdAt: memory.created_at,
      now
    });
  }
