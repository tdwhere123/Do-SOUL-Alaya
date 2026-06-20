
import {
  BankruptcyAction,
  BankruptcyTriggerKind,
  ControlPlaneObjectKind,
  ContextLensSchema,
  EnforcementLevel,
  RecallContextEventType,
  BudgetEventType,
  RetentionPolicy,
  RuntimeMode,
  SoulBudgetDegradedPayloadSchema,
  SoulContextLensAssembledPayloadSchema,
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

export async function contextLensAssemblerAssemble(owner: ContextLensAssemblerMethodOwner, params: {
    readonly run: Pick<Run, "run_id" | "workspace_id" | "run_mode" | "title">;
    readonly surfaceId: string | null;
    readonly displayName?: string;
    readonly runtimeMode?: RuntimeModeValue;
  }): Promise<AssembleResult> {
    const occurredAt = owner.now();
    owner.pruneLensStore(occurredAt);

    const prepared = await owner.prepareAssemblyState(params);
    const {
      taskSurface,
      recallPolicy,
      recallResult,
      strictWinners,
      recalledMemories,
      activeOverrides
    } = prepared;
    let { contextLens, workingProjection } = prepared;

    const policyBudget = recallPolicy?.fine_assessment.budgets.max_total_tokens ?? null;

    const degradationPipeline = owner.dependencies.degradationPipeline;
    if (
      degradationPipeline !== undefined &&
      policyBudget !== null &&
      workingProjection.total_token_estimate > policyBudget
    ) {
      const degradationApplication = await owner.applyDegradation({
        taskSurface,
        contextLens,
        workingProjection,
        recallResult,
        strictWinners,
        recalledMemories,
        recallPolicyRuntimeId: recallPolicy?.runtime_id ?? null,
        activeOverrides,
        policyBudget,
        run: params.run,
        runtimeMode: params.runtimeMode ?? RuntimeMode.FULL,
        occurredAt,
        degradationPipeline
      });
      contextLens = degradationApplication.contextLens;
      workingProjection = degradationApplication.workingProjection;
    }
    await owner.dependencies.eventLogRepo.append({
      event_type: RecallContextEventType.SOUL_CONTEXT_LENS_ASSEMBLED,
      entity_type: "context_lens",
      entity_id: contextLens.runtime_id,
      workspace_id: params.run.workspace_id,
      run_id: params.run.run_id,
      caused_by: "system",
      payload_json: SoulContextLensAssembledPayloadSchema.parse({
        runtime_id: contextLens.runtime_id,
        task_surface_ref: taskSurface.runtime_id,
        lens_entry_count: contextLens.lens_entries.length,
        total_token_estimate: workingProjection.total_token_estimate,
        run_id: params.run.run_id,
        workspace_id: params.run.workspace_id,
        occurred_at: occurredAt
      })
    });

    owner.lensStore.delete(params.run.run_id);
    owner.lensStore.set(params.run.run_id, contextLens);
    owner.trimLensStore();

    return {
      contextLens,
      taskSurface,
      workingProjection
    };
  }

export function contextLensAssemblerGetLastLens(owner: ContextLensAssemblerMethodOwner, runId: string): Readonly<ContextLens> | null {
    owner.pruneLensStore(owner.now());
    return owner.lensStore.get(runId) ?? null;
  }

export function contextLensAssemblerClearLens(owner: ContextLensAssemblerMethodOwner, runId: string): void {
    owner.lensStore.delete(runId);
  }

export async function contextLensAssemblerPrepareAssemblyState(owner: ContextLensAssemblerMethodOwner, params: {
    readonly run: Pick<Run, "run_id" | "workspace_id" | "run_mode" | "title">;
    readonly surfaceId: string | null;
    readonly displayName?: string;
  }): Promise<PreparedAssemblyState> {
    const taskSurface = await owner.dependencies.taskSurfaceBuilder.build({
      run: params.run,
      surfaceId: params.surfaceId,
      displayName: params.displayName
    });
    const strategy = owner.dependencies.taskSurfaceBuilder.resolveStrategy(taskSurface.surface_kind);
    const recallPolicy =
      owner.dependencies.recallService.buildDefaultPolicy?.(strategy, taskSurface.runtime_id) ?? null;
    const recallResult = await owner.dependencies.recallService.recall({
      taskSurface,
      workspaceId: params.run.workspace_id,
      strategy,
      runId: params.run.run_id,
      policyOverride: recallPolicy ?? undefined
    });
    const strictWinners = await owner.loadStrictWinners(params.run.workspace_id);
    const recalledMemories = await owner.loadRecalledMemories(recallResult.candidates);
    const activeOverrides = owner.dependencies.overrideService !== undefined
      ? await owner.dependencies.overrideService.getActiveFor(params.run.run_id)
      : owner.resolveMissingOverrideService(params.run.run_id, params.run.workspace_id);
    const lensEntries = owner.buildLensEntries(taskSurface, recallResult, strictWinners, recalledMemories, activeOverrides);
    const contextLens = ContextLensSchema.parse({
      runtime_id: owner.generateRuntimeId(),
      object_kind: ControlPlaneObjectKind.CONTEXT_LENS,
      task_surface_ref: taskSurface.runtime_id,
      expires_at: taskSurface.expires_at,
      derived_from: taskSurface.runtime_id,
      retention_policy: RetentionPolicy.SESSION_ONLY,
      lens_entries: lensEntries,
      not_a_priority_source: true
    });
    const workingProjection = owner.buildWorkingProjection(
      taskSurface,
      contextLens,
      recallResult,
      strictWinners,
      recalledMemories,
      recallPolicy?.runtime_id ?? null,
      activeOverrides
    );

    return {
      taskSurface,
      recallPolicy,
      recallResult,
      strictWinners,
      recalledMemories,
      activeOverrides,
      contextLens,
      workingProjection
    };
  }

export async function contextLensAssemblerApplyDegradation(owner: ContextLensAssemblerMethodOwner, params: DegradationApplicationParams): Promise<DegradationApplicationResult> {
    const tokensBeforeDegradation = params.workingProjection.total_token_estimate;
    const degradationResult = params.degradationPipeline.assess({
      contextLens: params.contextLens,
      workingProjection: params.workingProjection,
      budgetLimit: params.policyBudget,
      runId: params.run.run_id,
      workspaceId: params.run.workspace_id
    });

    let contextLens = params.contextLens;
    let workingProjection = params.workingProjection;
    let tokensAfterDegradation = degradationResult.tokensAfter;

    if (degradationResult.degraded) {
      contextLens = degradationResult.finalLens;
      workingProjection = owner.buildWorkingProjection(
        params.taskSurface,
        contextLens,
        params.recallResult,
        params.strictWinners,
        params.recalledMemories,
        params.recallPolicyRuntimeId,
        params.activeOverrides
      );
      tokensAfterDegradation = workingProjection.total_token_estimate;
      await owner.dependencies.eventLogRepo.append({
        event_type: BudgetEventType.SOUL_BUDGET_DEGRADED,
        entity_type: "context_lens",
        entity_id: contextLens.runtime_id,
        workspace_id: params.run.workspace_id,
        run_id: params.run.run_id,
        caused_by: "system",
        payload_json: SoulBudgetDegradedPayloadSchema.parse({
          run_id: params.run.run_id,
          workspace_id: params.run.workspace_id,
          lens_runtime_id: contextLens.runtime_id,
          steps_applied: degradationResult.stepsApplied.map((step) => step.kind),
          tokens_before: tokensBeforeDegradation,
          tokens_after: tokensAfterDegradation,
          budget_limit: params.policyBudget,
          still_over_budget: tokensAfterDegradation > params.policyBudget,
          occurred_at: params.occurredAt
        })
      });
    }

    const stillOverBudgetAfterDegradation = tokensAfterDegradation > params.policyBudget;
    if (stillOverBudgetAfterDegradation) {
      owner.warn("[ContextLensAssembler] budget remains over limit after degradation.", {
        runId: params.run.run_id,
        workspaceId: params.run.workspace_id,
        lensRuntimeId: contextLens.runtime_id,
        budgetLimit: params.policyBudget,
        tokensAfter: tokensAfterDegradation,
        degraded: degradationResult.degraded
      });
      if (owner.dependencies.bankruptcyService !== undefined) {
        await owner.dependencies.bankruptcyService.declare({
          runId: params.run.run_id,
          workspaceId: params.run.workspace_id,
          triggerKind: BankruptcyTriggerKind.TOKEN_OVERFLOW,
          triggerSummary: `Token estimate ${tokensAfterDegradation} exceeds budget ${params.policyBudget}`,
          taskSurfaceRef: params.taskSurface.runtime_id,
          taskSurfaceExpiresAt: params.taskSurface.expires_at,
          currentMode: params.runtimeMode,
          protectedConstraints: degradationResult.protectedObjectIds,
          droppedCandidates: degradationResult.droppedObjectIds,
          unresolvedConflicts: [],
          requiredActions: [BankruptcyAction.COMPRESS, BankruptcyAction.DEFER],
          tokensUsed: tokensAfterDegradation,
          maxTotalTokens: params.policyBudget
        });
      }
    }

    return {
      contextLens,
      workingProjection,
      degradationResult,
      tokensAfterDegradation,
      stillOverBudgetAfterDegradation
    };
  }

export async function contextLensAssemblerLoadStrictWinners(owner: ContextLensAssemblerMethodOwner, workspaceId: string): Promise<readonly Readonly<ClaimForm>[]> {
    const slots = await owner.dependencies.slotRepo.findByWorkspace(workspaceId);
    const winnerClaimIds = [...new Set(slots.flatMap((slot) => (slot.winner_claim_id === null ? [] : [slot.winner_claim_id])))];

    if (winnerClaimIds.length === 0) {
      return Object.freeze([]);
    }

    const claims = await owner.dependencies.claimRepo.findByIds(winnerClaimIds);
    const claimById = new Map(claims.map((claim) => [claim.object_id, claim] as const));

    return Object.freeze(
      winnerClaimIds.flatMap((claimId) => {
        const claim = claimById.get(claimId);
        return claim !== undefined && claim.enforcement_level === EnforcementLevel.STRICT ? [claim] : [];
      })
    );
  }
