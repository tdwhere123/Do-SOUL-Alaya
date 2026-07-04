import type {
  RecallPolicy,
  SoulRecallHostContext,
  TaskObjectSurface
} from "@do-soul/alaya-protocol";
import type { NodeStrategy } from "@do-soul/alaya-core";

export type RecallBoundSideEffectMode = "production_mcp" | "benchmark";

type BoundRecallTimeFilter = Readonly<{
  readonly since?: string | null;
  readonly until?: string | null;
  readonly field?: "created_at" | "last_used_at";
}>;

export type BoundRecallInvokeParams = Readonly<{
  readonly taskSurface: Readonly<TaskObjectSurface>;
  readonly workspaceId: string;
  readonly strategy: NodeStrategy;
  readonly runId?: string | null;
  readonly policyOverride?: Readonly<RecallPolicy>;
  readonly timeFilter?: BoundRecallTimeFilter;
  readonly hostContext?: Readonly<SoulRecallHostContext>;
  readonly activeConstraintsCap?: number | null;
}>;

export type InvokeBoundRecallParams<TRecallResult> = Readonly<{
  readonly sideEffectMode: RecallBoundSideEffectMode;
  readonly recallService: {
    recall(params: BoundRecallInvokeParams): Promise<TRecallResult>;
  };
  readonly taskSurface: Readonly<TaskObjectSurface>;
  readonly workspaceId: string;
  readonly runId?: string | null;
  readonly policyOverride: Readonly<RecallPolicy>;
  readonly strategy?: NodeStrategy;
  readonly timeFilter?: BoundRecallTimeFilter;
  readonly hostContext?: Readonly<SoulRecallHostContext>;
  readonly activeConstraintsCap?: number | null;
}>;

// Recall scoring is identical across modes; sideEffectMode documents post-recall
// divergence (MCP delivery/plasticity/garden vs bench diagnostics-only).
export async function invokeBoundRecall<TRecallResult>(
  params: InvokeBoundRecallParams<TRecallResult>
): Promise<TRecallResult> {
  void params.sideEffectMode;
  return await params.recallService.recall({
    taskSurface: params.taskSurface,
    workspaceId: params.workspaceId,
    strategy: params.strategy ?? "chat",
    runId: params.runId,
    policyOverride: params.policyOverride,
    ...(params.timeFilter === undefined ? {} : { timeFilter: params.timeFilter }),
    ...(params.hostContext === undefined ? {} : { hostContext: params.hostContext }),
    activeConstraintsCap: params.activeConstraintsCap ?? null
  });
}
