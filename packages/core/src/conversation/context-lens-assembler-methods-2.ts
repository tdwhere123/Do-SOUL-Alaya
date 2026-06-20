import { randomUUID } from "node:crypto";

import {
  BankruptcyAction,
  BankruptcyTriggerKind,
  ControlPlaneObjectKind,
  ContextLensSchema,
  EnforcementLevel,
  ObjectKind,
  RecallContextEventType,
  BudgetEventType,
  RetentionPolicy,
  RuntimeMode,
  ScopeClass,
  SoulBudgetDegradedPayloadSchema,
  SoulContextLensAssembledPayloadSchema,
  WorkingProjectionSchema,
  type BankruptcyAction as BankruptcyActionValue,
  type BankruptcyTriggerKind as BankruptcyTriggerKindValue,
  type ClaimForm,
  type ContextLens,
  type ContextLensEntry,
  type EventLogEntry,
  type LensAssemblerDegradationPort,
  type LensDegradationResult,
  type MemoryEntry,
  type RecallPolicy,
  type RuntimeMode as RuntimeModeValue,
  type Run,
  type SessionOverride,
  type Slot,
  type TaskObjectSurface,
  type WorkingProjection
} from "@do-soul/alaya-protocol";

import type { RecallCandidate, RecallResult } from "../recall/recall-service.js";

import { makeTokenEstimator, type TokenEstimator } from "../recall/recall-service-types.js";

import type { NodeStrategy } from "./task-surface-builder.js";
type ContextLensAssemblerMethodOwner = {
  lensStore: any;
  generateRuntimeId: () => string;
  now: () => string;
  warn: LensAssemblerWarnPort;
  hasWarnedMissingOverrideService: any;
  dependencies: LensAssemblerDependencies;
  [key: string]: any;
};


const MAX_LENS_STORE_SIZE = 200;

export interface LensAssemblerRecallPort {
  recall(params: {
    readonly taskSurface: Readonly<TaskObjectSurface>;
    readonly workspaceId: string;
    readonly strategy: NodeStrategy;
    readonly runId?: string | null;
    readonly policyOverride?: Readonly<RecallPolicy>;
  }): Promise<RecallResult>;
  buildDefaultPolicy?(
    strategy: NodeStrategy,
    taskSurfaceRef: string
  ): Readonly<RecallPolicy>;
}

export interface LensAssemblerTaskSurfacePort {
  build(params: {
    readonly run: Pick<Run, "run_id" | "workspace_id" | "run_mode" | "title">;
    readonly surfaceId: string | null;
    readonly displayName?: string;
    readonly contextRefs?: readonly string[];
  }): Promise<Readonly<TaskObjectSurface>>;
  resolveStrategy(surfaceKind: string): NodeStrategy;
}

export interface LensAssemblerSlotRepoPort {
  findByWorkspace(workspaceId: string): Promise<readonly Readonly<Slot>[]>;
}

export interface LensAssemblerClaimRepoPort {
  findByIds(objectIds: readonly string[]): Promise<readonly Readonly<ClaimForm>[]>;
}

export interface LensAssemblerMemoryRepoPort {
  findById(objectId: string): Promise<Readonly<MemoryEntry> | null>;
  findByIds?(objectIds: readonly string[]): Promise<readonly Readonly<MemoryEntry>[]>;
}

