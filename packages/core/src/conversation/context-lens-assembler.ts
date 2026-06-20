import { randomUUID } from "node:crypto";
import {
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

import { contextLensAssemblerAssemble, contextLensAssemblerGetLastLens, contextLensAssemblerClearLens, contextLensAssemblerPrepareAssemblyState, contextLensAssemblerApplyDegradation, contextLensAssemblerLoadStrictWinners } from "./context-lens-assembler-methods-1.js";
import { contextLensAssemblerLoadRecalledMemories, contextLensAssemblerBuildLensEntries, contextLensAssemblerBuildOverrideEntries, contextLensAssemblerBuildWorkingProjection, contextLensAssemblerResolveContentSnapshot, contextLensAssemblerPruneLensStore, contextLensAssemblerTrimLensStore, contextLensAssemblerResolveMissingOverrideService } from "./context-lens-assembler-methods-2.js";

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

export class ContextLensAssembler {
public readonly lensStore = new Map<string, Readonly<ContextLens>>();

public readonly generateRuntimeId: () => string;

public readonly now: () => string;

public readonly warn: LensAssemblerWarnPort;

public hasWarnedMissingOverrideService = false;

public constructor(public readonly dependencies: LensAssemblerDependencies) {
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
    return contextLensAssemblerAssemble(this, params);
  }

  public getLastLens(runId: string): Readonly<ContextLens> | null {
    return contextLensAssemblerGetLastLens(this, runId);
  }

  public clearLens(runId: string): void {
    return contextLensAssemblerClearLens(this, runId);
  }

  private async prepareAssemblyState(params: {
    readonly run: Pick<Run, "run_id" | "workspace_id" | "run_mode" | "title">;
    readonly surfaceId: string | null;
    readonly displayName?: string;
  }): Promise<PreparedAssemblyState> {
    return contextLensAssemblerPrepareAssemblyState(this, params);
  }

  private async applyDegradation(params: DegradationApplicationParams): Promise<DegradationApplicationResult> {
    return contextLensAssemblerApplyDegradation(this, params);
  }

  private async loadStrictWinners(workspaceId: string): Promise<readonly Readonly<ClaimForm>[]> {
    return contextLensAssemblerLoadStrictWinners(this, workspaceId);
  }

  private async loadRecalledMemories(candidates: readonly Readonly<RecallCandidate>[]): Promise<ReadonlyMap<string, Readonly<MemoryEntry>>> {
    return contextLensAssemblerLoadRecalledMemories(this, candidates);
  }

  private buildLensEntries(taskSurface: Readonly<TaskObjectSurface>, recallResult: RecallResult, strictWinners: readonly Readonly<ClaimForm>[], recalledMemories: ReadonlyMap<string, Readonly<MemoryEntry>>, activeOverrides: readonly Readonly<SessionOverride>[]): readonly Readonly<ContextLensEntry>[] {
    return contextLensAssemblerBuildLensEntries(this, taskSurface, recallResult, strictWinners, recalledMemories, activeOverrides);
  }

  private buildOverrideEntries(activeOverrides: readonly Readonly<SessionOverride>[]): readonly Readonly<ContextLensEntry>[] {
    return contextLensAssemblerBuildOverrideEntries(this, activeOverrides);
  }

  private buildWorkingProjection(taskSurface: Readonly<TaskObjectSurface>, contextLens: Readonly<ContextLens>, recallResult: RecallResult, strictWinners: readonly Readonly<ClaimForm>[], recalledMemories: ReadonlyMap<string, Readonly<MemoryEntry>>, recallPolicyRef: string | null, activeOverrides: readonly Readonly<SessionOverride>[], tokenEstimator: TokenEstimator = makeTokenEstimator()): Readonly<WorkingProjection> {
    return contextLensAssemblerBuildWorkingProjection(this, taskSurface, contextLens, recallResult, strictWinners, recalledMemories, recallPolicyRef, activeOverrides, tokenEstimator);
  }

  private resolveContentSnapshot(entry: Readonly<ContextLensEntry>, taskSurface: Readonly<TaskObjectSurface>, taskSurfaceEntryIndex: number, strictWinnerMap: ReadonlyMap<string, Readonly<ClaimForm>>, recallCandidateMap: ReadonlyMap<string, Readonly<RecallCandidate>>, recalledMemories: ReadonlyMap<string, Readonly<MemoryEntry>>, overrideMap: ReadonlyMap<string, Readonly<SessionOverride>>): string {
    return contextLensAssemblerResolveContentSnapshot(this, entry, taskSurface, taskSurfaceEntryIndex, strictWinnerMap, recallCandidateMap, recalledMemories, overrideMap);
  }

  private pruneLensStore(referenceTime: string): void {
    return contextLensAssemblerPruneLensStore(this, referenceTime);
  }

  private trimLensStore(): void {
    return contextLensAssemblerTrimLensStore(this);
  }

  private resolveMissingOverrideService(runId: string, workspaceId: string): readonly Readonly<SessionOverride>[] {
    return contextLensAssemblerResolveMissingOverrideService(this, runId, workspaceId);
  }
}
