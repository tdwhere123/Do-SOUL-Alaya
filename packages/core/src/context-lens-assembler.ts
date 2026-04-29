import { randomUUID } from "node:crypto";
import {
  BankruptcyAction,
  BankruptcyTriggerKind,
  ControlPlaneObjectKind,
  ContextLensSchema,
  EnforcementLevel,
  ObjectKind,
  Phase3AEventType,
  Phase3CEventType,
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
import type { RecallCandidate, RecallResult } from "./recall-service.js";
import type { NodeStrategy } from "./task-surface-builder.js";
import { getNextRevision } from "./shared/event-utils.js";

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
}

export interface LensAssemblerEventLogRepoPort {
  append(entry: Omit<EventLogEntry, "event_id" | "created_at">): Promise<EventLogEntry>;
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

export class ContextLensAssembler {
  private readonly lensStore = new Map<string, Readonly<ContextLens>>();
  private readonly generateRuntimeId: () => string;
  private readonly now: () => string;
  private readonly warn: LensAssemblerWarnPort;
  private hasWarnedMissingOverrideService = false;

  public constructor(private readonly dependencies: LensAssemblerDependencies) {
    this.generateRuntimeId = dependencies.generateRuntimeId ?? (() => randomUUID());
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.warn = dependencies.warn ?? ((message, meta) => console.warn(message, meta));
  }