export interface LensAssemblerEventLogRepoPort {
  append(entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">): EventLogEntry | Promise<EventLogEntry>;
  queryByEntity(entityType: string, entityId: string): Promise<readonly EventLogEntry[]>;
}

export interface LensAssemblerOverridePort {
  getActiveFor(runId: string): Promise<readonly Readonly<SessionOverride>[]>;
}

export interface LensAssemblerWarnPort {
  (message: string, meta: Record<string, unknown>): void;
}

export interface LensAssemblerBankruptcyPort {
  declare(params: {
    readonly runId: string;
    readonly workspaceId: string;
    readonly triggerKind: BankruptcyTriggerKindValue;
    readonly triggerSummary: string;
    readonly taskSurfaceRef: string | null;
    readonly taskSurfaceExpiresAt: string | null;
    readonly currentMode: RuntimeModeValue;
    readonly protectedConstraints: readonly string[];
    readonly droppedCandidates: readonly string[];
    readonly unresolvedConflicts: readonly string[];
    readonly requiredActions: readonly BankruptcyActionValue[];
    readonly tokensUsed?: number;
    readonly maxTotalTokens?: number;
  }): Promise<unknown>;
}

export interface LensAssemblerDependencies {
  readonly recallService: LensAssemblerRecallPort;
  readonly taskSurfaceBuilder: LensAssemblerTaskSurfacePort;
  readonly slotRepo: LensAssemblerSlotRepoPort;
  readonly claimRepo: LensAssemblerClaimRepoPort;
  readonly memoryRepo: LensAssemblerMemoryRepoPort;
  readonly eventLogRepo: LensAssemblerEventLogRepoPort;
  readonly overrideService?: LensAssemblerOverridePort;
  readonly degradationPipeline?: LensAssemblerDegradationPort;
  readonly bankruptcyService?: LensAssemblerBankruptcyPort;
  readonly generateRuntimeId?: () => string;
  readonly now?: () => string;
  readonly warn?: LensAssemblerWarnPort;
}

export interface AssembleResult {
  readonly contextLens: Readonly<ContextLens>;
  readonly taskSurface: Readonly<TaskObjectSurface>;
  readonly workingProjection: Readonly<WorkingProjection>;
}

interface DegradationApplicationResult {
  readonly contextLens: Readonly<ContextLens>;
  readonly workingProjection: Readonly<WorkingProjection>;
  readonly degradationResult: LensDegradationResult;
  readonly tokensAfterDegradation: number;
  readonly stillOverBudgetAfterDegradation: boolean;
}

interface DegradationApplicationParams {
  readonly taskSurface: Readonly<TaskObjectSurface>;
  readonly contextLens: Readonly<ContextLens>;
  readonly workingProjection: Readonly<WorkingProjection>;
  readonly recallResult: RecallResult;
  readonly strictWinners: readonly Readonly<ClaimForm>[];
  readonly recalledMemories: ReadonlyMap<string, Readonly<MemoryEntry>>;
  readonly recallPolicyRuntimeId: string | null;
  readonly activeOverrides: readonly Readonly<SessionOverride>[];
  readonly policyBudget: number;
  readonly run: Pick<Run, "run_id" | "workspace_id" | "run_mode" | "title">;
  readonly runtimeMode: RuntimeModeValue;
  readonly occurredAt: string;
  readonly degradationPipeline: LensAssemblerDegradationPort;
}

interface PreparedAssemblyState {
  readonly taskSurface: Readonly<TaskObjectSurface>;
  readonly recallPolicy: Readonly<RecallPolicy> | null;
  readonly recallResult: RecallResult;
  readonly strictWinners: readonly Readonly<ClaimForm>[];
  readonly recalledMemories: ReadonlyMap<string, Readonly<MemoryEntry>>;
  readonly activeOverrides: readonly Readonly<SessionOverride>[];
  readonly contextLens: Readonly<ContextLens>;
  readonly workingProjection: Readonly<WorkingProjection>;
}

function createLensEntry(
  objectId: string,
  objectKind: string,
  relevanceScore: number,
  manifestation: ContextLensEntry["manifestation"],
  options?: {
    readonly scopeClass?: ContextLensEntry["scope_class"];
    readonly sourceEnforcement?: ContextLensEntry["source_enforcement"];
  }
): ContextLensEntry {
  return {
    object_id: objectId,
    object_kind: objectKind,
    relevance_score: relevanceScore,
    manifestation,
    scope_class: options?.scopeClass,
    source_enforcement: options?.sourceEnforcement
  };
}

function compareRecallCandidates(left: Readonly<RecallCandidate>, right: Readonly<RecallCandidate>): number {
  const activationDelta = right.activation_score - left.activation_score;
  if (activationDelta !== 0) {
    return activationDelta;
  }

  return left.object_id.localeCompare(right.object_id);
}

const EXCERPT_CONTENT_RATIO = 0.35;

function createExcerptContent(content: string): string {
  const targetLength = Math.max(1, Math.ceil(content.length * EXCERPT_CONTENT_RATIO));

  if (content.length <= targetLength) {
    return content;
  }

  const sliceLength = Math.max(1, targetLength - 3);
  return `${content.slice(0, sliceLength).trimEnd()}...`;
}

export async function contextLensAssemblerLoadRecalledMemories(owner: ContextLensAssemblerMethodOwner, candidates: readonly Readonly<RecallCandidate>[]): Promise<ReadonlyMap<string, Readonly<MemoryEntry>>> {
    const objectIds = [...new Set(candidates.map((candidate) => candidate.object_id))];
    if (objectIds.length === 0) {
      return new Map();
    }

    if (owner.dependencies.memoryRepo.findByIds !== undefined) {
      const memories = await owner.dependencies.memoryRepo.findByIds(objectIds);
      const memoryById = new Map(memories.map((memory) => [memory.object_id, memory] as const));
      return new Map(
        objectIds.flatMap((objectId) => {
          const memory = memoryById.get(objectId);
          return memory === undefined ? [] : [[objectId, memory] as const];
        })
      );
    }

    const entries = await Promise.all(
      objectIds.map(async (objectId) => {
        const memory = await owner.dependencies.memoryRepo.findById(objectId);
        return memory === null ? null : ([objectId, memory] as const);
      })
    );

    return new Map(entries.filter((entry): entry is readonly [string, Readonly<MemoryEntry>] => entry !== null));
  }

export function contextLensAssemblerBuildLensEntries(owner: ContextLensAssemblerMethodOwner, taskSurface: Readonly<TaskObjectSurface>, recallResult: RecallResult, strictWinners: readonly Readonly<ClaimForm>[], recalledMemories: ReadonlyMap<string, Readonly<MemoryEntry>>, activeOverrides: readonly Readonly<SessionOverride>[]): readonly Readonly<ContextLensEntry>[] {
    const overrideEntries = owner.buildOverrideEntries(activeOverrides);
    const taskSurfaceEntries = [
      createLensEntry(taskSurface.runtime_id, ControlPlaneObjectKind.TASK_OBJECT_SURFACE, 1, "full_eligible"),
      createLensEntry(taskSurface.runtime_id, ControlPlaneObjectKind.TASK_OBJECT_SURFACE, 0.9, "full_eligible")
    ];
    const strictWinnerEntries = strictWinners.map((claim) =>
      createLensEntry(claim.object_id, ObjectKind.CLAIM_FORM, 1, "full_eligible", {
        scopeClass: claim.scope_class,
        sourceEnforcement: claim.enforcement_level
      })
    );
    const projectCandidates = recallResult.candidates
      .filter((candidate) => candidate.scope_class === ScopeClass.PROJECT)
      .sort(compareRecallCandidates);
    const projectEntries = projectCandidates.map((candidate) =>
      createLensEntry(candidate.object_id, ObjectKind.MEMORY_ENTRY, candidate.relevance_score, candidate.manifestation, {
        scopeClass: candidate.scope_class
      })
    );
    const globalCandidates = recallResult.candidates
      .filter(
        (candidate) =>
          candidate.scope_class === ScopeClass.GLOBAL_DOMAIN || candidate.scope_class === ScopeClass.GLOBAL_CORE
      )
      .sort(compareRecallCandidates);
    const globalEntries = globalCandidates.map((candidate) =>
      createLensEntry(candidate.object_id, ObjectKind.MEMORY_ENTRY, candidate.relevance_score, candidate.manifestation, {
        scopeClass: candidate.scope_class
      })
    );
    const evidenceEntries = [...new Set([...projectCandidates, ...globalCandidates].flatMap((candidate) => {
      const memory = recalledMemories.get(candidate.object_id);
      return memory?.evidence_refs ?? [];
    }))].map((evidenceRef) => createLensEntry(evidenceRef, ObjectKind.EVIDENCE_CAPSULE, 0.25, "hint"));

    return Object.freeze([
      ...overrideEntries,
      ...taskSurfaceEntries,
      ...strictWinnerEntries,
      ...projectEntries,
      ...globalEntries,
      ...evidenceEntries
    ]);
  }

export function contextLensAssemblerBuildOverrideEntries(owner: ContextLensAssemblerMethodOwner, activeOverrides: readonly Readonly<SessionOverride>[]): readonly Readonly<ContextLensEntry>[] {
    return Object.freeze(
      activeOverrides.map((override) =>
        createLensEntry(
          override.runtime_id,
          ControlPlaneObjectKind.SESSION_OVERRIDE,
          1,
          "full_eligible"
        )
      )
    );
  }

export function contextLensAssemblerBuildWorkingProjection(owner: ContextLensAssemblerMethodOwner, taskSurface: Readonly<TaskObjectSurface>, contextLens: Readonly<ContextLens>, recallResult: RecallResult, strictWinners: readonly Readonly<ClaimForm>[], recalledMemories: ReadonlyMap<string, Readonly<MemoryEntry>>, recallPolicyRef: string | null, activeOverrides: readonly Readonly<SessionOverride>[], tokenEstimator: TokenEstimator = makeTokenEstimator()): Readonly<WorkingProjection> {
    let taskSurfaceEntryIndex = 0;
    const strictWinnerMap = new Map(strictWinners.map((claim) => [claim.object_id, claim] as const));
    const recallCandidateMap = new Map(recallResult.candidates.map((candidate) => [candidate.object_id, candidate] as const));
    const overrideMap = new Map(activeOverrides.map((override) => [override.runtime_id, override] as const));

    const entries = contextLens.lens_entries.map((entry) => {
      const contentSnapshot = owner.resolveContentSnapshot(
        entry,
        taskSurface,
        taskSurfaceEntryIndex,
        strictWinnerMap,
        recallCandidateMap,
        recalledMemories,
        overrideMap
      );

      if (entry.object_kind === ControlPlaneObjectKind.TASK_OBJECT_SURFACE) {
        taskSurfaceEntryIndex += 1;
      }

      return {
        object_id: entry.object_id,
        object_kind: entry.object_kind,
        content_snapshot: contentSnapshot,
        token_estimate: tokenEstimator.estimate(contentSnapshot)
      };
    });
    const totalTokenEstimate = entries.reduce((sum, entry) => sum + entry.token_estimate, 0);

    return WorkingProjectionSchema.parse({
      runtime_id: owner.generateRuntimeId(),
      object_kind: ControlPlaneObjectKind.WORKING_PROJECTION,
      task_surface_ref: taskSurface.runtime_id,
      expires_at: taskSurface.expires_at,
      derived_from: contextLens.runtime_id,
      retention_policy: RetentionPolicy.SESSION_ONLY,
      entries,
      total_token_estimate: totalTokenEstimate,
      recall_policy_ref: recallPolicyRef
    });
  }

export function contextLensAssemblerResolveContentSnapshot(owner: ContextLensAssemblerMethodOwner, entry: Readonly<ContextLensEntry>, taskSurface: Readonly<TaskObjectSurface>, taskSurfaceEntryIndex: number, strictWinnerMap: ReadonlyMap<string, Readonly<ClaimForm>>, recallCandidateMap: ReadonlyMap<string, Readonly<RecallCandidate>>, recalledMemories: ReadonlyMap<string, Readonly<MemoryEntry>>, overrideMap: ReadonlyMap<string, Readonly<SessionOverride>>): string {
    if (entry.object_kind === ControlPlaneObjectKind.SESSION_OVERRIDE) {
      const override = overrideMap.get(entry.object_id);
      return override === undefined
        ? `[session_override: ${entry.object_id}]`
        : `Override ${override.target_object}: ${override.correction}`;
    }

    if (entry.object_kind === ControlPlaneObjectKind.TASK_OBJECT_SURFACE) {
      if (entry.manifestation === "hint") {
        return `[task surface ref: ${taskSurface.runtime_id}]`;
      }

      if (entry.manifestation === "excerpt") {
        return taskSurfaceEntryIndex === 0
          ? `Goal ref: ${taskSurface.display_name}`
          : `Surface ref: ${taskSurface.runtime_id}`;
      }

      return taskSurfaceEntryIndex === 0
        ? `Goal: ${taskSurface.display_name}`
        : `Surface ${taskSurface.surface_kind}: ${taskSurface.display_name}`;
    }

    if (entry.object_kind === ObjectKind.CLAIM_FORM) {
      if (entry.manifestation === "hint") {
        return `[claim ref: ${entry.object_id}]`;
      }

      const proposition = strictWinnerMap.get(entry.object_id)?.proposition_digest ?? `[claim ref: ${entry.object_id}]`;
      return entry.manifestation === "excerpt" ? createExcerptContent(proposition) : proposition;
    }

    if (entry.object_kind === ObjectKind.MEMORY_ENTRY) {
      if (entry.manifestation === "hint") {
        return `[memory ref: ${entry.object_id}]`;
      }

      const memory = recalledMemories.get(entry.object_id);
      if (entry.manifestation === "excerpt") {
        return recallCandidateMap.get(entry.object_id)?.content_preview ?? createExcerptContent(memory?.content ?? `[memory ref: ${entry.object_id}]`);
      }

      if (memory !== undefined) {
        return memory.content;
      }

      return recallCandidateMap.get(entry.object_id)?.content_preview ?? `[memory ref: ${entry.object_id}]`;
    }

    if (entry.object_kind === ObjectKind.EVIDENCE_CAPSULE) {
      return `[evidence ref: ${entry.object_id}]`;
    }

    if (entry.manifestation === "hint") {
      return `[${entry.object_kind} ref: ${entry.object_id}]`;
    }

    return `[${entry.object_kind}: ${entry.object_id}]`;
  }

export function contextLensAssemblerPruneLensStore(owner: ContextLensAssemblerMethodOwner, referenceTime: string): void {
    const referenceMs = Date.parse(referenceTime);

    if (!Number.isFinite(referenceMs)) {
      return;
    }

    for (const [runId, lens] of owner.lensStore) {
      const expiresAtMs = lens.expires_at === null ? Number.NaN : Date.parse(lens.expires_at);

      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= referenceMs) {
        owner.lensStore.delete(runId);
      }
    }
  }

export function contextLensAssemblerTrimLensStore(owner: ContextLensAssemblerMethodOwner): void {
    while (owner.lensStore.size > MAX_LENS_STORE_SIZE) {
      const oldestRunId = owner.lensStore.keys().next().value;

      if (oldestRunId === undefined) {
        return;
      }

      owner.lensStore.delete(oldestRunId);
    }
  }

export function contextLensAssemblerResolveMissingOverrideService(owner: ContextLensAssemblerMethodOwner, runId: string, workspaceId: string): readonly Readonly<SessionOverride>[] {
    if (!owner.hasWarnedMissingOverrideService) {
      owner.hasWarnedMissingOverrideService = true;
      owner.warn("[ContextLensAssembler] overrideService missing; session overrides will not be projected.", {
        runId,
        workspaceId
      });
    }

    return Object.freeze([]);
  }
