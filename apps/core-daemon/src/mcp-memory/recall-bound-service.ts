import type { RecallPolicy, SoulMemorySearchRequest, TaskObjectSurface } from "@do-soul/alaya-protocol";
import { invokeBoundRecall } from "../recall/recall-bound-execution.js";
import type {
  RecallUsageHandlerDependencies,
  RecallUsageToolCallContext
} from "./recall-usage-handlers.js";

export async function runProductionBoundRecall(input: Readonly<{
  readonly deps: RecallUsageHandlerDependencies;
  readonly request: SoulMemorySearchRequest;
  readonly context: RecallUsageToolCallContext;
  readonly taskSurface: Readonly<TaskObjectSurface>;
  readonly policyOverride: RecallPolicy;
}>): Promise<Awaited<ReturnType<RecallUsageHandlerDependencies["recallService"]["recall"]>>> {
  return await invokeBoundRecall({
    sideEffectMode: "production_mcp",
    recallService: input.deps.recallService,
    taskSurface: input.taskSurface,
    workspaceId: input.context.workspaceId,
    runId: input.context.runId,
    strategy: "chat",
    policyOverride: input.policyOverride,
    timeFilter: buildRecallTimeFilter(input.request),
    hostContext: input.request.host_context,
    activeConstraintsCap: input.request.active_constraints_cap ?? null
  });
}

function buildRecallTimeFilter(request: SoulMemorySearchRequest) {
  if (
    request.since === undefined &&
    request.until === undefined &&
    request.time_field === undefined
  ) {
    return undefined;
  }
  return {
    since: request.since ?? null,
    until: request.until ?? null,
    field: request.time_field ?? "created_at"
  } as const;
}