  public async assemble(params: {
    readonly run: Pick<Run, "run_id" | "workspace_id" | "run_mode" | "title">;
    readonly surfaceId: string | null;
    readonly displayName?: string;
    readonly runtimeMode?: RuntimeModeValue;
  }): Promise<AssembleResult> {
    const occurredAt = this.now();
    this.pruneLensStore(occurredAt);

    const prepared = await this.prepareAssemblyState(params);
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

    const degradationPipeline = this.dependencies.degradationPipeline;
    if (
      degradationPipeline !== undefined &&
      policyBudget !== null &&
      workingProjection.total_token_estimate > policyBudget
    ) {
      const degradationApplication = await this.applyDegradation({
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

    const revision = await getNextRevision(this.dependencies.eventLogRepo, "context_lens", contextLens.runtime_id);
    await this.dependencies.eventLogRepo.append({
      event_type: Phase3AEventType.SOUL_CONTEXT_LENS_ASSEMBLED,
      entity_type: "context_lens",
      entity_id: contextLens.runtime_id,
      workspace_id: params.run.workspace_id,
      run_id: params.run.run_id,
      caused_by: "system",
      revision,
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

    this.lensStore.delete(params.run.run_id);
    this.lensStore.set(params.run.run_id, contextLens);
    this.trimLensStore();

    return {
      contextLens,
      taskSurface,
      workingProjection
    };
  }

  public getLastLens(runId: string): Readonly<ContextLens> | null {
    this.pruneLensStore(this.now());
    return this.lensStore.get(runId) ?? null;
  }

  public clearLens(runId: string): void {
    this.lensStore.delete(runId);
  }

  private async prepareAssemblyState(params: {
    readonly run: Pick<Run, "run_id" | "workspace_id" | "run_mode" | "title">;
    readonly surfaceId: string | null;
    readonly displayName?: string;
  }): Promise<PreparedAssemblyState> {
    const taskSurface = await this.dependencies.taskSurfaceBuilder.build({
      run: params.run,
      surfaceId: params.surfaceId,
      displayName: params.displayName
    });
    const strategy = this.dependencies.taskSurfaceBuilder.resolveStrategy(taskSurface.surface_kind);
    const recallPolicy =
      this.dependencies.recallService.buildDefaultPolicy?.(strategy, taskSurface.runtime_id) ?? null;
    const recallResult = await this.dependencies.recallService.recall({
      taskSurface,
      workspaceId: params.run.workspace_id,
      strategy,
      runId: params.run.run_id,
      policyOverride: recallPolicy ?? undefined
    });
    const strictWinners = await this.loadStrictWinners(params.run.workspace_id);
    const recalledMemories = await this.loadRecalledMemories(recallResult.candidates);
    const activeOverrides = this.dependencies.overrideService !== undefined
      ? await this.dependencies.overrideService.getActiveFor(params.run.run_id)
      : this.resolveMissingOverrideService(params.run.run_id, params.run.workspace_id);
    const lensEntries = this.buildLensEntries(taskSurface, recallResult, strictWinners, recalledMemories, activeOverrides);
    const contextLens = ContextLensSchema.parse({
      runtime_id: this.generateRuntimeId(),
      object_kind: ControlPlaneObjectKind.CONTEXT_LENS,
      task_surface_ref: taskSurface.runtime_id,
      expires_at: taskSurface.expires_at,
      derived_from: taskSurface.runtime_id,
      retention_policy: RetentionPolicy.SESSION_ONLY,
      lens_entries: lensEntries,
      not_a_priority_source: true
    });
    const workingProjection = this.buildWorkingProjection(
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

  private async applyDegradation(params: DegradationApplicationParams): Promise<DegradationApplicationResult> {
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
      workingProjection = this.buildWorkingProjection(
        params.taskSurface,
        contextLens,
        params.recallResult,
        params.strictWinners,
        params.recalledMemories,
        params.recallPolicyRuntimeId,
        params.activeOverrides
      );
      tokensAfterDegradation = workingProjection.total_token_estimate;

      const degradedRevision = await getNextRevision(
        this.dependencies.eventLogRepo,
        "context_lens",
        contextLens.runtime_id
      );
      const degradedEvent = await this.dependencies.eventLogRepo.append({
        event_type: Phase3CEventType.SOUL_BUDGET_DEGRADED,
        entity_type: "context_lens",
        entity_id: contextLens.runtime_id,
        workspace_id: params.run.workspace_id,
        run_id: params.run.run_id,
        caused_by: "system",
        revision: degradedRevision,
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
      this.warn("[ContextLensAssembler] budget remains over limit after degradation.", {
        runId: params.run.run_id,
        workspaceId: params.run.workspace_id,
        lensRuntimeId: contextLens.runtime_id,
        budgetLimit: params.policyBudget,
        tokensAfter: tokensAfterDegradation,
        degraded: degradationResult.degraded
      });
      if (this.dependencies.bankruptcyService !== undefined) {
        await this.dependencies.bankruptcyService.declare({
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
          requiredActions: [BankruptcyAction.COMPRESS, BankruptcyAction.DEFER]
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

  private async loadStrictWinners(workspaceId: string): Promise<readonly Readonly<ClaimForm>[]> {
    const slots = await this.dependencies.slotRepo.findByWorkspace(workspaceId);
    const winnerClaimIds = [...new Set(slots.flatMap((slot) => (slot.winner_claim_id === null ? [] : [slot.winner_claim_id])))];

    if (winnerClaimIds.length === 0) {
      return Object.freeze([]);
    }

    const claims = await this.dependencies.claimRepo.findByIds(winnerClaimIds);
    const claimById = new Map(claims.map((claim) => [claim.object_id, claim] as const));

    return Object.freeze(
      winnerClaimIds.flatMap((claimId) => {
        const claim = claimById.get(claimId);
        return claim !== undefined && claim.enforcement_level === EnforcementLevel.STRICT ? [claim] : [];
      })
    );
  }

  private async loadRecalledMemories(
    candidates: readonly Readonly<RecallCandidate>[]
  ): Promise<ReadonlyMap<string, Readonly<MemoryEntry>>> {
    const entries = await Promise.all(
      [...new Set(candidates.map((candidate) => candidate.object_id))].map(async (objectId) => {
        const memory = await this.dependencies.memoryRepo.findById(objectId);
        return memory === null ? null : ([objectId, memory] as const);
      })
    );

    return new Map(entries.filter((entry): entry is readonly [string, Readonly<MemoryEntry>] => entry !== null));
  }

  private buildLensEntries(
    taskSurface: Readonly<TaskObjectSurface>,
    recallResult: RecallResult,
    strictWinners: readonly Readonly<ClaimForm>[],
    recalledMemories: ReadonlyMap<string, Readonly<MemoryEntry>>,
    activeOverrides: readonly Readonly<SessionOverride>[]
  ): readonly Readonly<ContextLensEntry>[] {
    const overrideEntries = this.buildOverrideEntries(activeOverrides);
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

  private buildOverrideEntries(
    activeOverrides: readonly Readonly<SessionOverride>[]
  ): readonly Readonly<ContextLensEntry>[] {
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

  private buildWorkingProjection(
    taskSurface: Readonly<TaskObjectSurface>,
    contextLens: Readonly<ContextLens>,
    recallResult: RecallResult,
    strictWinners: readonly Readonly<ClaimForm>[],
    recalledMemories: ReadonlyMap<string, Readonly<MemoryEntry>>,
    recallPolicyRef: string | null,
    activeOverrides: readonly Readonly<SessionOverride>[]
  ): Readonly<WorkingProjection> {
    let taskSurfaceEntryIndex = 0;
    const strictWinnerMap = new Map(strictWinners.map((claim) => [claim.object_id, claim] as const));
    const recallCandidateMap = new Map(recallResult.candidates.map((candidate) => [candidate.object_id, candidate] as const));
    const overrideMap = new Map(activeOverrides.map((override) => [override.runtime_id, override] as const));

    const entries = contextLens.lens_entries.map((entry) => {
      const contentSnapshot = this.resolveContentSnapshot(
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
        token_estimate: estimateTokens(contentSnapshot)
      };
    });
    const totalTokenEstimate = entries.reduce((sum, entry) => sum + entry.token_estimate, 0);

    return WorkingProjectionSchema.parse({
      runtime_id: this.generateRuntimeId(),
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

  private resolveContentSnapshot(
    entry: Readonly<ContextLensEntry>,
    taskSurface: Readonly<TaskObjectSurface>,
    taskSurfaceEntryIndex: number,
    strictWinnerMap: ReadonlyMap<string, Readonly<ClaimForm>>,
    recallCandidateMap: ReadonlyMap<string, Readonly<RecallCandidate>>,
    recalledMemories: ReadonlyMap<string, Readonly<MemoryEntry>>,
    overrideMap: ReadonlyMap<string, Readonly<SessionOverride>>
  ): string {
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

  private pruneLensStore(referenceTime: string): void {
    const referenceMs = Date.parse(referenceTime);

    if (!Number.isFinite(referenceMs)) {
      return;
    }

    for (const [runId, lens] of this.lensStore) {
      const expiresAtMs = lens.expires_at === null ? Number.NaN : Date.parse(lens.expires_at);

      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= referenceMs) {
        this.lensStore.delete(runId);
      }
    }
  }

  private trimLensStore(): void {
    while (this.lensStore.size > MAX_LENS_STORE_SIZE) {
      const oldestRunId = this.lensStore.keys().next().value;

      if (oldestRunId === undefined) {
        return;
      }

      this.lensStore.delete(oldestRunId);
    }
  }

  private resolveMissingOverrideService(runId: string, workspaceId: string): readonly Readonly<SessionOverride>[] {
    if (!this.hasWarnedMissingOverrideService) {
      this.hasWarnedMissingOverrideService = true;
      this.warn("[ContextLensAssembler] overrideService missing; session overrides will not be projected.", {
        runId,
        workspaceId
      });
    }

    return Object.freeze([]);
  }
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

function estimateTokens(value: string): number {
  return Math.ceil(value.length / 4);
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
