import type { ContextLens, WorkingProjection } from "./context-lens.js";

export interface LensDegradationStepRecord {
  readonly kind: string;
  readonly object_ids_affected: readonly string[];
  readonly tokens_freed: number;
}

export interface LensDegradationResult {
  readonly degraded: boolean;
  readonly finalLens: Readonly<ContextLens>;
  readonly stepsApplied: readonly LensDegradationStepRecord[];
  readonly tokensAfter: number;
  readonly stillOverBudget: boolean;
  readonly protectedObjectIds: readonly string[];
  // Only entries removed from the lens, used by 3C-2 droppedCandidates.
  readonly droppedObjectIds: readonly string[];
}

export interface LensAssemblerDegradationPort {
  assess(params: {
    readonly contextLens: Readonly<ContextLens>;
    readonly workingProjection: Readonly<WorkingProjection>;
    readonly budgetLimit: number;
    readonly runId: string;
    readonly workspaceId: string;
  }): LensDegradationResult;
}
