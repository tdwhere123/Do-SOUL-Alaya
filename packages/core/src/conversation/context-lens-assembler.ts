import { randomUUID } from "node:crypto";
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
  type ClaimForm,
  type ContextLens,
  type MemoryEntry,
  type RuntimeMode as RuntimeModeValue,
  type Run,
  type SessionOverride
} from "@do-soul/alaya-protocol";

import type { RecallCandidate } from "../recall/recall-service.js";

import { ContextLensProjectionBuilder } from "./context-lens-projection-builder.js";
import {
  MAX_LENS_STORE_SIZE,
  type AssembleResult,
  type DegradationApplicationParams,
  type DegradationApplicationResult,
  type LensAssemblerDependencies,
  type LensAssemblerWarnPort,
  type PreparedAssemblyState
} from "./context-lens-assembler-ports.js";

export type {
  AssembleResult,
  LensAssemblerBankruptcyPort,
  LensAssemblerClaimRepoPort,
  LensAssemblerDependencies,
  LensAssemblerEventLogRepoPort,
  LensAssemblerMemoryRepoPort,
  LensAssemblerOverridePort,
  LensAssemblerRecallPort,
  LensAssemblerSlotRepoPort,
  LensAssemblerTaskSurfacePort,
  LensAssemblerWarnPort
} from "./context-lens-assembler-ports.js";

function defaultContextLensWarn(message: string, meta: Record<string, unknown>): void {
  process.emitWarning(message, {
    code: "ALAYA_CONTEXT_LENS_WARNING",
    detail: JSON.stringify(meta)
  });
}

export class ContextLensAssembler {
  public readonly lensStore = new Map<string, Readonly<ContextLens>>();

  public readonly generateRuntimeId: () => string;

  public readonly now: () => string;

  public readonly warn: LensAssemblerWarnPort;

  public hasWarnedMissingOverrideService = false;

  private readonly projectionBuilder: ContextLensProjectionBuilder;

  public constructor(public readonly dependencies: LensAssemblerDependencies) {
    this.generateRuntimeId = dependencies.generateRuntimeId ?? (() => randomUUID());
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.warn = dependencies.warn ?? defaultContextLensWarn;
    this.projectionBuilder = new ContextLensProjectionBuilder({
      generateRuntimeId: this.generateRuntimeId
    });
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
    await this.dependencies.eventLogRepo.append({
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
    const recalledMemories = await this.loadRecalledMemories(
      params.run.workspace_id,
      recallResult.candidates
    );
    const activeOverrides = this.dependencies.overrideService !== undefined
      ? await this.dependencies.overrideService.getActiveFor(params.run.run_id)
      : this.resolveMissingOverrideService(params.run.run_id, params.run.workspace_id);
    const lensEntries = this.projectionBuilder.buildLensEntries(taskSurface, recallResult, strictWinners, recalledMemories, activeOverrides);
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
    const workingProjection = this.projectionBuilder.buildWorkingProjection(
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
      workingProjection = this.projectionBuilder.buildWorkingProjection(
        params.taskSurface,
        contextLens,
        params.recallResult,
        params.strictWinners,
        params.recalledMemories,
        params.recallPolicyRuntimeId,
        params.activeOverrides
      );
      tokensAfterDegradation = workingProjection.total_token_estimate;
      await this.dependencies.eventLogRepo.append({
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

  private async loadStrictWinners(workspaceId: string): Promise<readonly Readonly<ClaimForm>[]> {
    const slots = await this.dependencies.slotRepo.findByWorkspace(workspaceId);
    const winnerClaimIds = [...new Set(slots.flatMap((slot) => (slot.winner_claim_id === null ? [] : [slot.winner_claim_id])))];

    if (winnerClaimIds.length === 0) {
      return Object.freeze([]);
    }

    const claims = await this.dependencies.claimRepo.findByIds(workspaceId, winnerClaimIds);
    const claimById = new Map(claims.map((claim) => [claim.object_id, claim] as const));

    return Object.freeze(
      winnerClaimIds.flatMap((claimId) => {
        const claim = claimById.get(claimId);
        return claim !== undefined && claim.enforcement_level === EnforcementLevel.STRICT ? [claim] : [];
      })
    );
  }

  private async loadRecalledMemories(
    workspaceId: string,
    candidates: readonly Readonly<RecallCandidate>[]
  ): Promise<ReadonlyMap<string, Readonly<MemoryEntry>>> {
    const objectIds = [...new Set(candidates.map((candidate) => candidate.object_id))];
    if (objectIds.length === 0) {
      return new Map();
    }

    if (this.dependencies.memoryRepo.findByIds !== undefined) {
      const memories = await this.dependencies.memoryRepo.findByIds(workspaceId, objectIds);
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
        const memory = await this.dependencies.memoryRepo.findById(objectId);
        return memory === null || memory.workspace_id !== workspaceId ? null : ([objectId, memory] as const);
      })
    );

    return new Map(entries.filter((entry): entry is readonly [string, Readonly<MemoryEntry>] => entry !== null));
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
