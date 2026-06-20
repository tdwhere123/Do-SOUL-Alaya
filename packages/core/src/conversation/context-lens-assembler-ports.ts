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
import type { NodeStrategy } from "./task-surface-builder.js";

export const MAX_LENS_STORE_SIZE = 200;

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

export interface DegradationApplicationResult {
  readonly contextLens: Readonly<ContextLens>;
  readonly workingProjection: Readonly<WorkingProjection>;
  readonly degradationResult: LensDegradationResult;
  readonly tokensAfterDegradation: number;
  readonly stillOverBudgetAfterDegradation: boolean;
}

export interface DegradationApplicationParams {
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

export interface PreparedAssemblyState {
  readonly taskSurface: Readonly<TaskObjectSurface>;
  readonly recallPolicy: Readonly<RecallPolicy> | null;
  readonly recallResult: RecallResult;
  readonly strictWinners: readonly Readonly<ClaimForm>[];
  readonly recalledMemories: ReadonlyMap<string, Readonly<MemoryEntry>>;
  readonly activeOverrides: readonly Readonly<SessionOverride>[];
  readonly contextLens: Readonly<ContextLens>;
  readonly workingProjection: Readonly<WorkingProjection>;
}

export function createLensEntry(
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

export function compareRecallCandidates(left: Readonly<RecallCandidate>, right: Readonly<RecallCandidate>): number {
  const activationDelta = right.activation_score - left.activation_score;
  if (activationDelta !== 0) {
    return activationDelta;
  }

  return left.object_id.localeCompare(right.object_id);
}

const EXCERPT_CONTENT_RATIO = 0.35;

export function createExcerptContent(content: string): string {
  const targetLength = Math.max(1, Math.ceil(content.length * EXCERPT_CONTENT_RATIO));

  if (content.length <= targetLength) {
    return content;
  }

  const sliceLength = Math.max(1, targetLength - 3);
  return `${content.slice(0, sliceLength).trimEnd()}...`;
}
